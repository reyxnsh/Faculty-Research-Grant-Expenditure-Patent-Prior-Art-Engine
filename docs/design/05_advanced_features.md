# Advanced Database Features Design

This document details the advanced database features implemented in PostgreSQL 16 to guarantee data consistency, automate business rules, accelerate analytical queries, and power search workflows.

---

## 1. Triggers & Automated Business Rule Enforcement

By embedding domain validation directly into database triggers, the database acts as the single source of truth, preventing invalid states even if application layers or API calls are bypassed.

### 1.1 Trigger 1: Grant Account Budget Allocation Ceiling Guard
- **Purpose**: Enforces that the sum of `budget_allocated` across all accounts of a grant never exceeds the grant's `total_budget`.
- **Target Table**: `grant_account`
- **Timing**: `BEFORE INSERT OR UPDATE OF budget_allocated ON grant_account`
- **Concurrency Protection**: Locks the parent `grant_record` row using `SELECT ... FOR UPDATE` before summing, preventing concurrent account allocations from exceeding the budget.

```sql
CREATE OR REPLACE FUNCTION fn_check_grant_budget_ceiling()
RETURNS TRIGGER AS $$
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
```

---

### 1.2 Trigger 2: Grant Total Budget Reduction Guard
- **Purpose**: Prevents administrators from reducing `grant_record.total_budget` below the sum of already allocated account budgets.
- **Target Table**: `grant_record`
- **Timing**: `BEFORE UPDATE OF total_budget ON grant_record`

```sql
CREATE OR REPLACE FUNCTION fn_check_grant_total_budget_decrease()
RETURNS TRIGGER AS $$
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
```

---

### 1.3 Trigger 3: Account Balance Initialization & Modification Guard
- **Purpose**: 
  1. On account creation (`INSERT`), automatically sets `current_balance = budget_allocated` (ignoring any user-supplied balance).
  2. On allocation updates (`UPDATE OF budget_allocated`), adjusts `current_balance` by the same delta and raises an error if the new balance would become negative.
  3. Rejects direct updates to `current_balance` unless the update comes from inside another trigger (`pg_trigger_depth() > 1`).
- **Target Table**: `grant_account`
- **Timing**: `BEFORE INSERT OR UPDATE ON grant_account`

```sql
CREATE OR REPLACE FUNCTION fn_grant_account_balance_guard()
RETURNS TRIGGER AS $$
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
```

---

### 1.4 Trigger 4: Expenditure Pre-Submission Validation Guard
- **Purpose**: Validates expenditure submissions before insertion:
  1. The parent grant must have an `ACTIVE` status.
  2. The `transaction_date` must fall within the grant's `start_date` and `end_date`.
  3. The submitter (`submitted_by`) must be the designated Principal Investigator of the grant.
- **Target Table**: `expenditure`
- **Timing**: `BEFORE INSERT ON expenditure`

```sql
CREATE OR REPLACE FUNCTION fn_validate_expenditure_submission()
RETURNS TRIGGER AS $$
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

    IF NEW.transaction_date < v_grant_start OR NEW.transaction_date > v_grant_end THEN
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
```

---

### 1.5 Trigger 5: Expenditure State Transition & Immutability Guard
- **Purpose**:
  1. Guarantees that `account_id` and `submitted_by` cannot be changed after submission.
  2. Guarantees that `amount` can only be changed while the expenditure is `PENDING`.
  3. Freezes decided rows: if `OLD.status = NEW.status` and the expenditure is already decided (`APPROVED` or `REJECTED`), rejects any change to `amount`, `approved_by`, `decision_date`, `rejection_reason`, or `description`.
  4. Enforces legal status transitions: `PENDING -> APPROVED`, `PENDING -> REJECTED`, and `APPROVED -> REJECTED` (reversion). All other transitions raise an exception.
  5. Verifies that when an expenditure transitions to `APPROVED` or `REJECTED`, `NEW.approved_by` corresponds to an active user with the `ADMIN` role.
- **Target Table**: `expenditure`
- **Timing**: `BEFORE UPDATE ON expenditure`

