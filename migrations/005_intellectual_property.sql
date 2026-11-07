-- Up Migration
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

-- Down Migration
DROP TABLE IF EXISTS grant_ip;
DROP TABLE IF EXISTS ip_author;
DROP TABLE IF EXISTS intellectual_property;
