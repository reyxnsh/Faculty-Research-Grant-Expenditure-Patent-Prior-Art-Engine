# System Objectives and Requirements Specification

## 1. Project Overview & Problem Statement

University research administration involves two interconnected challenges:
1. **Grant Financial Governance**: Managing sponsored research grants (e.g., from DST, SERB, ISRO, DRDO) requires strict adherence to categorized budgets (equipment, travel, manpower, consumables). Manual expenditure tracking often leads to budget overruns, delayed approvals, compliance violations, and lack of real-time auditability.
2. **Intellectual Property (IP) Discovery & Prior-Art Checking**: Before filing a patent disclosure or publishing research, researchers and university IP cells must verify whether similar inventions or publications already exist within the university's institutional repository to prevent duplication, infringement, and missed commercialization opportunities. Traditional keyword search often fails to capture conceptual and semantic similarities across complex technical disclosures.

The **Faculty Research Grant Expenditure & Patent Prior-Art Engine** solves these challenges by combining:
- A strongly consistent relational database engine (PostgreSQL 16) enforcing business rules, account balance constraints, atomic approvals, and tamper-evident audit trails.
- An integrated vector similarity search engine (pgvector) embedding research disclosures into high-dimensional semantic vector spaces for real-time prior-art discovery.
- A role-based web interface built with Next.js and TypeScript providing secure self-service workflows for faculty and university administrators.

---

## 2. Project Objectives

1. **Relational Budget Enforcement**: Guarantee that research expenditures can never exceed approved category balances through database-level triggers and atomic transactions.
2. **Complete Auditability**: Automatically log every status transition, approver action, and timestamp in an immutable database audit log.
3. **Role-Based Access Control**: Enforce strict separation of duties between University Administrators (`ADMIN`) and Principal Investigators (`FACULTY`).
4. **Semantic Prior-Art Retrieval**: Enable researchers to paste draft technical abstracts and instantly retrieve semantically similar institutional patents and papers using cosine distance over 384-dimensional vector embeddings.
5. **Hybrid Search Capability**: Support both exact keyword matching (via PostgreSQL full-text search `tsvector`) and conceptual similarity matching (via `pgvector`).
6. **Real-Time Financial Analytics**: Provide analytical dashboards for grant burn-down rates, department expenditure distributions, and faculty IP output.

---

## 3. Team Member Division of Responsibilities

As required for 2-member collaborative development, the responsibilities are distributed across database engineering and full-stack application development:

| Team Member | Primary Focus Area | Database Responsibilities | Application Responsibilities |
|---|---|---|---|
| **Member 1 (Lead Database & Backend)** | Database Architecture, Schema Design & Vector Integration | Relational schema (DDL), constraints, PL/pgSQL triggers, transactional stored procedures, pgvector indexing, full-text search triggers. | Next.js API Route Handlers, database connection pooling, vector embedding pipeline (transformers.js), automated DB testing (Vitest). |
| **Member 2 (Lead Frontend & Security)** | User Interface, Authentication & End-to-End Workflows | Audit log data modeling, analytical view queries, seed dataset generation, query optimization. | Next.js App Router UI, role-based route guards, admin dashboards, prior-art search interface, E2E test suite (Playwright). |

---

## 4. Functional Requirements

### 4.1 Department & Faculty Management
- **FR-01**: The system shall maintain departments with unique department codes and names.
- **FR-02**: The system shall register faculty members with academic designations, email addresses, and departmental affiliations.
- **FR-03**: Faculty members can act as Principal Investigators (PI) on multiple research grants and author multiple intellectual property disclosures.

### 4.2 Research Grant Administration
- **FR-04**: Administrators shall create research grants with funding agency details, total approved budget, start date, end date, and an assigned Principal Investigator.
- **FR-05**: Grants shall have an operational status (`ACTIVE`, `CLOSED`, `SUSPENDED`).
- **FR-06**: Each grant shall be partitioned into multiple category accounts (`EQUIPMENT`, `TRAVEL`, `CONSUMABLES`, `MANPOWER`, `CONTINGENCY`, `OVERHEAD`).
- **FR-07**: The sum of allocated budgets across all category accounts belonging to a grant must not exceed the grant's total approved budget (`SUM(budget_allocated) <= total_budget`).

### 4.3 Expenditure Management & Approval Workflow
- **FR-08**: A faculty member (PI) shall submit expenditure requests against specific category accounts of active grants that they manage.
- **FR-09**: Expenditures must specify amount, date, description, invoice reference, and category account.
- **FR-10**: The database shall reject expenditure submissions if the transaction date falls outside the grant's validity window (`start_date` to `end_date`) or if the grant is not `ACTIVE`.
- **FR-11**: Submitted expenditures start in `PENDING` status.
- **FR-12**: Administrators can review, approve, or reject pending expenditures.
- **FR-13**: When an expenditure is approved, the system must atomically deduct the expenditure amount from the account's `current_balance` within a database transaction.
- **FR-14**: An expenditure cannot be approved if the requested amount exceeds the account's available `current_balance`.
- **FR-15**: If an approved expenditure is rejected or reverted by an administrator, the corresponding amount must be refunded back to the account's `current_balance`.
- **FR-16**: Every status change on an expenditure must automatically generate an immutable entry in the `AUDIT_LOG` table via database triggers.

### 4.4 Intellectual Property & Prior-Art Search
- **FR-17**: The system shall record intellectual property disclosures categorized by type (`PATENT`, `PAPER`, `DRAFT_DISCLOSURE`) with title, abstract, filing date, and publication/patent numbers.
- **FR-18**: Multiple faculty members can co-author an intellectual property document, with explicit tracking of author order and corresponding author designation.
- **FR-19**: Intellectual property records can be linked to one or more research grants whose funding produced the invention.
- **FR-20**: The system shall convert document titles and abstracts into 384-dimensional dense vector embeddings using a local embedding model.
- **FR-21**: Researchers shall be able to submit draft abstracts to perform semantic prior-art queries, returning ranked matching records based on cosine distance.
- **FR-22**: Prior-art search results must include matched similarity scores, document metadata, co-author names, affiliated departments, and funding grant details.
- **FR-23**: The system shall also support lexical keyword search over IP titles and abstracts using PostgreSQL `tsvector` and `tsquery`.

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
2. **Concurrency & Atomicity**: Use `SELECT ... FOR UPDATE` row-level locks inside PostgreSQL transactions during expenditure approvals to prevent race conditions and balance overdrafts under concurrent requests.
3. **Performance & Scalability**:
   - Sub-10ms response times for relational lookup and balance checks via B-tree indexing on foreign keys and compound filter columns.
   - Sub-150ms semantic search queries across vector disclosures using Hierarchical Navigable Small World (HNSW) indexing.
4. **Security & Confidentiality**:
   - Passwords hashed using bcrypt/Argon2.
   - HTTP-only session cookies with CSRF mitigation.
   - Zero hard-coded credentials; configuration strictly injected via environment variables.
5. **Maintainability**: Pure relational architecture with co-located vector extensions inside PostgreSQL 16 eliminating multi-database synchronization overhead.
