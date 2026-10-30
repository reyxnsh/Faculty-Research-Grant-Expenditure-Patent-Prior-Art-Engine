# Relational Schema Specification

## 1. Schema Overview & Design Principles

The relational schema is designed for PostgreSQL 16 with the `pgvector` extension. The schema prioritizes:
1. **Declarative Integrity**: Enforcing domain rules at the database level via `NOT NULL`, `CHECK`, and `UNIQUE` constraints.
2. **Referential Integrity**: Using explicit `ON DELETE RESTRICT` on core business and user relationships so records cannot be accidentally deleted when dependent financial and audit history exists. User accounts are deactivated via `is_active` rather than deleted.
3. **Third Normal Form (3NF)**: Normalizing all entities into 3NF, with one intentional, trigger-maintained denormalization (`current_balance`) on `grant_account`.

---

## 2. Normalization Analysis

### 2.1 First Normal Form (1NF)
- **Criterion**: Every column contains only atomic (indivisible) values, each record has a unique primary key, and there are no repeating groups.
- **Application**:
  - Multi-valued attributes such as co-authorship and multi-grant funding are stored in separate junction tables (`ip_author`, `grant_ip`).
  - Contact information, dates, and amounts are stored as atomic fields.
  - Status and category fields are scalar strings constrained by explicit `CHECK` enums.

### 2.2 Second Normal Form (2NF)
- **Criterion**: The table is in 1NF and all non-key attributes depend on the entire primary key (no partial key dependencies).
- **Application**:
  - In single-column primary key tables (`department`, `faculty`, `users`, `grant_record`, `grant_account`, `expenditure`, `intellectual_property`, `audit_log`), partial key dependencies cannot occur because the primary key contains only one column.
  - In composite primary key tables:
    - In `ip_author (document_id, faculty_id)`, `author_order` and `is_corresponding` describe the specific relationship between that paper and that faculty member.
    - In `grant_ip (grant_id, document_id)`, `contribution_details` describes how that specific grant funded that specific paper.
  - Therefore, all tables satisfy 2NF.

### 2.3 Third Normal Form (3NF)
- **Criterion**: The table is in 2NF and there are no transitive dependencies (no non-key attribute depends on another non-key attribute).
- **Application**:
  - `faculty`: References `department_id`. The department name remains in `department`.
  - `grant_record`: References `pi_faculty_id`. Faculty details remain in `faculty`.
  - `expenditure`: References `account_id`, `submitted_by`, and `approved_by`. Grant details are resolved through the foreign key from `grant_account` to `grant_record` rather than duplicating `grant_id` in `expenditure`.

### 2.4 Intentional Denormalization Justification: `current_balance`
- **Location**: `grant_account.current_balance`
- **Normalized Alternative**: In pure 3NF, the available balance is calculated dynamically:
  `budget_allocated - (sum of amount where status = 'APPROVED')`
- **Why We Denormalize**:
  1. **Avoiding full history aggregation on every approval**: An account may accumulate hundreds of historical expenditures over a multi-year grant. Re-summing every past approved transaction each time a new expenditure is submitted or checked adds unnecessary query overhead.
  2. **Row-level locking**: Storing `current_balance` on the `grant_account` row gives us a single row to lock using `SELECT ... FOR UPDATE`. This serializes approvals for that specific account and prevents two concurrent approvals from overdrawing the balance.
  3. **Direct CHECK constraint**: Having the column directly on `grant_account` allows us to add `CHECK (current_balance >= 0 AND current_balance <= budget_allocated)`, giving us an automatic safety check enforced by PostgreSQL.
- **Integrity Protection**:
  - Direct updates to `current_balance` are rejected by a database trigger unless the change originates from inside another trigger (`pg_trigger_depth() > 1`).
  - Balance updates happen only when an expenditure transitions to `APPROVED` (deducting the amount) or from `APPROVED` to `REJECTED` (restoring the amount).

---

## 3. Data Definition Language (DDL) Design Review

The following SQL statements define the complete database schema.