```sql
CREATE OR REPLACE FUNCTION fn_validate_expenditure_transition()
RETURNS TRIGGER AS $$
DECLARE
    v_approver_role VARCHAR(20);
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
        IF OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED') THEN
            NULL; -- Allowed
        ELSIF OLD.status = 'APPROVED' AND NEW.status = 'REJECTED' THEN
            NULL; -- Allowed (reversion)
        ELSE
            RAISE EXCEPTION 'Illegal status transition for expenditure %: cannot change from % to %',
                OLD.transaction_id, OLD.status, NEW.status;
        END IF;

        -- Approver must be an active ADMIN
        SELECT role INTO v_approver_role
        FROM users
        WHERE user_id = NEW.approved_by AND is_active = TRUE;

        IF v_approver_role IS NULL OR v_approver_role <> 'ADMIN' THEN
            RAISE EXCEPTION 'Authorization failure: Approver (user ID %) must be an active ADMIN', NEW.approved_by;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_expenditure_transition
BEFORE UPDATE ON expenditure
FOR EACH ROW
EXECUTE FUNCTION fn_validate_expenditure_transition();
```

---

### 1.6 Trigger 6: Automated Balance Maintenance on Status Change
- **Purpose**: Automatically maintains `grant_account.current_balance` when expenditure status changes, regardless of whether updated via stored procedure, API, or direct SQL:
  - `PENDING -> APPROVED`: Deducts the amount from `grant_account.current_balance`. Raises an error if the balance is insufficient or if the grant is not `ACTIVE`.
  - `APPROVED -> REJECTED`: Restores the amount back to `grant_account.current_balance`.
- **Target Table**: `expenditure`
- **Timing**: `AFTER UPDATE OF status ON expenditure`

```sql
CREATE OR REPLACE FUNCTION fn_maintain_expenditure_balance()
RETURNS TRIGGER AS $$
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
```

---

### 1.7 Trigger 7: Automated Audit Logging
- **Purpose**: Generates an audit record whenever an expenditure is created or updated. For creation entries, it records the submitting faculty's user account where known.
- **Target Table**: `expenditure`
- **Timing**: `AFTER INSERT OR UPDATE ON expenditure`

```sql
CREATE OR REPLACE FUNCTION fn_audit_expenditure_lifecycle()
RETURNS TRIGGER AS $$
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
            'STATUS_CHANGE_' || NEW.status,
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
```

---

### 1.8 Trigger 8: Audit Log Immutability Guard
- **Purpose**: Guarantees that `audit_log` records cannot be updated, deleted, or truncated by any application process.
- **Target Table**: `audit_log`
- **Timing**: `BEFORE UPDATE OR DELETE ON audit_log` (row-level) and `BEFORE TRUNCATE ON audit_log` (statement-level).

```sql
CREATE OR REPLACE FUNCTION fn_audit_log_immutable()
RETURNS TRIGGER AS $$
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
```

---

### 1.9 Trigger 9: Full-Text Search Vector Synchronization
- **Purpose**: Automatically generates weighted search lexemes for disclosures (title = weight A, abstract = weight B).
- **Target Table**: `intellectual_property`
- **Timing**: `BEFORE INSERT OR UPDATE OF title, abstract ON intellectual_property`

```sql
CREATE OR REPLACE FUNCTION fn_sync_ip_tsvector()
RETURNS TRIGGER AS $$
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
```

---

## 2. Stored Procedures & Transactional Entry Points

The project specification (rubric item 7) requires "Stored procedures/functions". In PostgreSQL, both `CREATE FUNCTION` and `CREATE PROCEDURE` are available. When called via Route Handlers, each function call executes inside its own atomic transaction. We design stored functions returning structured `JSONB` for direct querying via `SELECT approve_expenditure($1, $2);`, and provide equivalent `CREATE PROCEDURE` statements with `INOUT` parameters for environments utilizing SQL `CALL`.

> **Security Note**: The administrator user ID (`p_admin_user_id`) passed to these routines must always be extracted on the server from the authenticated session/JWT cookie in the Next.js backend, never accepted from client-supplied request bodies.

### 2.1 Stored Function: `approve_expenditure`

