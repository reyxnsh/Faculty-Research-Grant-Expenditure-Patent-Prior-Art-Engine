-- Up Migration
-- Lock Acquisition Hierarchy Documentation:
-- To prevent deadlocks, all operations adhere to a strict hierarchical locking order:
--   Level 1: expenditure row (locked first via SELECT FOR UPDATE in approval/rejection workflows)
--   Level 2: grant_account row (locked next via FOR UPDATE OF ga in fn_maintain_expenditure_balance)
--   Level 3: grant_record row (locked only in fn_check_grant_budget_ceiling during account allocation changes)
-- No workflow locks in reverse order (e.g. grant_account then expenditure), eliminating lock inversion deadlocks.

-- 1. Grant Account Budget Allocation Ceiling Guard
CREATE OR REPLACE FUNCTION fn_check_grant_budget_ceiling()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_total_grant_budget NUMERIC(14, 2);
    v_current_allocated   NUMERIC(14, 2);
BEGIN
    -- Lock parent grant row to serialize concurrent allocations
    SELECT total_budget INTO v_total_grant_budget
    FROM grant_record
    WHERE grant_id = NEW.grant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target grant with ID % does not exist', NEW.grant_id;
    END IF;

    -- Sum allocated budgets excluding the current record if updating
    SELECT COALESCE(SUM(budget_allocated), 0)
    INTO v_current_allocated
    FROM grant_account
    WHERE grant_id = NEW.grant_id
      AND account_id <> COALESCE(NEW.account_id, -1);

    IF (v_current_allocated + NEW.budget_allocated) > v_total_grant_budget THEN
        RAISE EXCEPTION 'Allocation violation: Total allocated (%) exceeds sanctioned grant budget (%)',
            ROUND(v_current_allocated + NEW.budget_allocated, 2), ROUND(v_total_grant_budget, 2);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_grant_budget_ceiling
BEFORE INSERT OR UPDATE OF budget_allocated ON grant_account
FOR EACH ROW
EXECUTE FUNCTION fn_check_grant_budget_ceiling();

-- 2. Grant Total Budget Reduction Guard
CREATE OR REPLACE FUNCTION fn_check_grant_total_budget_decrease()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_total_allocated NUMERIC(14, 2);
BEGIN
    IF NEW.total_budget < OLD.total_budget THEN
        SELECT COALESCE(SUM(budget_allocated), 0)
        INTO v_total_allocated
        FROM grant_account
        WHERE grant_id = NEW.grant_id;

        IF NEW.total_budget < v_total_allocated THEN
            RAISE EXCEPTION 'Cannot reduce total budget to %: Allocated accounts sum to %',
                ROUND(NEW.total_budget, 2), ROUND(v_total_allocated, 2);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_grant_total_budget_decrease
BEFORE UPDATE OF total_budget ON grant_record
FOR EACH ROW
EXECUTE FUNCTION fn_check_grant_total_budget_decrease();

-- 3. Account Balance Initialization & Modification Guard
CREATE OR REPLACE FUNCTION fn_grant_account_balance_guard()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_delta NUMERIC(14, 2);
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Initialize current_balance to budget_allocated regardless of supplied value
        NEW.current_balance := NEW.budget_allocated;
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Block changing parent grant_id
        IF NEW.grant_id <> OLD.grant_id THEN
            RAISE EXCEPTION 'grant_id on account % cannot be changed', OLD.account_id;
        END IF;

        -- Block direct changes to current_balance from application queries
        IF NEW.current_balance <> OLD.current_balance AND pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'Direct update of current_balance on account % is prohibited', OLD.account_id;
        END IF;

        -- If budget_allocated changed, adjust current_balance by the same delta
        IF NEW.budget_allocated <> OLD.budget_allocated THEN
            v_delta := NEW.budget_allocated - OLD.budget_allocated;
            IF (OLD.current_balance + v_delta) < 0 THEN
                RAISE EXCEPTION 'Budget reduction of % would cause negative balance on account % (current balance %)',
                    ROUND(ABS(v_delta), 2), OLD.account_id, ROUND(OLD.current_balance, 2);
            END IF;
            NEW.current_balance := OLD.current_balance + v_delta;
        END IF;

        RETURN NEW;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_grant_account_balance_guard
BEFORE INSERT OR UPDATE ON grant_account
FOR EACH ROW
EXECUTE FUNCTION fn_grant_account_balance_guard();

-- 4. Expenditure Pre-Submission Validation Guard
CREATE OR REPLACE FUNCTION fn_validate_expenditure_submission()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_grant_status      VARCHAR(20);
    v_grant_start       DATE;
    v_grant_end         DATE;
    v_pi_faculty_id     INT;
    v_grant_code        VARCHAR(50);
