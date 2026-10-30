# System Objectives and Requirements Specification

## 1. Project Overview & Problem Statement

University research administration involves two connected challenges:
1. **Grant Financial Governance**: Managing sponsored research grants (such as those from DST, SERB, ISRO, and DRDO) requires following category budgets (equipment, travel, manpower, consumables). Manual expenditure tracking often leads to budget overruns, delayed approvals, compliance issues, and a lack of clear audit trails.
2. **Intellectual Property (IP) Discovery & Prior-Art Checking**: Before filing a patent disclosure or publishing a paper, researchers and the university IP cell need to check whether similar inventions or publications already exist within the university repository. Traditional keyword search often misses conceptual similarities across technical disclosures.

The **Faculty Research Grant Expenditure & Patent Prior-Art Engine** addresses these issues through:
- A relational database (PostgreSQL 16) that enforces business rules, account balance constraints, atomic approvals, and an audit trail.
- An integrated vector similarity search engine using pgvector that embeds research disclosures into vector space for prior-art discovery.
- A role-based web interface built with Next.js and TypeScript providing self-service workflows for faculty and administrators.

---

## 2. Project Objectives

1. **Relational Budget Enforcement**: Ensure that research expenditures never exceed approved category balances through database triggers and transactions.
2. **Auditability**: Automatically log every status change, approver action, and timestamp in an audit log table protected against modification or deletion.
3. **Role-Based Access Control**: Enforce separation between university administrators (`ADMIN`) and principal investigators (`FACULTY`).
4. **Semantic Prior-Art Retrieval**: Allow researchers to paste draft technical abstracts and retrieve similar institutional patents and papers using cosine distance over 384-dimensional vector embeddings.
5. **Hybrid Search Capability**: Support both keyword search (via PostgreSQL full-text search `tsvector`) and conceptual similarity matching (via `pgvector`).
6. **Financial Analytics**: Provide summary views for grant burn rates, department expenditure distributions, and faculty IP output.

---

## 3. Team Division of Responsibilities

| Member | SRN | Responsibilities |
|---|---|---|
| Reyansh | PES2UG24CS401 | Project setup, triggers/stored procedures/views, vector similarity search, test suites |
| Samanvith Kashyap | PES2UG24CS432 | Schema and constraints, authentication and role-based access, API routes and queries |
| Both | | Next.js interface, end-to-end tests, documentation |

---

## 4. Functional Requirements

### 4.1 Department & Faculty Management
- **FR-01**: The system maintains departments with unique department codes and names.
- **FR-02**: The system registers faculty members with academic designations, email addresses, and departmental affiliations.
- **FR-03**: Faculty members can act as Principal Investigators (PI) on multiple research grants and author multiple intellectual property disclosures.

### 4.2 Research Grant Administration
- **FR-04**: Administrators create research grants with funding agency details, total approved budget, start date, end date, and an assigned Principal Investigator.
- **FR-05**: Grants have an operational status (`ACTIVE`, `CLOSED`, `SUSPENDED`).
- **FR-06**: Each grant is partitioned into category accounts (`EQUIPMENT`, `TRAVEL`, `CONSUMABLES`, `MANPOWER`, `CONTINGENCY`, `OVERHEAD`).
- **FR-07**: The sum of allocated budgets across all category accounts belonging to a grant cannot exceed the grant's total approved budget (`SUM(budget_allocated) <= total_budget`).

