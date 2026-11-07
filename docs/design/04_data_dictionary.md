# Data Dictionary

This document details the metadata, column definitions, data types, integrity constraints, and operational meanings for each entity in the database schema.

---

## 1. Table: `department`
Represents academic departments employing faculty and managing research programs.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `department_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the department. |
| `department_name` | `VARCHAR(150)` | `NOT NULL`, `UNIQUE (uq_dept_name)` | Full formal name of the department (e.g., "Computer Science and Engineering"). |
| `department_code` | `VARCHAR(20)` | `NOT NULL`, `UNIQUE (uq_dept_code)` | University department acronym (e.g., "CSE", "ECE", "MECH"). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the department record was created. |

---

## 2. Table: `faculty`
Stores academic faculty profiles who serve as grant Principal Investigators or IP authors.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `faculty_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the faculty member. |
| `department_id` | `INT` | `NOT NULL`, `FK -> department(department_id) ON DELETE RESTRICT` | Department to which the faculty member belongs. |
| `full_name` | `VARCHAR(150)` | `NOT NULL` | Full academic name (e.g., "Dr. Aditi Sharma"). |
| `email` | `VARCHAR(255)` | `NOT NULL`, `UNIQUE (uq_faculty_email)` | Institutional email address used for contact and login account linkage. |
| `designation` | `VARCHAR(100)` | `NOT NULL` | Academic appointment (e.g., "Professor", "Associate Professor", "Assistant Professor"). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the faculty profile was created. |

---

## 3. Table: `users`
Maintains credentials, session identities, and access control roles for system authentication.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `user_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the user account. |
| `email` | `VARCHAR(255)` | `NOT NULL`, `UNIQUE (uq_user_email)`, `CHECK (chk_user_email_lowercase)` | User login username (institutional email, strictly lowercase). |
| `password_hash` | `VARCHAR(255)` | `NOT NULL` | Password hash (Node.js crypto.scrypt with salt and parameters). |
| `role` | `VARCHAR(20)` | `NOT NULL`, `CHECK (role IN ('ADMIN', 'FACULTY'))` | Role governing system permissions. |
| `faculty_id` | `INT` | `NULLABLE`, `UNIQUE (uq_user_faculty)`, `FK -> faculty(faculty_id) ON DELETE RESTRICT` | Reference to faculty profile. Must be non-null when `role = 'FACULTY'`. Each faculty profile links to at most one user account. |
| `is_active` | `BOOLEAN` | `NOT NULL`, `DEFAULT TRUE` | Indicates whether the account is active. Users are deactivated, never deleted. |
| `failed_login_count` | `INT` | `NOT NULL`, `DEFAULT 0`, `CHECK (failed_login_count >= 0)` | Consecutive failed authentication attempts; triggers lockout at 5. |
| `locked_until` | `TIMESTAMPTZ` | `NULLABLE` | Timestamp until which the account is temporarily locked due to excessive failed attempts. |
| `last_login_at` | `TIMESTAMPTZ` | `NULLABLE` | Timestamp of the most recent successful authentication. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Account creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Last profile update timestamp. |

*Table-level constraints*: `chk_faculty_role_link` ensures `FACULTY` accounts link to a faculty profile, `chk_failed_login_count_nonnegative` ensures counter is non-negative, and `chk_user_email_lowercase` enforces canonical lowercasing.

---

## 4. Table: `grant_record`
Stores sponsored research grants awarded to the university.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `grant_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the grant. |
| `grant_code` | `VARCHAR(50)` | `NOT NULL`, `UNIQUE (uq_grant_code)` | Official grant identifier (e.g., "DST-SERB-2024-CRG-014"). |
| `title` | `VARCHAR(300)` | `NOT NULL` | Approved research project title. |
| `funding_agency` | `VARCHAR(200)` | `NOT NULL` | Sponsoring agency (e.g., "DST", "ISRO", "DRDO", "DBT"). |
| `pi_faculty_id` | `INT` | `NOT NULL`, `FK -> faculty(faculty_id) ON DELETE RESTRICT` | Faculty member designated as Principal Investigator. |
| `total_budget` | `NUMERIC(14, 2)` | `NOT NULL`, `CHECK (total_budget > 0)` | Sanctioned grant funding amount in INR. Cannot be lowered below the sum of allocated budgets. |
| `start_date` | `DATE` | `NOT NULL` | Project start date. |
| `end_date` | `DATE` | `NOT NULL`, `CHECK (end_date >= start_date)` | Project end date. |
| `status` | `VARCHAR(20)` | `NOT NULL`, `DEFAULT 'ACTIVE'`, `CHECK (status IN ('ACTIVE', 'CLOSED', 'SUSPENDED'))` | Lifecycle status of the grant. Only ACTIVE grants accept expenditures. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the grant was recorded. |