BEGIN
    SELECT g.status, g.start_date, g.end_date, g.pi_faculty_id, g.grant_code
    INTO v_grant_status, v_grant_start, v_grant_end, v_pi_faculty_id, v_grant_code
    FROM grant_account a
    JOIN grant_record g ON a.grant_id = g.grant_id
    WHERE a.account_id = NEW.account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid account ID %: Parent grant account not found', NEW.account_id;
    END IF;

    IF v_grant_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Expenditure rejected: Grant % is currently % (only ACTIVE grants accept expenses)',
            v_grant_code, v_grant_status;
    END IF;

    IF NEW.transaction_date IS NULL OR NEW.transaction_date < v_grant_start OR NEW.transaction_date > v_grant_end THEN
        RAISE EXCEPTION 'Expenditure rejected: Transaction date (%) falls outside grant active window (% to %)',
            NEW.transaction_date, v_grant_start, v_grant_end;
    END IF;

    IF NEW.submitted_by <> v_pi_faculty_id THEN
        RAISE EXCEPTION 'Expenditure rejected: Submitting faculty ID % is not the Principal Investigator for grant %',
            NEW.submitted_by, v_grant_code;
    END IF;

    -- Enforce initial state on submission
    IF NEW.status <> 'PENDING' OR NEW.approved_by IS NOT NULL OR NEW.decision_date IS NOT NULL OR NEW.rejection_reason IS NOT NULL THEN
        RAISE EXCEPTION 'New expenditure must be submitted with status PENDING and NULL approval fields';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_expenditure_submission
BEFORE INSERT ON expenditure
FOR EACH ROW
EXECUTE FUNCTION fn_validate_expenditure_submission();