```sql
-- ============================================================================
-- EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- 1. DEPARTMENT
-- ============================================================================
CREATE TABLE department (
    department_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_name     VARCHAR(150) NOT NULL,
    department_code     VARCHAR(20) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_dept_name UNIQUE (department_name),
    CONSTRAINT uq_dept_code UNIQUE (department_code)
);

-- ============================================================================
-- 2. FACULTY
-- ============================================================================
CREATE TABLE faculty (
    faculty_id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_id       INT NOT NULL,
    full_name           VARCHAR(150) NOT NULL,
    email               VARCHAR(255) NOT NULL,
    designation         VARCHAR(100) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_faculty_email UNIQUE (email),
    CONSTRAINT fk_faculty_department 
        FOREIGN KEY (department_id) 
        REFERENCES department (department_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE
);

-- ============================================================================
-- 3. USERS (Authentication & Role-Based Access)
-- ============================================================================
CREATE TABLE users (
    user_id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email               VARCHAR(255) NOT NULL,
    password_hash       VARCHAR(255) NOT NULL,
    role                VARCHAR(20) NOT NULL,
    faculty_id          INT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_user_email UNIQUE (email),
    CONSTRAINT uq_user_faculty UNIQUE (faculty_id),
    CONSTRAINT chk_user_role CHECK (role IN ('ADMIN', 'FACULTY')),
    CONSTRAINT fk_user_faculty 
        FOREIGN KEY (faculty_id) 
        REFERENCES faculty (faculty_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE,
    CONSTRAINT chk_faculty_role_link CHECK (
        (role = 'FACULTY' AND faculty_id IS NOT NULL) OR
        (role = 'ADMIN')
    )
);

-- ============================================================================
-- 4. GRANT
-- ============================================================================
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

-- ============================================================================
-- 5. GRANT_ACCOUNT
-- ============================================================================
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

-- ============================================================================
-- 6. EXPENDITURE
-- ============================================================================
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

-- ============================================================================
-- 7. INTELLECTUAL_PROPERTY
-- ============================================================================
CREATE TABLE intellectual_property (
    document_id         INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_type            VARCHAR(30) NOT NULL,
    title               VARCHAR(400) NOT NULL,
    abstract            TEXT NOT NULL,
    filing_date         DATE NOT NULL DEFAULT CURRENT_DATE,
    publication_or_patent_number VARCHAR(100) NULL,
    embedding           vector(384) NULL,
    tsv                 tsvector NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_doc_type CHECK (
        doc_type IN ('PATENT', 'PAPER', 'DRAFT_DISCLOSURE')
    )
);

-- ============================================================================
-- 8. IP_AUTHOR (Associative Entity: FACULTY <-> INTELLECTUAL_PROPERTY)
-- ============================================================================
CREATE TABLE ip_author (
    document_id         INT NOT NULL,
    faculty_id          INT NOT NULL,
    author_order        INT NOT NULL,
    is_corresponding    BOOLEAN NOT NULL DEFAULT FALSE,

    PRIMARY KEY (document_id, faculty_id),
    CONSTRAINT chk_author_order_positive CHECK (author_order > 0),
    CONSTRAINT uq_doc_author_order UNIQUE (document_id, author_order) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_ipauthor_document 
        FOREIGN KEY (document_id) 
        REFERENCES intellectual_property (document_id) 
        ON DELETE CASCADE 
        ON UPDATE CASCADE,
    CONSTRAINT fk_ipauthor_faculty 
        FOREIGN KEY (faculty_id) 
        REFERENCES faculty (faculty_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE
);

-- ============================================================================
-- 9. GRANT_IP (Associative Entity: GRANT <-> INTELLECTUAL_PROPERTY)
-- ============================================================================
CREATE TABLE grant_ip (
    grant_id            INT NOT NULL,
    document_id         INT NOT NULL,
    contribution_details TEXT NULL,
    linked_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (grant_id, document_id),
    CONSTRAINT fk_grantip_grant 
        FOREIGN KEY (grant_id) 
        REFERENCES grant_record (grant_id) 
        ON DELETE CASCADE 
        ON UPDATE CASCADE,
    CONSTRAINT fk_grantip_document 
        FOREIGN KEY (document_id) 
        REFERENCES intellectual_property (document_id) 
        ON DELETE CASCADE 
        ON UPDATE CASCADE
);

-- ============================================================================
-- 10. AUDIT_LOG
-- ============================================================================
CREATE TABLE audit_log (
    log_id              INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type         VARCHAR(50) NOT NULL DEFAULT 'EXPENDITURE',
    entity_id           INT NOT NULL,
    action              VARCHAR(50) NOT NULL,
    old_state           JSONB NULL,
    new_state           JSONB NULL,
    changed_by          INT NULL,
    timestamp           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    remarks             TEXT NULL,

    CONSTRAINT fk_audit_user 
        FOREIGN KEY (changed_by) 
        REFERENCES users (user_id) 
        ON DELETE RESTRICT 
        ON UPDATE CASCADE
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX idx_faculty_dept ON faculty (department_id);
CREATE INDEX idx_grant_pi ON grant_record (pi_faculty_id);
CREATE INDEX idx_account_grant ON grant_account (grant_id);
CREATE INDEX idx_expenditure_account ON expenditure (account_id);
CREATE INDEX idx_expenditure_submitted_by ON expenditure (submitted_by);
CREATE INDEX idx_expenditure_status_date ON expenditure (status, transaction_date);
CREATE INDEX idx_ip_author_faculty ON ip_author (faculty_id);
CREATE INDEX idx_grant_ip_document ON grant_ip (document_id);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);

CREATE INDEX idx_ip_tsv_gin ON intellectual_property USING gin (tsv);
CREATE INDEX idx_ip_embedding_hnsw 
ON intellectual_property 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

---

## 4. Database Roles & Application Privileges

To follow the principle of least privilege, the application backend and test suites connect to PostgreSQL using a dedicated application role (`app_user`), rather than the database owner or superuser:
- `app_user` is granted `SELECT`, `INSERT`, `UPDATE`, `DELETE` on operational tables (`department`, `faculty`, `users`, `grant_record`, `grant_account`, `expenditure`, `intellectual_property`, `ip_author`, `grant_ip`).
- On `audit_log`, `app_user` receives only `SELECT` and `INSERT` privileges. It is denied `UPDATE`, `DELETE`, and `TRUNCATE` privileges.
- `app_user` has no `TRUNCATE` or `TRIGGER` administrative privileges on any table.
- This role is created in the database migration scripts.