```sql
CREATE OR REPLACE FUNCTION approve_expenditure(
    p_transaction_id INT,
    p_admin_user_id  INT
)
RETURNS JSONB AS $$
DECLARE
    v_account_id       INT;
    v_amount           NUMERIC(12, 2);
    v_status           VARCHAR(20);
    v_admin_role       VARCHAR(20);
    v_new_balance      NUMERIC(14, 2);
BEGIN
    -- 1. Validate that the acting user has ADMIN privileges
    SELECT role INTO v_admin_role
    FROM users
    WHERE user_id = p_admin_user_id AND is_active = TRUE;

    IF v_admin_role IS NULL OR v_admin_role <> 'ADMIN' THEN
        RAISE EXCEPTION 'Authorization failure: User % is not an active ADMIN', p_admin_user_id;
    END IF;

    -- 2. Lock the target expenditure row
    SELECT account_id, amount, status
    INTO v_account_id, v_amount, v_status
    FROM expenditure
    WHERE transaction_id = p_transaction_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expenditure with transaction ID % does not exist', p_transaction_id;
    END IF;

    -- 3. Only PENDING claims may be approved
    IF v_status <> 'PENDING' THEN
        RAISE EXCEPTION 'Cannot approve: Expenditure % is currently % (only PENDING claims can be approved)',
            p_transaction_id, v_status;
    END IF;

    -- 4. Update status to APPROVED (the trigger handles balance deduction and validations)
    UPDATE expenditure
    SET status = 'APPROVED',
        approved_by = p_admin_user_id,
        decision_date = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = p_transaction_id;

    -- 5. Fetch the resulting balance after trigger execution
    SELECT current_balance INTO v_new_balance
    FROM grant_account
    WHERE account_id = v_account_id;

    RETURN jsonb_build_object(
        'transaction_id', p_transaction_id,
        'status', 'APPROVED',
        'amount_approved', v_amount,
        'remaining_balance', v_new_balance,
        'approved_by', p_admin_user_id
    );
END;
$$ LANGUAGE plpgsql;
```

---

### 2.2 Stored Function: `reject_or_revert_expenditure`

```sql
CREATE OR REPLACE FUNCTION reject_or_revert_expenditure(
    p_transaction_id INT,
    p_admin_user_id  INT,
    p_reason         TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_account_id       INT;
    v_amount           NUMERIC(12, 2);
    v_status           VARCHAR(20);
    v_admin_role       VARCHAR(20);
BEGIN
    -- Validate ADMIN privileges
    SELECT role INTO v_admin_role
    FROM users
    WHERE user_id = p_admin_user_id AND is_active = TRUE;

    IF v_admin_role IS NULL OR v_admin_role <> 'ADMIN' THEN
        RAISE EXCEPTION 'Authorization failure: User % is not an active ADMIN', p_admin_user_id;
    END IF;

    -- Lock expenditure row
    SELECT account_id, amount, status
    INTO v_account_id, v_amount, v_status
    FROM expenditure
    WHERE transaction_id = p_transaction_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expenditure with transaction ID % does not exist', p_transaction_id;
    END IF;

    -- Cannot reject an already rejected claim
    IF v_status = 'REJECTED' THEN
        RAISE EXCEPTION 'Cannot reject: Expenditure % is already in REJECTED status', p_transaction_id;
    END IF;

    -- Update expenditure to REJECTED (the trigger handles fund restoration if previously APPROVED)
    UPDATE expenditure
    SET status = 'REJECTED',
        approved_by = p_admin_user_id,
        decision_date = CURRENT_TIMESTAMP,
        rejection_reason = p_reason,
        updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = p_transaction_id;

    RETURN jsonb_build_object(
        'transaction_id', p_transaction_id,
        'status', 'REJECTED',
        'reverted_from', v_status,
        'funds_restored', (v_status = 'APPROVED'),
        'rejection_reason', p_reason
    );
END;
$$ LANGUAGE plpgsql;
```

### 2.3 Stored Procedure Variant (Callable via `CALL`)
For database client workflows requiring the SQL standard `CALL` syntax:

```sql
CREATE OR REPLACE PROCEDURE approve_expenditure_proc(
    p_transaction_id INT,
    p_admin_user_id  INT,
    INOUT p_result   JSONB DEFAULT NULL
)
LANGUAGE plpgsql AS $$
BEGIN
    p_result := approve_expenditure(p_transaction_id, p_admin_user_id);
END;
$$;
```
```

---

## 3. Database Views for Reporting & Dashboards

### 3.1 View 1: `v_grant_financial_summary`
Aggregates grant-level financial metrics: sanctioned budget, total allocated across heads, total expenditure spent, unallocated balance, remaining active balance, and burn rate percentage.

```sql
CREATE OR REPLACE VIEW v_grant_financial_summary AS
SELECT 
    g.grant_id,
    g.grant_code,
    g.title,
    g.funding_agency,
    g.status AS grant_status,
    g.start_date,
    g.end_date,
    f.full_name AS pi_name,
    d.department_code,
    g.total_budget AS sanctioned_budget,
    COALESCE(SUM(ga.budget_allocated), 0) AS total_allocated,
    (g.total_budget - COALESCE(SUM(ga.budget_allocated), 0)) AS unallocated_reserve,
    COALESCE(SUM(ga.current_balance), 0) AS remaining_cash_balance,
    COALESCE(SUM(ga.budget_allocated - ga.current_balance), 0) AS total_spent,
    CASE 
        WHEN g.total_budget > 0 
        THEN ROUND(((COALESCE(SUM(ga.budget_allocated - ga.current_balance), 0) / g.total_budget) * 100), 2)
        ELSE 0 
    END AS budget_utilization_pct,
    COUNT(DISTINCT ga.account_id) AS total_budget_heads
FROM grant_record g
JOIN faculty f ON g.pi_faculty_id = f.faculty_id
JOIN department d ON f.department_id = d.department_id
LEFT JOIN grant_account ga ON g.grant_id = ga.grant_id
GROUP BY g.grant_id, g.grant_code, g.title, g.funding_agency, g.status, 
         g.start_date, g.end_date, f.full_name, d.department_code, g.total_budget;
```

---

### 3.2 View 2: `v_department_expenditure_overview`
Aggregates grant totals and expenditure totals in separate CTEs before joining to avoid multi-level join multiplication, preventing grant budget totals from being multiplied by the number of individual expenditures.

```sql
CREATE OR REPLACE VIEW v_department_expenditure_overview AS
WITH dept_grants AS (
    SELECT 
        f.department_id,
        COUNT(DISTINCT g.grant_id) AS total_grants,
        COUNT(DISTINCT CASE WHEN g.status = 'ACTIVE' THEN g.grant_id END) AS active_grants,
        COALESCE(SUM(g.total_budget), 0) AS total_sanctioned_funds
    FROM faculty f
    JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
    GROUP BY f.department_id
),
dept_expenditures AS (
    SELECT 
        f.department_id,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'APPROVED'), 0) AS total_approved_expenditure,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PENDING'), 0) AS pending_claims_value,
        COUNT(e.transaction_id) FILTER (WHERE e.status = 'APPROVED') AS approved_transaction_count
    FROM faculty f
    JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
    JOIN grant_account ga ON g.grant_id = ga.grant_id
    JOIN expenditure e ON ga.account_id = e.account_id
    GROUP BY f.department_id
)
SELECT 
    d.department_id,
    d.department_name,
    d.department_code,
    COALESCE(dg.total_grants, 0) AS total_grants,
    COALESCE(dg.active_grants, 0) AS active_grants,
    COALESCE(dg.total_sanctioned_funds, 0) AS total_sanctioned_funds,
    COALESCE(de.total_approved_expenditure, 0) AS total_approved_expenditure,
    COALESCE(de.pending_claims_value, 0) AS pending_claims_value,
    COALESCE(de.approved_transaction_count, 0) AS approved_transaction_count
