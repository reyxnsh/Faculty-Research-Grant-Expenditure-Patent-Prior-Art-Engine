-- Up Migration
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

-- Down Migration
DROP TABLE IF EXISTS audit_log;
