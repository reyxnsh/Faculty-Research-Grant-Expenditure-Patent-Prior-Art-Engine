# Entity-Relationship (ER) Architecture

## 1. Conceptual Overview & Evolutionary Enhancements

Our initial draft ER diagram captured the foundational core of university research grant administration (Department, Faculty, Grant, Grant Account, Expenditure, Intellectual Property). However, aligning the design with real-world institutional operations and the Level 3 project specifications required eight fundamental structural enhancements:

1. **Authentication Layer (`USERS`)**: Added a dedicated `USERS` entity storing login credentials, password hashes, and system roles (`ADMIN` or `FACULTY`), with a nullable foreign key linking faculty accounts directly to the `FACULTY` profile.
2. **Many-to-Many Authorship (`IP_AUTHOR`)**: Research publications and patents are rarely authored by a single faculty member. Transformed the 1:N `AUTHORS` relationship into an associative entity `IP_AUTHOR` supporting multi-faculty co-authorship with explicit `author_order` and `is_corresponding` flags.
3. **Many-to-Many Grant Association (`GRANT_IP`)**: Interdisciplinary patents and disclosures frequently acknowledge funding from multiple research grants, and a large research grant produces multiple disclosures. Replaced the 1:N link with an associative entity `GRANT_IP`.
4. **Grant Account Allocation (`budget_allocated`)**: Added `budget_allocated` to `GRANT_ACCOUNT` alongside `current_balance`, allowing the database to enforce that the sum of allocated category accounts never exceeds the grant's total approved funding.
5. **Robust Expenditure Approval Lifecycle (`EXPENDITURE`)**: Enhanced expenditures with `submitted_by` (linking to submitting `FACULTY`), `approved_by` (linking to approving `USERS`), an explicit status state machine (`PENDING`, `APPROVED`, `REJECTED`), transaction dates, and descriptions.
6. **Grant Lifecycle Governance (`GRANT`)**: Enhanced `GRANT` with `start_date`, `end_date`, and lifecycle `status` (`ACTIVE`, `CLOSED`, `SUSPENDED`) to prevent expenditures on expired or frozen grants.
7. **Semantic Vector & Full-Text Capabilities (`INTELLECTUAL_PROPERTY`)**: Added full-text `abstract` content, `doc_type` (`PATENT`, `PAPER`, `DRAFT_DISCLOSURE`), `filing_date`, dense `embedding` (`vector(384)`), and full-text search vector (`tsv`).
8. **Automated Audit Trail (`AUDIT_LOG`)**: Added an audit entity populated exclusively by database triggers to record all expenditure status transitions, approver IDs, old/new states, and timestamps.

---

## 2. Final Entity-Relationship Diagram

```mermaid
erDiagram
    DEPARTMENT ||--o{ FACULTY : "employs"
    FACULTY ||--o{ USERS : "authenticates as"
    FACULTY ||--o{ GRANT : "acts as PI for"
    FACULTY ||--o{ EXPENDITURE : "submits"
    FACULTY ||--|{ IP_AUTHOR : "co-authors"
    
    USERS ||--o{ EXPENDITURE : "approves / rejects"
    USERS ||--o{ AUDIT_LOG : "records actions"
    
    GRANT ||--|{ GRANT_ACCOUNT : "partitions into"
    GRANT ||--o{ GRANT_IP : "funds"
    
    GRANT_ACCOUNT ||--o{ EXPENDITURE : "allocates funds for"
    
    INTELLECTUAL_PROPERTY ||--|{ IP_AUTHOR : "authored by"
    INTELLECTUAL_PROPERTY ||--o{ GRANT_IP : "result of"
    
    EXPENDITURE ||--o{ AUDIT_LOG : "generates audit history"

    DEPARTMENT {
        int department_id PK
        string department_name
        string department_code UK
        timestamp created_at
    }

    FACULTY {
        int faculty_id PK
        int department_id FK
        string full_name
        string email UK
        string designation
        timestamp created_at
    }

    USERS {
        int user_id PK
        string email UK
        string password_hash
        string role
        int faculty_id FK "nullable"
        boolean is_active
        timestamp created_at
    }

    GRANT {
        int grant_id PK
        string grant_code UK
        string title
        string funding_agency
        int pi_faculty_id FK
        decimal total_budget
        date start_date
        date end_date
        string status
        timestamp created_at
    }

    GRANT_ACCOUNT {
        int account_id PK
        int grant_id FK
        string category
        decimal budget_allocated
        decimal current_balance
        timestamp created_at
    }

    EXPENDITURE {
        int transaction_id PK
        int account_id FK
        int submitted_by FK
        int approved_by FK "nullable"
        decimal amount
        string description
        string invoice_reference
        date transaction_date
        string status
        timestamp decision_date
        text rejection_reason
        timestamp created_at
    }

    INTELLECTUAL_PROPERTY {
        int document_id PK
        string doc_type
        string title
        text abstract
        date filing_date
        string publication_or_patent_number
        vector_384 embedding
        tsvector tsv
        timestamp created_at
    }

    IP_AUTHOR {
        int document_id PK, FK
        int faculty_id PK, FK
        int author_order
        boolean is_corresponding
    }

    GRANT_IP {
        int grant_id PK, FK
        int document_id PK, FK
        text contribution_details
        timestamp linked_at
    }

    AUDIT_LOG {
        int log_id PK
        string entity_type
        int entity_id
        string action
        jsonb old_state
        jsonb new_state
        int changed_by FK "nullable"
        timestamp timestamp
        text remarks
    }
```

