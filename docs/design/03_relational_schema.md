# Relational Schema Specification

## 1. Schema Overview & Design Principles

The relational schema is designed for PostgreSQL 16 with the `pgvector` extension. The schema prioritizes:
1. **Declarative Integrity**: Enforcing domain constraints at the database level via `NOT NULL`, `CHECK`, and `UNIQUE` constraints.
2. **Referential Integrity**: Implementing appropriate `ON DELETE` and `ON UPDATE` actions to prevent orphaned records or unintended cascading deletes of critical financial data.
3. **Rigorous Normalization**: Ensuring all tables adhere to Third Normal Form (3NF), with one deliberate, fully isolated denormalization (`current_balance`) governed by database triggers.

---

## 2. Normalization Analysis

### 2.1 First Normal Form (1NF)
- **Criterion**: Every column contains only atomic (indivisible) values; each record has a unique primary key; no repeating groups.
- **Application**:
  - All multi-valued relationships (co-authorship, multi-grant funding) are factored into dedicated relation tables (`IP_AUTHOR`, `GRANT_IP`) rather than comma-separated strings or arrays.
  - Address/contact information and financial values are atomic.
  - Status and category fields are scalar strings constrained by explicit `CHECK` enums.

### 2.2 Second Normal Form (2NF)
- **Criterion**: The relation is in 1NF and every non-prime attribute is fully functionally dependent on the entire primary key (no partial key dependencies).
- **Application**:
  - In single-column primary key tables (`DEPARTMENT`, `FACULTY`, `USERS`, `GRANT`, `GRANT_ACCOUNT`, `EXPENDITURE`, `INTELLECTUAL_PROPERTY`, `AUDIT_LOG`), partial dependencies are mathematically impossible.
  - In composite primary key tables:
    - In `IP_AUTHOR (document_id, faculty_id)`, the attributes `author_order` and `is_corresponding` depend on both the specific publication and the specific faculty member, not on either attribute alone.
    - In `GRANT_IP (grant_id, document_id)`, the attribute `contribution_details` depends jointly on the grant and the document.
  - Hence, all relations satisfy 2NF.

### 2.3 Third Normal Form (3NF)
- **Criterion**: The relation is in 2NF and there are no transitive dependencies (no non-prime attribute depends on another non-prime attribute; $X \rightarrow Y \implies X$ is a superkey or $Y$ is a prime attribute).
- **Application**:
  - `FACULTY`: Contains `department_id`, while `department_name` remains exclusively in `DEPARTMENT`. No transitive dependency exists.
  - `GRANT`: Contains `pi_faculty_id`. Faculty details (`full_name`, `email`) remain in `FACULTY`.
  - `EXPENDITURE`: Stores `account_id`, `submitted_by`, and `approved_by`. Grant details are resolved by joining `GRANT_ACCOUNT \rightarrow GRANT` rather than redundantly storing `grant_id` in `EXPENDITURE`.

### 2.4 Intentional Denormalization Justification: `current_balance`
- **Location**: `GRANT_ACCOUNT.current_balance`
- **Theoretical Normalized Alternative**: In strict 3NF, the available balance is a derived calculation:
  $$\text{Current Balance} = \text{budget\_allocated} - \sum_{\text{status} = \text{'APPROVED'}} \text{expenditure.amount}$$
- **Why Denormalized**:
  1. **High-Frequency Concurrency**: Expenditure approval workflows require checking if an account has sufficient balance before accepting an expense. Computing an on-the-fly aggregate (`SUM(amount)`) across thousands of historical transactions locks the entire expenditure table or forces repeatable read isolation with high serialization failure rates.
  2. **Row-Level Pessimistic Locking**: Maintaining `current_balance` as a concrete column enables PostgreSQL row-level locks via `SELECT ... FOR UPDATE` directly on the `GRANT_ACCOUNT` row. This serializes approvals for that specific account without blocking other accounts or grants.
- **Consistency Guarantee**:
  - Applications and users are prohibited from executing direct `UPDATE` queries on `current_balance`.
  - The balance is updated exclusively by database triggers and stored procedures (`approve_expenditure`, `reject_expenditure`) running within atomic transactions.
  - Database-level `CHECK (current_balance >= 0)` and `CHECK (current_balance <= budget_allocated)` guarantee that balance corruption is impossible.

---

## 3. Data Definition Language (DDL) Design Review

The following SQL statements define the complete database schema.

```sql
-- ============================================================================
-- EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
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
    CONSTRAINT chk_user_role CHECK (role IN ('ADMIN', 'FACULTY')),
    CONSTRAINT fk_user_faculty 
        FOREIGN KEY (faculty_id) 
        REFERENCES faculty (faculty_id) 
        ON DELETE SET NULL 
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
        ON DELETE SET NULL 
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
    CONSTRAINT uq_doc_author_order UNIQUE (document_id, author_order),
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
        ON DELETE SET NULL 
        ON UPDATE CASCADE
);
```
