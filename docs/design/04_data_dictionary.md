# Data Dictionary

This document details the metadata, column definitions, data types, integrity constraints, and operational meanings for each entity in the database schema.

---

## 1. Table: `department`
Represents academic departments employing faculty and managing research programs.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `department_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key identifying the department. |
| `department_name` | `VARCHAR(150)` | `NOT NULL`, `UNIQUE (uq_dept_name)` | Full formal name of the department (e.g., "Computer Science and Engineering"). |
| `department_code` | `VARCHAR(20)` | `NOT NULL`, `UNIQUE (uq_dept_code)` | Standard university department acronym (e.g., "CSE", "ECE", "MECH"). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | System timestamp when the department record was created. |

---

## 2. Table: `faculty`
Stores academic faculty profiles who serve as grant Principal Investigators or IP authors.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `faculty_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key identifying the faculty member. |
| `department_id` | `INT` | `NOT NULL`, `FK -> department(department_id) ON DELETE RESTRICT` | Department to which the faculty member belongs. |
| `full_name` | `VARCHAR(150)` | `NOT NULL` | Full academic name including titles (e.g., "Dr. Aditi Sharma"). |
| `email` | `VARCHAR(255)` | `NOT NULL`, `UNIQUE (uq_faculty_email)` | Institutional email address used for contact and user account linkage. |
| `designation` | `VARCHAR(100)` | `NOT NULL` | Academic appointment (e.g., "Professor", "Associate Professor", "Assistant Professor"). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | System timestamp when the faculty profile was created. |

---

## 3. Table: `users`
Maintains credentials, session identities, and access control roles for system authentication.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `user_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key for the user account. |
| `email` | `VARCHAR(255)` | `NOT NULL`, `UNIQUE (uq_user_email)` | User login username (matches institutional email). |
| `password_hash` | `VARCHAR(255)` | `NOT NULL` | Cryptographic password hash (bcrypt / argon2id). |
| `role` | `VARCHAR(20)` | `NOT NULL`, `CHECK (role IN ('ADMIN', 'FACULTY'))` | Role governing authorization and dashboard permissions. |
| `faculty_id` | `INT` | `NULLABLE`, `FK -> faculty(faculty_id) ON DELETE SET NULL` | Reference to faculty profile. Must be non-null when `role = 'FACULTY'`. |
| `is_active` | `BOOLEAN` | `NOT NULL`, `DEFAULT TRUE` | Flag indicating whether the account is currently enabled. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Account creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Last profile update timestamp. |

---

## 4. Table: `grant_record`
Stores sponsored research grants awarded to the university.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `grant_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key for the grant. |
| `grant_code` | `VARCHAR(50)` | `NOT NULL`, `UNIQUE (uq_grant_code)` | Official grant identifier (e.g., "DST-SERB-2024-CRG-014"). |
| `title` | `VARCHAR(300)` | `NOT NULL` | Approved research project title. |
| `funding_agency` | `VARCHAR(200)` | `NOT NULL` | Sponsoring organization (e.g., "DST", "ISRO", "DRDO", "DBT"). |
| `pi_faculty_id` | `INT` | `NOT NULL`, `FK -> faculty(faculty_id) ON DELETE RESTRICT` | Faculty member designated as Principal Investigator. |
| `total_budget` | `NUMERIC(14, 2)` | `NOT NULL`, `CHECK (total_budget > 0)` | Total sanctioned funding amount in Indian Rupees (INR). |
| `start_date` | `DATE` | `NOT NULL` | Official project commencement date. |
| `end_date` | `DATE` | `NOT NULL`, `CHECK (end_date >= start_date)` | Scheduled project termination date. |
| `status` | `VARCHAR(20)` | `NOT NULL`, `DEFAULT 'ACTIVE'`, `CHECK (status IN ('ACTIVE', 'CLOSED', 'SUSPENDED'))` | Operational lifecycle status of the research grant. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the grant record was entered. |

---

## 5. Table: `grant_account`
Represents budget line-item partitions (heads) within a research grant.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `account_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key for the grant account. |
| `grant_id` | `INT` | `NOT NULL`, `FK -> grant_record(grant_id) ON DELETE CASCADE` | Grant to which this budget account belongs. |
| `category` | `VARCHAR(50)` | `NOT NULL`, `CHECK (category IN ('EQUIPMENT', 'TRAVEL', 'CONSUMABLES', 'MANPOWER', 'CONTINGENCY', 'OVERHEAD'))` | Category allocation head. |
| `budget_allocated` | `NUMERIC(14, 2)` | `NOT NULL`, `CHECK (budget_allocated >= 0)` | Sanctioned budget allocated to this category. |
| `current_balance` | `NUMERIC(14, 2)` | `NOT NULL`, `CHECK (current_balance >= 0 AND current_balance <= budget_allocated)` | Remaining balance available for expenditure; updated atomically via triggers/procedures. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the category account was initialized. |

*Table-level constraint*: `UNIQUE (grant_id, category)` ensures a grant has at most one account per category.

---

## 6. Table: `expenditure`
Tracks individual expenditure requests billed against specific grant accounts.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `transaction_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key for the expenditure transaction. |
| `account_id` | `INT` | `NOT NULL`, `FK -> grant_account(account_id) ON DELETE RESTRICT` | Account line item debited by this expense. |
| `submitted_by` | `INT` | `NOT NULL`, `FK -> faculty(faculty_id) ON DELETE RESTRICT` | Faculty member who filed the expenditure claim. |
| `approved_by` | `INT` | `NULLABLE`, `FK -> users(user_id) ON DELETE SET NULL` | Administrator user who approved/rejected the claim. |
| `amount` | `NUMERIC(12, 2)` | `NOT NULL`, `CHECK (amount > 0)` | Billed expense amount in INR. |
| `description` | `TEXT` | `NOT NULL` | Justification and itemized explanation for the expenditure. |
| `invoice_reference` | `VARCHAR(100)` | `NULLABLE` | Bill/invoice number from vendor or supplier. |
| `transaction_date` | `DATE` | `NOT NULL`, `DEFAULT CURRENT_DATE` | Date the expense was incurred. |
| `status` | `VARCHAR(20)` | `NOT NULL`, `DEFAULT 'PENDING'`, `CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))` | Workflow state of the expenditure. |
| `decision_date` | `TIMESTAMPTZ` | `NULLABLE` | Timestamp when administrator approved or rejected the request. |
| `rejection_reason` | `TEXT` | `NULLABLE` | Administrator's reason if the claim was rejected. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Record creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Record last updated timestamp. |