---

## 3. Relationship Specifications, Cardinality & Participation

The table below describes every relationship in the schema, including mapping cardinality, participation constraints (total vs. partial), and business significance:

| Relationship Name | Participating Entities | Cardinality | Participation | Description |
|---|---|:---:|:---:|---|
| **Department Employs Faculty** | `DEPARTMENT` ↔ `FACULTY` | 1 : N | Total (Faculty) / Partial (Department) | Every faculty member must belong to exactly one department (`department_id` NOT NULL). A department can employ zero or more faculty members. |
| **Faculty User Authentication** | `FACULTY` ↔ `USERS` | 1 : 1 (or 0..1) | Partial (Faculty) / Partial (Users) | A faculty member may have at most one user account. Admin user accounts have a `NULL` `faculty_id`. Faculty user accounts must reference a valid `faculty_id`. |
| **Faculty PI for Grant** | `FACULTY` ↔ `GRANT` | 1 : N | Partial (Faculty) / Total (Grant) | Every grant must have exactly one designated Principal Investigator (`pi_faculty_id` NOT NULL). A faculty member can serve as PI on zero or multiple grants. |
| **Grant Partitioned into Accounts** | `GRANT` ↔ `GRANT_ACCOUNT` | 1 : N | Total (Account) / Total (Grant) | Every grant account belongs to exactly one grant (`grant_id` NOT NULL). A grant is partitioned into one or more category accounts (e.g. Equipment, Travel). |
| **Account Allocates for Expenditure** | `GRANT_ACCOUNT` ↔ `EXPENDITURE` | 1 : N | Total (Expenditure) / Partial (Account) | Every expenditure request is billed against exactly one specific grant account. An account may fund zero or more expenditures over time. |
| **Faculty Submits Expenditure** | `FACULTY` ↔ `EXPENDITURE` | 1 : N | Total (Expenditure) / Partial (Faculty) | Every expenditure must be submitted by a verified faculty member (`submitted_by` NOT NULL). |
| **User Approves Expenditure** | `USERS` ↔ `EXPENDITURE` | 1 : N | Partial (Expenditure) / Partial (Users) | When an expenditure is approved or rejected, `approved_by` records the administrator's `user_id`. Pending expenditures have `NULL` `approved_by`. |
| **Faculty Co-Authors IP** | `FACULTY` ↔ `INTELLECTUAL_PROPERTY` | M : N (via `IP_AUTHOR`) | Partial (Faculty) / Total (IP) | An intellectual property record must have at least one co-author (`IP_AUTHOR`). A faculty member can co-author zero or multiple disclosures. The junction table stores `author_order` and `is_corresponding`. |
| **Grant Funds IP** | `GRANT` ↔ `INTELLECTUAL_PROPERTY` | M : N (via `GRANT_IP`) | Partial (Grant) / Partial (IP) | An invention or publication can be funded by zero, one, or multiple research grants. A grant may produce zero or more intellectual property disclosures. |
| **Expenditure Generates Audit Log** | `EXPENDITURE` ↔ `AUDIT_LOG` | 1 : N | Partial (Expenditure) / Partial (Audit Log) | Every change in an expenditure's status triggers an automated record in `AUDIT_LOG`. An expenditure may accumulate multiple audit entries over its lifecycle. |
| **User Recorded in Audit Log** | `USERS` ↔ `AUDIT_LOG` | 1 : N | Partial (Users) / Partial (Audit Log) | The user performing the action is captured in `AUDIT_LOG.changed_by`. System/automated trigger events may record `NULL` or a system user. |
