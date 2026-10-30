# Advanced Database Features Design

This document details the advanced database features implemented in PostgreSQL 16 to guarantee ACID compliance, automate business rules, accelerate analytical queries, and power search workflows.

---

## 1. Triggers & Automated Business Rule Enforcement

By embedding domain validation directly into database triggers, the database acts as the single source of truth, preventing corrupt or invalid state even if application layers or API calls are bypassed.

### 1.1 Trigger 1: Grant Account Budget Allocation Ceiling Guard
- **Purpose**: Enforces the business rule: the sum of `budget_allocated` across all category accounts belonging to a grant must not exceed the grant's `total_budget`.
- **Target Table**: `grant_account`
- **Timing**: `BEFORE INSERT OR UPDATE OF budget_allocated ON grant_account`
- **Logic**: Calculates prospective total allocated budget including the new or updated row. If it exceeds `grant_record.total_budget`, the transaction raises an exception and aborts.

```sql
CREATE OR REPLACE FUNCTION fn_check_grant_budget_ceiling()
RETURNS TRIGGER AS $$
DECLARE
    v_total_grant_budget NUMERIC(14, 2);
    v_current_allocated   NUMERIC(14, 2);
BEGIN
    -- Fetch the sanctioned total budget for the grant
    SELECT total_budget INTO v_total_grant_budget
    FROM grant_record
    WHERE grant_id = NEW.grant_id;

    IF v_total_grant_budget IS NULL THEN
        RAISE EXCEPTION 'Target grant with ID % does not exist', NEW.grant_id;
    END IF;

    -- Sum allocated budgets excluding the current record if an update is occurring
    SELECT COALESCE(SUM(budget_allocated), 0)
    INTO v_current_allocated
    FROM grant_account
    WHERE grant_id = NEW.grant_id
      AND account_id <> COALESCE(NEW.account_id, -1);

    -- Check if new allocation breaches total grant ceiling
    IF (v_current_allocated + NEW.budget_allocated) > v_total_grant_budget THEN
        RAISE EXCEPTION 'Allocation violation: Total allocated (%.2f) exceeds sanctioned grant budget (%.2f)',
            (v_current_allocated + NEW.budget_allocated), v_total_grant_budget;
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

### 1.2 Trigger 2: Expenditure Pre-Submission Validation Guard
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
    -- Join through grant_account to retrieve parent grant lifecycle attributes
    SELECT g.status, g.start_date, g.end_date, g.pi_faculty_id, g.grant_code
    INTO v_grant_status, v_grant_start, v_grant_end, v_pi_faculty_id, v_grant_code
    FROM grant_account a
    JOIN grant_record g ON a.grant_id = g.grant_id
    WHERE a.account_id = NEW.account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid account ID %: Parent grant account not found', NEW.account_id;
    END IF;

    -- Rule 1: Grant must be active
    IF v_grant_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Expenditure rejected: Grant % is currently % (only ACTIVE grants accept expenses)',
            v_grant_code, v_grant_status;
    END IF;

    -- Rule 2: Transaction date must fall within grant lifespan
    IF NEW.transaction_date < v_grant_start OR NEW.transaction_date > v_grant_end THEN
        RAISE EXCEPTION 'Expenditure rejected: Transaction date (%) falls outside grant active window (% to %)',
            NEW.transaction_date, v_grant_start, v_grant_end;
    END IF;

    -- Rule 3: Only the PI of the grant may submit expenditures
    IF NEW.submitted_by <> v_pi_faculty_id THEN
        RAISE EXCEPTION 'Expenditure rejected: Submitting faculty ID % is not the Principal Investigator for grant %',
            NEW.submitted_by, v_grant_code;
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

### 1.3 Trigger 3: Automated Expenditure Audit Log
- **Purpose**: Automatically generates an immutable audit record whenever an expenditure record is created or its status changes, recording old state, new state, acting user, and timestamp.
- **Target Table**: `expenditure`
- **Timing**: `AFTER INSERT OR UPDATE ON expenditure`

```sql
CREATE OR REPLACE FUNCTION fn_audit_expenditure_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
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
            NULL,
            'Expenditure request initiated in PENDING status'
        );
    ELSIF (TG_OP = 'UPDATE' AND (OLD.status <> NEW.status OR OLD.amount <> NEW.amount)) THEN
        INSERT INTO audit_log (
            entity_type, entity_id, action, old_state, new_state, changed_by, remarks
        ) VALUES (
            'EXPENDITURE',
            NEW.transaction_id,
            'STATUS_CHANGE_' || NEW.status,
            jsonb_build_object('status', OLD.status, 'amount', OLD.amount),
            jsonb_build_object('status', NEW.status, 'amount', NEW.amount),
            NEW.approved_by,
            COALESCE(NEW.rejection_reason, 'Status transitioned from ' || OLD.status || ' to ' || NEW.status)
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

### 1.4 Trigger 4: Automatic Full-Text Search Vector Generation
- **Purpose**: Generates and synchronizes the PostgreSQL `tsvector` column (`tsv`) on `intellectual_property` whenever title or abstract is created or updated, applying weighted lexeme analysis (title = weight A, abstract = weight B).
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

## 2. Stored Procedures & Transactional Business Logic

To prevent race conditions, overdrafts, and partial updates during financial workflows, approval and rejection logic is encapsulated in PL/pgSQL stored procedures running within explicit transactional boundaries with pessimistic row-level locking (`SELECT ... FOR UPDATE`).

### 2.1 Stored Function: `approve_expenditure`
- **Atomicity**: Locks both the `expenditure` and `grant_account` rows before balance comparison.
- **Verification**: Verifies that the approver is an `ADMIN`, the current status is `PENDING`, and the account balance is sufficient.
- **Deduction**: Atomically subtracts the amount from `grant_account.current_balance` and updates `expenditure.status = 'APPROVED'`.

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
    v_current_balance  NUMERIC(14, 2);
    v_grant_status     VARCHAR(20);
BEGIN
    -- 1. Validate that the acting user has ADMIN privileges
    SELECT role INTO v_admin_role
    FROM users
    WHERE user_id = p_admin_user_id AND is_active = TRUE;

    IF v_admin_role IS NULL OR v_admin_role <> 'ADMIN' THEN
        RAISE EXCEPTION 'Authorization failure: User % is not an active ADMIN', p_admin_user_id;
    END IF;

    -- 2. Lock the target expenditure row for update
    SELECT account_id, amount, status
    INTO v_account_id, v_amount, v_status
    FROM expenditure
    WHERE transaction_id = p_transaction_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expenditure with transaction ID % does not exist', p_transaction_id;
    END IF;

    IF v_status <> 'PENDING' THEN
        RAISE EXCEPTION 'Cannot approve: Expenditure % is already in % status', p_transaction_id, v_status;
    END IF;

    -- 3. Lock the associated grant account and check its current balance
    SELECT ga.current_balance, gr.status
    INTO v_current_balance, v_grant_status
    FROM grant_account ga
    JOIN grant_record gr ON ga.grant_id = gr.grant_id
    WHERE ga.account_id = v_account_id
    FOR UPDATE OF ga;

    IF v_grant_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Cannot approve: Associated grant is %', v_grant_status;
    END IF;

    -- 4. Check balance sufficiency
    IF v_current_balance < v_amount THEN
        RAISE EXCEPTION 'Insufficient balance: Account % has available balance %.2f, requested %.2f',
            v_account_id, v_current_balance, v_amount;
    END IF;

    -- 5. Atomically deduct balance
    UPDATE grant_account
    SET current_balance = current_balance - v_amount
    WHERE account_id = v_account_id;

    -- 6. Transition expenditure status to APPROVED
    UPDATE expenditure
    SET status = 'APPROVED',
        approved_by = p_admin_user_id,
        decision_date = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = p_transaction_id;

    -- Return confirmation summary
    RETURN jsonb_build_object(
        'transaction_id', p_transaction_id,
        'status', 'APPROVED',
        'amount_approved', v_amount,
        'remaining_balance', (v_current_balance - v_amount),
        'approved_by', p_admin_user_id
    );
END;
$$ LANGUAGE plpgsql;
```

---

### 2.2 Stored Function: `reject_or_revert_expenditure`
- **Rejection**: Rejects a `PENDING` expenditure (recording reason, no balance change).
- **Reversion**: Reverts a previously `APPROVED` expenditure, restoring the deducted amount back to `grant_account.current_balance` atomically.

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
    -- Verify ADMIN privileges
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

    IF v_status = 'REJECTED' THEN
        RAISE EXCEPTION 'Expenditure % is already in REJECTED status', p_transaction_id;
    END IF;

    -- If previously APPROVED, restore the deducted funds
    IF v_status = 'APPROVED' THEN
        UPDATE grant_account
        SET current_balance = current_balance + v_amount
        WHERE account_id = v_account_id;
    END IF;

    -- Update expenditure state
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
Aggregates spending across academic departments broken down by expenditure category and grant count.

```sql
CREATE OR REPLACE VIEW v_department_expenditure_overview AS
SELECT 
    d.department_id,
    d.department_name,
    d.department_code,
    COUNT(DISTINCT g.grant_id) AS total_grants,
    COUNT(DISTINCT CASE WHEN g.status = 'ACTIVE' THEN g.grant_id END) AS active_grants,
    COALESCE(SUM(g.total_budget), 0) AS total_sanctioned_funds,
    COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'APPROVED'), 0) AS total_approved_expenditure,
    COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PENDING'), 0) AS pending_claims_value,
    COUNT(e.transaction_id) FILTER (WHERE e.status = 'APPROVED') AS approved_transaction_count
