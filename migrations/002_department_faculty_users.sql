-- Up Migration
CREATE TABLE department (
    department_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_name     VARCHAR(150) NOT NULL,
    department_code     VARCHAR(20) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_dept_name UNIQUE (department_name),
    CONSTRAINT uq_dept_code UNIQUE (department_code)
);

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
    CONSTRAINT uq_user_faculty UNIQUE (faculty_id),
    CONSTRAINT chk_user_role CHECK (role IN ('ADMIN', 'FACULTY')),
    CONSTRAINT chk_faculty_role_link CHECK (
        (role = 'FACULTY' AND faculty_id IS NOT NULL) OR
        (role = 'ADMIN')
    ),
    CONSTRAINT fk_user_faculty
        FOREIGN KEY (faculty_id)
        REFERENCES faculty (faculty_id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE
);

-- Down Migration
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS faculty;
DROP TABLE IF EXISTS department;