---

## 5. Table: `grant_account`
Represents budget category heads within a research grant.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `account_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the grant account. |
| `grant_id` | `INT` | `NOT NULL`, `FK -> grant_record(grant_id) ON DELETE CASCADE` | Grant to which this budget account belongs. Immutable once created. |
| `category` | `VARCHAR(50)` | `NOT NULL`, `CHECK (category IN ('EQUIPMENT', 'TRAVEL', 'CONSUMABLES', 'MANPOWER', 'CONTINGENCY', 'OVERHEAD'))` | Category allocation head. |
| `budget_allocated` | `NUMERIC(14, 2)` | `NOT NULL`, `CHECK (budget_allocated >= 0)` | Sanctioned budget allocated to this category. Changes shift `current_balance` by the same delta. |
| `current_balance` | `NUMERIC(14, 2)` | `NOT NULL`, `CHECK (current_balance >= 0 AND current_balance <= budget_allocated)` | Remaining balance. Initialized to `budget_allocated` on insert. Maintained exclusively by database triggers; direct external updates are rejected. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the category account was initialized. |

*Table-level constraint*: `UNIQUE (grant_id, category)` ensures a grant has at most one account per category.

---

## 6. Table: `expenditure`
Tracks individual expenditure requests billed against specific grant accounts.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `transaction_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the transaction. |
| `account_id` | `INT` | `NOT NULL`, `FK -> grant_account(account_id) ON DELETE RESTRICT` | Account debited by this expense. Immutable once submitted. |
| `submitted_by` | `INT` | `NOT NULL`, `FK -> faculty(faculty_id) ON DELETE RESTRICT` | Faculty PI who submitted the claim. Immutable once submitted. |
| `approved_by` | `INT` | `NULLABLE`, `FK -> users(user_id) ON DELETE RESTRICT` | Administrator who approved the claim. Must be NULL when PENDING, required when APPROVED. Frozen once decided. |
| `amount` | `NUMERIC(12, 2)` | `NOT NULL`, `CHECK (amount > 0)` | Billed expense in INR. Editable only while in PENDING status. Frozen once decided. |
| `description` | `TEXT` | `NOT NULL` | Description and justification for the expense. Frozen once decided. |
| `invoice_reference` | `VARCHAR(100)` | `NULLABLE` | Bill or invoice number from the vendor. Frozen once decided. |
| `transaction_date` | `DATE` | `NOT NULL`, `DEFAULT CURRENT_DATE` | Date the expense was incurred. Must fall within the grant start and end dates. |
| `status` | `VARCHAR(20)` | `NOT NULL`, `DEFAULT 'PENDING'`, `CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))` | Workflow state. Must be PENDING on INSERT. Transitions enforced by trigger: PENDING->APPROVED, PENDING->REJECTED, APPROVED->REJECTED. |
| `decision_date` | `TIMESTAMPTZ` | `NULLABLE` | Timestamp of approval or rejection. Must be NULL when PENDING, required when APPROVED or REJECTED. Frozen once decided. |
| `rejection_reason` | `TEXT` | `NULLABLE` | Reason given by administrator if rejected. Required when REJECTED. Frozen once decided. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Record creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Record last updated timestamp. |

*Table-level constraint*: `chk_expenditure_state` ties status, approver, decision date, and rejection reason into a consistent state machine.

---