FROM department d
LEFT JOIN faculty f ON d.department_id = f.department_id
LEFT JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
LEFT JOIN grant_account ga ON g.grant_id = ga.grant_id
LEFT JOIN expenditure e ON ga.account_id = e.account_id
GROUP BY d.department_id, d.department_name, d.department_code;
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

To achieve rapid response times across relational joins, analytical aggregations, full-text searches, and vector similarity queries, the database utilizes three distinct indexing paradigms:

| Index Name | Table & Target Column(s) | Index Type | Justification |
|---|---|:---:|---|
| `idx_faculty_dept` | `faculty(department_id)` | B-Tree | Speeds up foreign key joins between faculty and department tables. |
| `idx_grant_pi` | `grant_record(pi_faculty_id)` | B-Tree | Accelerates filtering grants by Principal Investigator during role-based queries. |
| `idx_account_grant` | `grant_account(grant_id)` | B-Tree | Optimizes cascading foreign key lookups and budget balance summations per grant. |
| `idx_expenditure_account` | `expenditure(account_id)` | B-Tree | Speeds up joins and aggregate queries between grant accounts and expenses. |
| `idx_expenditure_status_date` | `expenditure(status, transaction_date)` | B-Tree (Compound) | Accelerates admin dashboard queries filtering pending claims sorted by date. |
| `idx_ip_tsv_gin` | `intellectual_property(tsv)` | GIN | Enables high-speed English full-text inverted index searches using `to_tsquery`. |
| `idx_ip_embedding_hnsw` | `intellectual_property(embedding vector_cosine_ops)` | HNSW | Powers approximate nearest neighbor (ANN) prior-art searches with logarithmic lookup time. |