### 4.3 Expenditure Management & Approval Workflow
- **FR-08**: A faculty member (PI) submits expenditure requests against specific category accounts of active grants that they manage.
- **FR-09**: Expenditures specify amount, date, description, invoice reference, and category account. The account is immutable once submitted, and the amount can only be edited while in `PENDING` status.
- **FR-10**: The database rejects expenditure submissions if the transaction date falls outside the grant's validity window (`start_date` to `end_date`) or if the grant is not `ACTIVE`.
- **FR-11**: Submitted expenditures start in `PENDING` status with empty approver and decision date fields.
- **FR-12**: Administrators can review, approve, or reject pending expenditures, or revert previously approved expenditures to rejected.
- **FR-13**: When an expenditure status changes to `APPROVED`, database triggers deduct the expenditure amount from the account's `current_balance`.
- **FR-14**: An expenditure cannot transition to `APPROVED` if the requested amount exceeds the account's available `current_balance` or if the grant is not `ACTIVE`.
- **FR-15**: If an approved expenditure is reverted to `REJECTED`, the deducted amount is restored to the account's `current_balance` by database triggers.
- **FR-16**: Every status change on an expenditure automatically generates an entry in the `audit_log` table via database triggers. The audit log table rejects all updates and deletes.

### 4.4 Intellectual Property & Prior-Art Search
- **FR-17**: The system records intellectual property disclosures categorized by type (`PATENT`, `PAPER`, `DRAFT_DISCLOSURE`) with title, abstract, filing date, and publication/patent numbers.
- **FR-18**: Multiple faculty members can co-author an intellectual property document, with explicit tracking of author order and corresponding author designation.
- **FR-19**: Intellectual property records can be linked to one or more research grants whose funding produced the invention.
- **FR-20**: The system converts document text (title and abstract) into 384-dimensional dense vector embeddings using a local embedding model (`@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2`).
- **FR-21**: Researchers can submit draft abstracts to perform semantic prior-art queries, returning ranked matching records based on cosine distance.
- **FR-22**: Prior-art search results include similarity scores, document metadata, co-author names, affiliated departments, and funding grant details.
- **FR-23**: The system also supports keyword search over IP titles and abstracts using PostgreSQL `tsvector` and `tsquery`.

---

## 5. Role Permission Matrix (RBAC)

The system defines two primary roles:
- **`ADMIN`**: University Research & Grants Office administrator.
- **`FACULTY`**: University professor or researcher serving as PI or co-author.

| Feature / Action | Anonymous | Faculty (PI / Co-Author) | Administrator |
|---|:---:|:---:|:---:|
| **Authentication (Login/Logout)** | Yes | Yes | Yes |
| **View Own Grants & Balances** | No | Yes (Only where PI) | Yes (All Grants) |
| **Create New Grant** | No | No | Yes |
| **Allocate Category Accounts** | No | No | Yes |
| **Submit Expenditure Request** | No | Yes (Only for own active grants) | No |
| **View Expenditure Requests** | No | Yes (Own grants only) | Yes (All University grants) |
| **Approve / Reject Expenditure** | No | No | Yes |
| **View Audit Logs** | No | No | Yes |
| **Register IP Disclosure** | No | Yes | Yes |
| **Execute Prior-Art Semantic Search** | No | Yes | Yes |
| **Full-Text Lexical Search** | No | Yes | Yes |
| **Financial & IP Summary Reports** | No | Yes (Own portfolio) | Yes (University-wide) |

---

## 6. Non-Functional Requirements

1. **Data Integrity & Consistency**: Enforce business rules at the schema level through CHECK constraints, foreign key referential actions, and PL/pgSQL triggers, ensuring invalid data cannot enter the database even if API validation is bypassed.
2. **Concurrency & Atomicity**: Use row-level locks inside PostgreSQL transactions during expenditure approvals and account allocations to prevent race conditions and balance overdrafts under concurrent requests.
3. **Performance Targets**:
   - Aim for low-latency relational lookup and balance checks via B-tree indexing on foreign keys and compound filter columns.
   - Maintain fast semantic search queries across vector disclosures using Hierarchical Navigable Small World (HNSW) indexing.
4. **Security & Confidentiality**:
   - Passwords hashed using bcrypt or argon2.
   - HTTP-only session cookies with CSRF mitigation.
   - Zero hard-coded credentials; configuration strictly injected via environment variables.
5. **Simplicity**: Pure relational architecture with co-located vector extensions inside PostgreSQL 16 eliminating multi-database synchronization overhead.