FROM department d
LEFT JOIN dept_grants dg ON d.department_id = dg.department_id
LEFT JOIN dept_expenditures de ON d.department_id = de.department_id;
```

---

### 3.3 View 3: `v_faculty_ip_portfolio`
Summarizes research productivity per faculty member: total patents, research papers, disclosures, and co-authorship relationships.

```sql
CREATE OR REPLACE VIEW v_faculty_ip_portfolio AS
SELECT 
    f.faculty_id,
    f.full_name,
    f.email,
    f.designation,
    d.department_code,
    COUNT(DISTINCT ipa.document_id) AS total_ip_disclosures,
    COUNT(DISTINCT CASE WHEN ip.doc_type = 'PATENT' THEN ip.document_id END) AS patents_filed,
    COUNT(DISTINCT CASE WHEN ip.doc_type = 'PAPER' THEN ip.document_id END) AS papers_published,
    COUNT(DISTINCT CASE WHEN ip.doc_type = 'DRAFT_DISCLOSURE' THEN ip.document_id END) AS draft_disclosures,
    COUNT(DISTINCT CASE WHEN ipa.is_corresponding = TRUE THEN ipa.document_id END) AS corresponding_author_count,
    COUNT(DISTINCT g.grant_id) AS associated_funded_grants
FROM faculty f
JOIN department d ON f.department_id = d.department_id
LEFT JOIN ip_author ipa ON f.faculty_id = ipa.faculty_id
LEFT JOIN intellectual_property ip ON ipa.document_id = ip.document_id
LEFT JOIN grant_ip gi ON ip.document_id = gi.document_id
LEFT JOIN grant_record g ON gi.grant_id = g.grant_id
GROUP BY f.faculty_id, f.full_name, f.email, f.designation, d.department_code;
```

---

## 4. Indexing Strategy & Performance Justifications

| Index Name | Table & Column(s) | Index Type | Justification |
|---|---|:---:|---|
| `idx_faculty_dept` | `faculty(department_id)` | B-Tree | Accelerates joins between faculty and department tables. |
| `idx_grant_pi` | `grant_record(pi_faculty_id)` | B-Tree | Optimizes queries filtering grants by Principal Investigator. |
| `idx_account_grant` | `grant_account(grant_id)` | B-Tree | Speeds up cascading joins and balance sums for accounts per grant. |
| `idx_expenditure_account` | `expenditure(account_id)` | B-Tree | Accelerates joins and aggregates between accounts and expenses. |
| `idx_expenditure_submitted_by` | `expenditure(submitted_by)` | B-Tree | Optimizes queries filtering claims by submitting faculty PI. |
| `idx_expenditure_status_date` | `expenditure(status, transaction_date)` | B-Tree (Compound) | Optimizes admin approval dashboard queries filtering pending claims sorted by date. |
| `idx_ip_author_faculty` | `ip_author(faculty_id)` | B-Tree | Speeds up reverse lookups finding publications authored by a faculty member. |
| `idx_grant_ip_document` | `grant_ip(document_id)` | B-Tree | Speeds up reverse joins linking disclosures to funding grants. |
| `idx_audit_entity` | `audit_log(entity_type, entity_id)` | B-Tree | Speeds up retrieval of audit trails for a specific transaction. |
| `idx_ip_tsv_gin` | `intellectual_property(tsv)` | GIN | Enables fast English full-text search. |
| `idx_ip_embedding_hnsw` | `intellectual_property(embedding vector_cosine_ops)` | HNSW | Powers approximate nearest neighbor semantic searches using cosine distance. |

```sql
-- Relational B-Tree Indexes
CREATE INDEX idx_faculty_dept ON faculty (department_id);
CREATE INDEX idx_grant_pi ON grant_record (pi_faculty_id);
CREATE INDEX idx_account_grant ON grant_account (grant_id);
CREATE INDEX idx_expenditure_account ON expenditure (account_id);
CREATE INDEX idx_expenditure_submitted_by ON expenditure (submitted_by);
CREATE INDEX idx_expenditure_status_date ON expenditure (status, transaction_date);
CREATE INDEX idx_ip_author_faculty ON ip_author (faculty_id);
CREATE INDEX idx_grant_ip_document ON grant_ip (document_id);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);

-- GIN Inverted Index for Full-Text Search
CREATE INDEX idx_ip_tsv_gin ON intellectual_property USING gin (tsv);

