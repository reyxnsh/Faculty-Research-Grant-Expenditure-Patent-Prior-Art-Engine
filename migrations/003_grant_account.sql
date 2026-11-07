-- Up Migration
CREATE TABLE grant_record (
    grant_id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grant_code          VARCHAR(50) NOT NULL,
    title               VARCHAR(300) NOT NULL,
    funding_agency      VARCHAR(200) NOT NULL,
    pi_faculty_id       INT NOT NULL,
    total_budget        NUMERIC(14, 2) NOT NULL,
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_grant_code UNIQUE (grant_code),
    CONSTRAINT chk_grant_budget_positive CHECK (total_budget > 0),
    CONSTRAINT chk_grant_dates CHECK (end_date >= start_date),
    CONSTRAINT chk_grant_status CHECK (status IN ('ACTIVE', 'CLOSED', 'SUSPENDED')),
    CONSTRAINT fk_grant_pi 
        FOREIGN KEY (pi_faculty_id) 
        REFERENCES faculty (faculty_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE
);

CREATE TABLE grant_account (
    account_id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grant_id            INT NOT NULL,
    category            VARCHAR(50) NOT NULL,
    budget_allocated    NUMERIC(14, 2) NOT NULL,
    current_balance     NUMERIC(14, 2) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_grant_category UNIQUE (grant_id, category),
    CONSTRAINT chk_category_type CHECK (
        category IN ('EQUIPMENT', 'TRAVEL', 'CONSUMABLES', 'MANPOWER', 'CONTINGENCY', 'OVERHEAD')
    ),
    CONSTRAINT chk_budget_allocated_nonnegative CHECK (budget_allocated >= 0),
    CONSTRAINT chk_current_balance_range CHECK (
        current_balance >= 0 AND current_balance <= budget_allocated
    ),
    CONSTRAINT fk_account_grant
        FOREIGN KEY (grant_id)
        REFERENCES grant_record (grant_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

-- Down Migration
DROP TABLE IF EXISTS grant_account;
DROP TABLE IF EXISTS grant_record;
