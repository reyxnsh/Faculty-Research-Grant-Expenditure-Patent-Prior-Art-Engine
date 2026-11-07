-- Up Migration
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

-- Down Migration
DROP INDEX IF EXISTS idx_ip_embedding_hnsw;
DROP INDEX IF EXISTS idx_ip_tsv_gin;
DROP INDEX IF EXISTS idx_audit_entity;
DROP INDEX IF EXISTS idx_grant_ip_document;
DROP INDEX IF EXISTS idx_ip_author_faculty;
DROP INDEX IF EXISTS idx_expenditure_status_date;
DROP INDEX IF EXISTS idx_expenditure_submitted_by;
DROP INDEX IF EXISTS idx_expenditure_account;
DROP INDEX IF EXISTS idx_account_grant;
DROP INDEX IF EXISTS idx_grant_pi;
DROP INDEX IF EXISTS idx_faculty_dept;