### Index Creation DDL

```sql
-- Relational B-Tree Indexes
CREATE INDEX idx_faculty_dept ON faculty (department_id);
CREATE INDEX idx_grant_pi ON grant_record (pi_faculty_id);
CREATE INDEX idx_account_grant ON grant_account (grant_id);
CREATE INDEX idx_expenditure_account ON expenditure (account_id);
CREATE INDEX idx_expenditure_status_date ON expenditure (status, transaction_date);
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

## 5. Full-Text Search Implementation

PostgreSQL's built-in text search engine provides lexical search capabilities over disclosures:
1. **Weighted Lexemes**: Titles receive weight `'A'` (higher ranking multiplier) and abstracts receive weight `'B'`.
2. **Ranking**: Queries employ `ts_rank_cd` (cover density ranking) to score documents matching query tokens.

```sql
-- Example lexical query searching for quantum cryptography disclosures
SELECT 
    document_id,
    title,
    doc_type,
    filing_date,
    ts_rank_cd(tsv, query) AS lexical_score
FROM intellectual_property,
     plainto_tsquery('english', 'quantum key distribution cryptography') AS query
WHERE tsv @@ query
ORDER BY lexical_score DESC
LIMIT 10;
```

---

## 6. DML Query Showcase (Rubric Requirement Compliance)

The application demonstrates advanced relational queries across all standard SQL operators:

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

---

### Query 2: `GROUP BY` and `HAVING` (Category Overdraft Risk Detection)
Identifies budget categories across active grants where more than 80% of the allocated budget has already been expended.

```sql
SELECT 
    g.grant_code,
    ga.category,
    ga.budget_allocated,
    ga.current_balance,
    (ga.budget_allocated - ga.current_balance) AS total_spent,
    ROUND(((ga.budget_allocated - ga.current_balance) / ga.budget_allocated) * 100, 2) AS utilization_pct