## 7. Table: `intellectual_property`
Stores patent disclosures, published papers, and research disclosures, along with vector embeddings.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `document_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the IP document. |
| `doc_type` | `VARCHAR(30)` | `NOT NULL`, `CHECK (doc_type IN ('PATENT', 'PAPER', 'DRAFT_DISCLOSURE'))` | Type of research disclosure. |
| `title` | `VARCHAR(400)` | `NOT NULL` | Formal title of the patent disclosure or research paper. |
| `abstract` | `TEXT` | `NOT NULL` | Full technical abstract; concatenated with title for vector embedding. |
| `filing_date` | `DATE` | `NOT NULL`, `DEFAULT CURRENT_DATE` | Filing date for patents or publication date for papers. |
| `publication_or_patent_number` | `VARCHAR(100)` | `NULLABLE` | Official registry number (e.g., "IN-PAT-2024-410291"). |
| `embedding` | `vector(384)` | `NULLABLE` | Dense 384-dimensional vector embedding generated via `all-MiniLM-L6-v2`. |
| `tsv` | `tsvector` | `NULLABLE` | Full-text search vector combining weighted title (weight A) and abstract (weight B). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when disclosure was recorded. |

---

## 8. Table: `ip_author`
Associative junction table establishing many-to-many authorship between faculty and IP disclosures.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `document_id` | `INT` | `NOT NULL`, `FK -> intellectual_property(document_id) ON DELETE CASCADE` | Disclosed document identifier. |
| `faculty_id` | `INT` | `NOT NULL`, `FK -> faculty(faculty_id) ON DELETE RESTRICT` | Co-authoring faculty member identifier. |
| `author_order` | `INT` | `NOT NULL`, `CHECK (author_order > 0)` | Sequence position in author list (1 = Primary, 2 = Second, etc.). |
| `is_corresponding` | `BOOLEAN` | `NOT NULL`, `DEFAULT FALSE` | Indicates whether this author is the corresponding author. |

*Composite Primary Key*: `(document_id, faculty_id)`.
*Uniqueness Constraint*: `UNIQUE (document_id, author_order) DEFERRABLE INITIALLY DEFERRED` ensures unique author positions while permitting in-transaction sequence reordering.

---

## 9. Table: `grant_ip`
Associative junction table linking research grants to the intellectual property produced through their funding.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `grant_id` | `INT` | `NOT NULL`, `FK -> grant_record(grant_id) ON DELETE CASCADE` | Funding research grant identifier. |
| `document_id` | `INT` | `NOT NULL`, `FK -> intellectual_property(document_id) ON DELETE CASCADE` | Intellectual property document identifier. |
| `contribution_details` | `TEXT` | `NULLABLE` | Details of how grant funds supported this invention. |
| `linked_at` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp when the link was recorded. |

*Composite Primary Key*: `(grant_id, document_id)`.

---

## 10. Table: `audit_log`
Append-only log of domain events, status transitions, and administrator actions. Updates, deletes, and truncates are blocked by triggers. Connected applications operate under a restricted `app_user` role holding only SELECT and INSERT privileges.

| Column Name | PostgreSQL Data Type | Constraints | Description |
|---|---|---|---|
| `log_id` | `INT` | `GENERATED ALWAYS AS IDENTITY`, `PRIMARY KEY` | Unique identifier for the audit record. |
| `entity_type` | `VARCHAR(50)` | `NOT NULL`, `DEFAULT 'EXPENDITURE'` | Name of the entity undergoing change. |
| `entity_id` | `INT` | `NOT NULL` | Primary key value of the audited entity (e.g., `transaction_id`). |
| `action` | `VARCHAR(50)` | `NOT NULL` | Action performed (`CREATED`, `STATUS_CHANGE_APPROVED`, `STATUS_CHANGE_REJECTED`). |
| `old_state` | `JSONB` | `NULLABLE` | Snapshot of modified fields before the change (includes status, amount, approved_by, decision_date). |
| `new_state` | `JSONB` | `NULLABLE` | Snapshot of modified fields after the change. |
| `changed_by` | `INT` | `NULLABLE`, `FK -> users(user_id) ON DELETE RESTRICT` | Identifier of the user who initiated the change. For creation, records the submitting faculty's user where known. |
| `timestamp` | `TIMESTAMPTZ` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Timestamp of the event. |
| `remarks` | `TEXT` | `NULLABLE` | Contextual notes, rejection reasons, or trigger commentary. |