---

## 7. Table: `intellectual_property`
Stores patent disclosures, published papers, and research disclosures, along with semantic vector embeddings.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `document_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key for the IP document. |
| `doc_type` | `VARCHAR(30)` | `NOT NULL`, `CHECK (doc_type IN ('PATENT', 'PAPER', 'DRAFT_DISCLOSURE'))` | Type of research disclosure. |
| `title` | `VARCHAR(400)` | `NOT NULL` | Formal title of the patent disclosure or research paper. |
| `abstract` | `TEXT` | `NOT NULL` | Full technical abstract or disclosure summary; basis for vector embedding. |
| `filing_date` | `DATE` | `NOT NULL`, `DEFAULT CURRENT_DATE` | Filing date for patents or publication date for papers. |
| `publication_or_patent_number` | `VARCHAR(100)` | `NULLABLE` | Official registry number (e.g., "IN-PAT-2024-410291"). |
| `embedding` | `vector(384)` | `NULLABLE` | Dense 384-dimensional vector embedding generated via `all-MiniLM-L6-v2`. |
| `tsv` | `tsvector` | `NULLABLE` | PostgreSQL text search vector combining weighted title (weight A) and abstract (weight B). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when disclosure was registered. |

---

## 8. Table: `ip_author`
Associative junction table establishing many-to-many authorship between faculty and IP disclosures.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `document_id` | `INT` | `NOT NULL`, `FK -> intellectual_property(document_id) ON DELETE CASCADE` | Disclosed document identifier. |
| `faculty_id` | `INT` | `NOT NULL`, `FK -> faculty(faculty_id) ON DELETE RESTRICT` | Co-authoring faculty member identifier. |
| `author_order` | `INT` | `NOT NULL`, `CHECK (author_order > 0)` | Sequence position in author list (1 = Primary Author, 2 = Second, etc.). |
| `is_corresponding` | `BOOLEAN` | `NOT NULL`, `DEFAULT FALSE` | Indicates whether this author is the primary contact/corresponding author. |

*Composite Primary Key*: `(document_id, faculty_id)`.
*Uniqueness Constraint*: `UNIQUE (document_id, author_order)` prevents two authors having the same rank on a single paper.

---

## 9. Table: `grant_ip`
Associative junction table linking research grants to the intellectual property generated by their funding.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `grant_id` | `INT` | `NOT NULL`, `FK -> grant_record(grant_id) ON DELETE CASCADE` | Funding research grant identifier. |
| `document_id` | `INT` | `NOT NULL`, `FK -> intellectual_property(document_id) ON DELETE CASCADE` | Intellectual property document identifier. |
| `contribution_details` | `TEXT` | `NULLABLE` | Narrative describing how grant funds directly supported this invention. |
| `linked_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the grant acknowledgment was recorded. |

*Composite Primary Key*: `(grant_id, document_id)`.

---

## 10. Table: `audit_log`
Immutable historical log of critical domain events, status transitions, and approver actions.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `log_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique surrogate key for the audit record. |
| `entity_type` | `VARCHAR(50)` | `NOT NULL`, `DEFAULT 'EXPENDITURE'` | Name of the entity undergoing change. |
| `entity_id` | `INT` | `NOT NULL` | Primary key value of the audited entity (e.g., `transaction_id`). |
| `action` | `VARCHAR(50)` | `NOT NULL` | Description of action (e.g., `STATUS_UPDATE`, `APPROVE`, `REJECT`, `REVERT`). |
| `old_state` | `JSONB` | `NULLABLE` | JSON snapshot of modified record fields before the transaction. |
| `new_state` | `JSONB` | `NULLABLE` | JSON snapshot of modified record fields after the transaction. |
| `changed_by` | `INT` | `NULLABLE`, `FK -> users(user_id) ON DELETE SET NULL` | Identifier of the authenticated user who initiated the change. |
| `timestamp` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Immutable server timestamp of the action. |
| `remarks` | `TEXT` | `NULLABLE` | Contextual notes, reason for rejection, or automated trigger commentary. |