-- HNSW Vector Index for Semantic Cosine Distance Search
CREATE INDEX idx_ip_embedding_hnsw 
ON intellectual_property 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

---

## 5. Showcase Queries Demonstrating Project Requirements

The following queries demonstrate each required SQL concept cleanly and accurately:

### Query 1: Multi-Table JOIN (Audit Trail with Complete Attribution)
Demonstrates multi-table inner joins across 5 tables (`expenditure`, `grant_account`, `grant_record`, `faculty`, `department`).

```sql
SELECT 
    e.transaction_id,
    e.transaction_date,
    e.amount,
    e.status,
    ga.category,
    g.grant_code,
    g.title AS grant_title,
    f.full_name AS pi_name,
    d.department_name
FROM expenditure e
JOIN grant_account ga ON e.account_id = ga.account_id
JOIN grant_record g ON ga.grant_id = g.grant_id
JOIN faculty f ON g.pi_faculty_id = f.faculty_id
JOIN department d ON f.department_id = d.department_id
WHERE e.status = 'PENDING'
ORDER BY e.transaction_date ASC, e.amount DESC;
```
*Expected seed data return*: Returns pending claims across active grants, displaying transaction ID, date, category, PI name, and department.

---

### Query 2: `GROUP BY` and `HAVING` (Filtering by Aggregate Threshold)
Demonstrates `GROUP BY` and a `HAVING` clause filtering an aggregate calculation, identifying grants where cumulative expenditures exceed 80% of the total approved budget.

```sql
SELECT 
    g.grant_id,
    g.grant_code,
    g.title,
    g.total_budget,
    SUM(ga.budget_allocated - ga.current_balance) AS total_spent,
    ROUND((SUM(ga.budget_allocated - ga.current_balance) / g.total_budget) * 100, 2) AS burn_rate_pct
FROM grant_record g
JOIN grant_account ga ON g.grant_id = ga.grant_id
WHERE g.status = 'ACTIVE'
GROUP BY g.grant_id, g.grant_code, g.title, g.total_budget
HAVING (SUM(ga.budget_allocated - ga.current_balance) / g.total_budget) >= 0.80
ORDER BY burn_rate_pct DESC;
```
*Expected seed data return*: Returns grants where total expenditures have reached or exceeded 80% of sanctioned funding.

---

### Query 3: Aggregate Functions (`SUM`, `AVG`, `COUNT`, `MAX`, `MIN`)
Demonstrates aggregate calculations across department research funding.

```sql
SELECT 
    d.department_name,
    COUNT(g.grant_id) AS total_grants_awarded,
    SUM(g.total_budget) AS total_funding_sanctioned,
    ROUND(AVG(g.total_budget), 2) AS average_grant_size,
    MAX(g.total_budget) AS largest_grant_awarded,
    MIN(g.total_budget) AS smallest_grant_awarded
FROM department d
JOIN faculty f ON d.department_id = f.department_id
JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
GROUP BY d.department_id, d.department_name
ORDER BY total_funding_sanctioned DESC;
```
*Expected seed data return*: Returns one summary row per academic department with total grants, total sanctioned funds, average grant size, and range.

---

### Query 4: Window Function (`RANK()` over Department Grant Funding)
Demonstrates an analytical window function (`RANK() OVER (...)`) to rank departments by total research funding received.

```sql
SELECT 
    d.department_name,
    d.department_code,
    COALESCE(SUM(g.total_budget), 0) AS total_grant_funding,
    RANK() OVER (ORDER BY COALESCE(SUM(g.total_budget), 0) DESC) AS funding_rank
FROM department d
LEFT JOIN faculty f ON d.department_id = f.department_id
LEFT JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
GROUP BY d.department_id, d.department_name, d.department_code
ORDER BY funding_rank ASC;
```
*Expected seed data return*: Returns an ordered list of departments ranked by total research funding received.

---

### Query 5: Common Table Expression (CTE) for Benchmarking
Demonstrates a Common Table Expression (CTE) computing the university average grant total, then identifying faculty members whose total funding exceeds that benchmark.

