-- Up Migration
CREATE TABLE expenditure (
    transaction_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id          INT NOT NULL,
    submitted_by        INT NOT NULL,
    approved_by         INT NULL,
    amount              NUMERIC(12, 2) NOT NULL,
    description         TEXT NOT NULL,
    invoice_reference   VARCHAR(100) NULL,
    transaction_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    decision_date       TIMESTAMPTZ NULL,
    rejection_reason    TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_expenditure_amount_positive CHECK (amount > 0),
    CONSTRAINT chk_expenditure_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT chk_expenditure_state CHECK (
        (status = 'PENDING' AND approved_by IS NULL AND decision_date IS NULL) OR
        (status = 'APPROVED' AND approved_by IS NOT NULL AND decision_date IS NOT NULL) OR
        (status = 'REJECTED' AND decision_date IS NOT NULL AND rejection_reason IS NOT NULL)
    ),
    CONSTRAINT fk_expenditure_account 
        FOREIGN KEY (account_id) 
        REFERENCES grant_account (account_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE,
    CONSTRAINT fk_expenditure_submitter 
        FOREIGN KEY (submitted_by) 
        REFERENCES faculty (faculty_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE,
    CONSTRAINT fk_expenditure_approver 
        FOREIGN KEY (approved_by) 
        REFERENCES users (user_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE
);

-- Down Migration
DROP TABLE IF EXISTS expenditure;
