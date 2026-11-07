-- Up Migration
-- Lock Hierarchy Documentation:
-- Functions in this migration acquire Level 1 locks (SELECT FOR UPDATE on expenditure).
-- Downstream balance maintenance triggers acquire Level 2 locks (SELECT FOR UPDATE on grant_account).
-- There are no reverse lock acquisitions, ensuring strict deadlock freedom.

CREATE OR REPLACE FUNCTION approve_expenditure(
    p_transaction_id INT,
    p_admin_user_id  INT
)
RETURNS JSONB
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_account_id       INT;
    v_amount           NUMERIC(14, 2);
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

CREATE OR REPLACE FUNCTION reject_or_revert_expenditure(
    p_transaction_id INT,
    p_admin_user_id  INT,
    p_reason         TEXT
)
RETURNS JSONB
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_account_id       INT;
    v_amount           NUMERIC(14, 2);
    v_status           VARCHAR(20);
    v_admin_role       VARCHAR(20);
BEGIN
    -- Validate rejection reason
    IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
        RAISE EXCEPTION 'Rejection reason is required';
    END IF;

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

-- Stored Procedure Variants (Callable via SQL CALL)
CREATE OR REPLACE PROCEDURE approve_expenditure_proc(
    p_transaction_id INT,
    p_admin_user_id  INT,
    INOUT p_result   JSONB DEFAULT NULL
)
SECURITY INVOKER
SET search_path = public, pg_temp
LANGUAGE plpgsql AS $$
BEGIN
    p_result := approve_expenditure(p_transaction_id, p_admin_user_id);
END;
$$;

CREATE OR REPLACE PROCEDURE reject_or_revert_expenditure_proc(
    p_transaction_id INT,
    p_admin_user_id  INT,
    p_reason         TEXT,
    INOUT p_result   JSONB DEFAULT NULL
)
SECURITY INVOKER
SET search_path = public, pg_temp
LANGUAGE plpgsql AS $$
BEGIN
    p_result := reject_or_revert_expenditure(p_transaction_id, p_admin_user_id, p_reason);
END;
$$;

-- Down Migration
DROP PROCEDURE IF EXISTS reject_or_revert_expenditure_proc(INT, INT, TEXT, JSONB);
DROP PROCEDURE IF EXISTS approve_expenditure_proc(INT, INT, JSONB);
DROP FUNCTION IF EXISTS reject_or_revert_expenditure(INT, INT, TEXT);
DROP FUNCTION IF EXISTS approve_expenditure(INT, INT);