```sql
WITH faculty_funding AS (
    SELECT 
        f.faculty_id,
        f.full_name,
        d.department_code,
        COALESCE(SUM(g.total_budget), 0) AS total_pi_funding
    FROM faculty f
    JOIN department d ON f.department_id = d.department_id
    LEFT JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
    GROUP BY f.faculty_id, f.full_name, d.department_code
),
benchmark AS (
    SELECT AVG(total_pi_funding) AS avg_pi_funding
    FROM faculty_funding
    WHERE total_pi_funding > 0
)
SELECT 
    ff.full_name,
    ff.department_code,
    ff.total_pi_funding,
    ROUND(b.avg_pi_funding, 2) AS university_benchmark
FROM faculty_funding ff, benchmark b
WHERE ff.total_pi_funding > b.avg_pi_funding
ORDER BY ff.total_pi_funding DESC;
```
*Expected seed data return*: Returns faculty members whose cumulative PI grant funding exceeds the university departmental benchmark average.

---

### Query 6: Correlated `EXISTS` & Scalar Subquery
Demonstrates:
(a) A plain correlated `EXISTS` identifying accounts that currently have at least one `PENDING` expenditure claim.
(b) A correlated scalar subquery comparing the cumulative pending amount against `current_balance` to find accounts at risk of overdraft.

```sql
-- 6a. Plain correlated EXISTS: Accounts with active pending claims
SELECT 
    ga.account_id,
    g.grant_code,
    ga.category,
    ga.current_balance
FROM grant_account ga
JOIN grant_record g ON ga.grant_id = g.grant_id
WHERE EXISTS (
    SELECT 1 
    FROM expenditure e
    WHERE e.account_id = ga.account_id
      AND e.status = 'PENDING'
);

-- 6b. Correlated scalar subquery: Accounts where pending sum exceeds available balance
SELECT 
    ga.account_id,
    g.grant_code,
    ga.category,
    ga.current_balance,
    (
        SELECT COALESCE(SUM(e.amount), 0)
        FROM expenditure e
        WHERE e.account_id = ga.account_id
          AND e.status = 'PENDING'
    ) AS total_pending_claims
FROM grant_account ga
JOIN grant_record g ON ga.grant_id = g.grant_id
WHERE (
    SELECT COALESCE(SUM(e.amount), 0)
    FROM expenditure e
    WHERE e.account_id = ga.account_id
      AND e.status = 'PENDING'
) > ga.current_balance;
```
*Expected seed data return*: Query 6a returns all accounts with unreviewed claims; Query 6b isolates accounts at immediate risk of overdraft.

---

### Query 7: `NOT EXISTS` Subquery & Positive `IN` Subquery
Demonstrates:
(a) `NOT EXISTS` subquery identifying faculty without disclosures. Using `NOT EXISTS` is safer than `NOT IN` because if a subquery returns any `NULL` values, SQL three-valued logic causes `NOT IN` to evaluate to `UNKNOWN` and drop all rows, whereas `NOT EXISTS` evaluates existence cleanly row-by-row.
(b) A positive `IN (subquery)` finding faculty members who are Principal Investigators of currently `ACTIVE` grants.

```sql
-- 7a. NOT EXISTS: Faculty members who have not yet authored an IP disclosure
SELECT 
    f.faculty_id,
    f.full_name,
    f.email,
    d.department_code
FROM faculty f
JOIN department d ON f.department_id = d.department_id
WHERE NOT EXISTS (
    SELECT 1 
    FROM ip_author ipa
    WHERE ipa.faculty_id = f.faculty_id
)
ORDER BY f.full_name ASC;

-- 7b. Positive IN subquery: Faculty currently acting as PI on active research grants
SELECT 
    f.faculty_id,
    f.full_name,
    f.email,
    d.department_code
FROM faculty f
JOIN department d ON f.department_id = d.department_id
WHERE f.faculty_id IN (
    SELECT pi_faculty_id 
    FROM grant_record 
    WHERE status = 'ACTIVE'
)
ORDER BY f.full_name ASC;
```
*Expected seed data return*: Query 7a returns newly appointed faculty without disclosures; Query 7b returns faculty actively directing sanctioned research projects.
```