-- 5. Expenditure State Transition & Immutability Guard
CREATE OR REPLACE FUNCTION fn_validate_expenditure_transition()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_approver RECORD;
BEGIN
    -- account_id and submitted_by are strictly immutable
    IF NEW.account_id <> OLD.account_id THEN
        RAISE EXCEPTION 'account_id on expenditure % cannot be changed', OLD.transaction_id;
    END IF;

    IF NEW.submitted_by <> OLD.submitted_by THEN
        RAISE EXCEPTION 'submitted_by on expenditure % cannot be changed', OLD.transaction_id;
    END IF;

    -- If status is unchanged and the expenditure is already decided, freeze all business fields
    IF OLD.status = NEW.status AND OLD.status <> 'PENDING' THEN
        IF NEW.amount <> OLD.amount OR 
           NEW.approved_by IS DISTINCT FROM OLD.approved_by OR 
           NEW.decision_date IS DISTINCT FROM OLD.decision_date OR 
           NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason OR 
           NEW.description <> OLD.description THEN
            RAISE EXCEPTION 'Expenditure % is already % and cannot be modified', OLD.transaction_id, OLD.status;
        END IF;
    END IF;

    -- amount can only be edited while PENDING
    IF NEW.amount <> OLD.amount AND OLD.status <> 'PENDING' THEN
        RAISE EXCEPTION 'Amount on expenditure % cannot be modified once %', OLD.transaction_id, OLD.status;
    END IF;

    -- Enforce legal status transitions and verify admin approver
    IF OLD.status <> NEW.status THEN
        IF (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED')) OR
           (OLD.status = 'APPROVED' AND NEW.status = 'REJECTED') THEN
            NULL; -- Allowed
        ELSE
            RAISE EXCEPTION 'Illegal status transition for expenditure %: cannot change from % to %',
                OLD.transaction_id, OLD.status, NEW.status;
        END IF;

        -- Approver must be an active ADMIN user
        SELECT is_active, role, faculty_id INTO v_approver FROM users WHERE user_id = NEW.approved_by;
        IF NOT FOUND OR v_approver.role <> 'ADMIN' OR NOT v_approver.is_active THEN
            RAISE EXCEPTION 'Approved_by user % must be an active ADMIN', NEW.approved_by;
        END IF;

        -- Separation of duties: approver cannot decide their own expenditure
        IF v_approver.faculty_id IS NOT NULL AND v_approver.faculty_id = OLD.submitted_by THEN
            RAISE EXCEPTION 'Separation of duties violation: an approver cannot decide their own expenditure';
        END IF;
    END IF;

    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_expenditure_transition
BEFORE UPDATE ON expenditure
FOR EACH ROW
EXECUTE FUNCTION fn_validate_expenditure_transition();

-- 6. Automated Balance Maintenance on Status Change
CREATE OR REPLACE FUNCTION fn_maintain_expenditure_balance()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_grant_status VARCHAR(20);
    v_current_bal  NUMERIC(14, 2);
BEGIN
    IF OLD.status = 'PENDING' AND NEW.status = 'APPROVED' THEN
        -- Lock account row and verify active grant
        SELECT gr.status, ga.current_balance
        INTO v_grant_status, v_current_bal
        FROM grant_account ga
        JOIN grant_record gr ON ga.grant_id = gr.grant_id
        WHERE ga.account_id = NEW.account_id
        FOR UPDATE OF ga;

        IF v_grant_status <> 'ACTIVE' THEN
            RAISE EXCEPTION 'Cannot approve expenditure %: Associated grant is %', NEW.transaction_id, v_grant_status;
        END IF;

        IF v_current_bal < NEW.amount THEN
            RAISE EXCEPTION 'Insufficient balance: Account % has %, requested %',
                NEW.account_id, ROUND(v_current_bal, 2), ROUND(NEW.amount, 2);
        END IF;

        -- Deduct balance
        UPDATE grant_account
        SET current_balance = current_balance - NEW.amount
        WHERE account_id = NEW.account_id;

    ELSIF OLD.status = 'APPROVED' AND NEW.status = 'REJECTED' THEN
        -- Restore funds on rejection / reversion
        UPDATE grant_account
        SET current_balance = current_balance + OLD.amount
        WHERE account_id = NEW.account_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_maintain_expenditure_balance
AFTER UPDATE OF status ON expenditure
FOR EACH ROW
EXECUTE FUNCTION fn_maintain_expenditure_balance();

-- 7. Automated Audit Logging
CREATE OR REPLACE FUNCTION fn_audit_expenditure_lifecycle()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id INT;
BEGIN
    IF (TG_OP = 'INSERT') THEN
        -- Look up user ID of the submitting faculty member
        SELECT user_id INTO v_user_id
        FROM users
        WHERE faculty_id = NEW.submitted_by;

        INSERT INTO audit_log (
            entity_type, entity_id, action, old_state, new_state, changed_by, remarks
        ) VALUES (
            'EXPENDITURE',
            NEW.transaction_id,
            'CREATED',
            NULL,
            jsonb_build_object(
                'amount', NEW.amount,
                'status', NEW.status,
                'account_id', NEW.account_id,
                'submitted_by', NEW.submitted_by
            ),
            v_user_id,
            'Expenditure claim initiated in PENDING status'
        );
    ELSIF (TG_OP = 'UPDATE' AND (OLD.status <> NEW.status OR OLD.amount <> NEW.amount)) THEN
        INSERT INTO audit_log (
            entity_type, entity_id, action, old_state, new_state, changed_by, remarks
        ) VALUES (
            'EXPENDITURE',
            NEW.transaction_id,
            CASE WHEN OLD.status <> NEW.status THEN 'STATUS_CHANGE_' || NEW.status ELSE 'AMOUNT_UPDATED' END,
            jsonb_build_object(
                'status', OLD.status, 
                'amount', OLD.amount,
                'approved_by', OLD.approved_by,
                'decision_date', OLD.decision_date
            ),
            jsonb_build_object(
                'status', NEW.status, 
                'amount', NEW.amount,
                'approved_by', NEW.approved_by,
                'decision_date', NEW.decision_date
            ),
            NEW.approved_by,
            COALESCE(NEW.rejection_reason, 'Status changed from ' || OLD.status || ' to ' || NEW.status)
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_expenditure_lifecycle
AFTER INSERT OR UPDATE ON expenditure
FOR EACH ROW
EXECUTE FUNCTION fn_audit_expenditure_lifecycle();

-- 8. Audit Log Immutability Guard
CREATE OR REPLACE FUNCTION fn_audit_log_immutable()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: updates, deletes, and truncates are prohibited';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION fn_audit_log_immutable();

CREATE TRIGGER trg_audit_log_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT
EXECUTE FUNCTION fn_audit_log_immutable();

-- 9. Full-Text Search Vector Synchronization
CREATE OR REPLACE FUNCTION fn_sync_ip_tsvector()
RETURNS TRIGGER
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.tsv := setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
               setweight(to_tsvector('english', COALESCE(NEW.abstract, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_ip_tsvector
BEFORE INSERT OR UPDATE OF title, abstract ON intellectual_property
FOR EACH ROW
EXECUTE FUNCTION fn_sync_ip_tsvector();

-- Down Migration
DROP TRIGGER IF EXISTS trg_sync_ip_tsvector ON intellectual_property;
DROP FUNCTION IF EXISTS fn_sync_ip_tsvector();

DROP TRIGGER IF EXISTS trg_audit_log_truncate ON audit_log;
DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
DROP FUNCTION IF EXISTS fn_audit_log_immutable();

DROP TRIGGER IF EXISTS trg_audit_expenditure_lifecycle ON expenditure;
DROP FUNCTION IF EXISTS fn_audit_expenditure_lifecycle();

DROP TRIGGER IF EXISTS trg_maintain_expenditure_balance ON expenditure;
DROP FUNCTION IF EXISTS fn_maintain_expenditure_balance();

DROP TRIGGER IF EXISTS trg_validate_expenditure_transition ON expenditure;
DROP FUNCTION IF EXISTS fn_validate_expenditure_transition();

DROP TRIGGER IF EXISTS trg_validate_expenditure_submission ON expenditure;
DROP FUNCTION IF EXISTS fn_validate_expenditure_submission();

DROP TRIGGER IF EXISTS trg_grant_account_balance_guard ON grant_account;
DROP FUNCTION IF EXISTS fn_grant_account_balance_guard();

DROP TRIGGER IF EXISTS trg_check_grant_total_budget_decrease ON grant_record;
DROP FUNCTION IF EXISTS fn_check_grant_total_budget_decrease();

DROP TRIGGER IF EXISTS trg_check_grant_budget_ceiling ON grant_account;
DROP FUNCTION IF EXISTS fn_check_grant_budget_ceiling();