FROM grant_account ga
JOIN grant_record g ON ga.grant_id = g.grant_id
WHERE g.status = 'ACTIVE' 
  AND ga.budget_allocated > 0
GROUP BY g.grant_code, ga.category, ga.budget_allocated, ga.current_balance
HAVING ((ga.budget_allocated - ga.current_balance) / ga.budget_allocated) >= 0.80
ORDER BY utilization_pct DESC;
```

---

### Query 3: Aggregate Functions & Window Ordering (Department Grant Performance)
Aggregates funding statistics (`SUM`, `AVG`, `COUNT`, `MAX`) per department.

```sql
SELECT 
    d.department_name,
    COUNT(g.grant_id) AS total_grants_awarded,
    SUM(g.total_budget) AS total_funds_received,
    ROUND(AVG(g.total_budget), 2) AS avg_grant_size,
    MAX(g.total_budget) AS largest_grant_size
FROM department d
JOIN faculty f ON d.department_id = f.department_id
JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
GROUP BY d.department_id, d.department_name
ORDER BY total_funds_received DESC;
```

---

### Query 4: Subquery / CTE (Above-Average Faculty Grant Funding)
Utilizes a Common Table Expression (CTE) to find faculty members who have secured more total grant funding than the overall university departmental average.

```sql
WITH FacultyTotals AS (
    SELECT 
        f.faculty_id,
        f.full_name,
        d.department_name,
        COALESCE(SUM(g.total_budget), 0) AS faculty_grant_sum
    FROM faculty f
    JOIN department d ON f.department_id = d.department_id
    LEFT JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
    GROUP BY f.faculty_id, f.full_name, d.department_name
),
UniversityAverage AS (
    SELECT AVG(faculty_grant_sum) AS uni_avg_funding
    FROM FacultyTotals
    WHERE faculty_grant_sum > 0
)
SELECT 
    ft.full_name,
    ft.department_name,
    ft.faculty_grant_sum,
    ROUND(ua.uni_avg_funding, 2) AS benchmark_university_average
FROM FacultyTotals ft, UniversityAverage ua
WHERE ft.faculty_grant_sum > ua.uni_avg_funding
ORDER BY ft.faculty_grant_sum DESC;
```

---

### Query 5: Correlated Subquery (Pending Claims Threatening Current Balance)
Finds all accounts where the cumulative value of pending claims exceeds the currently available balance.

```sql
SELECT 
    ga.account_id,
    g.grant_code,
    ga.category,
    ga.current_balance,
    pending_subquery.pending_total
FROM grant_account ga
JOIN grant_record g ON ga.grant_id = g.grant_id
JOIN LATERAL (
    SELECT COALESCE(SUM(e.amount), 0) AS pending_total
    FROM expenditure e
    WHERE e.account_id = ga.account_id
      AND e.status = 'PENDING'
) pending_subquery ON TRUE
WHERE pending_subquery.pending_total > ga.current_balance;
```
