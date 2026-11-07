import { describe, it, expect, afterAll } from 'vitest';
import { getAdminPool } from '@/lib/db';
import { withRollback, expectQueryError } from './helpers';

describe('Schema Constraints & Referential Integrity', () => {
  const pool = getAdminPool();

  describe('Referential Integrity & Cascades', () => {
    it('rejects child record when parent does not exist', async () => {
      await withRollback(async (client) => {
        await expectQueryError(
          client,
          "INSERT INTO faculty (department_id, full_name, email, designation) VALUES (999999, 'Test Ghost', 'ghost@univ.edu', 'Professor')",
          [],
          /violates foreign key constraint/i
        );
      });
    });

    it('rejects deletion of a department when faculty members exist (RESTRICT)', async () => {
      await withRollback(async (client) => {
        const deptRes = await client.query(
          "INSERT INTO department (department_name, department_code) VALUES ('Physics', 'PHYS') RETURNING department_id"
        );
        const deptId = deptRes.rows[0].department_id;

        await client.query(
          "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Bohr', 'bohr@univ.edu', 'Professor')",
          [deptId]
        );

        await expectQueryError(
          client,
          'DELETE FROM department WHERE department_id = $1',
          [deptId],
          /violates foreign key constraint/i
        );
      });
    });

    it('cascades deletion from grant_record to grant_account and grant_ip', async () => {
      await withRollback(async (client) => {
        const dept = await client.query(
          "INSERT INTO department (department_name, department_code) VALUES ('Chemistry', 'CHEM') RETURNING department_id"
        );
        const fac = await client.query(
          "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Curie', 'curie@univ.edu', 'Professor') RETURNING faculty_id",
          [dept.rows[0].department_id]
        );
        const grant = await client.query(
          "INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-CASCADE', 'Radiation Study', 'DST', $1, 100000, '2026-01-01', '2027-01-01') RETURNING grant_id",
          [fac.rows[0].faculty_id]
        );
        const grantId = grant.rows[0].grant_id;

        const acc = await client.query(
          "INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'EQUIPMENT', 50000, 50000) RETURNING account_id",
          [grantId]
        );
        const accId = acc.rows[0].account_id;

        const doc = await client.query(
          "INSERT INTO intellectual_property (doc_type, title, abstract) VALUES ('PAPER', 'Radium Paper', 'Analysis of decay') RETURNING document_id"
        );
        const docId = doc.rows[0].document_id;

        await client.query(
          'INSERT INTO grant_ip (grant_id, document_id) VALUES ($1, $2)',
          [grantId, docId]
        );

        // Delete parent grant
        await client.query('DELETE FROM grant_record WHERE grant_id = $1', [grantId]);

        // Verify cascaded deletion within transaction
        const accCheck = await client.query('SELECT * FROM grant_account WHERE account_id = $1', [accId]);
        expect(accCheck.rows.length).toBe(0);

        const linkCheck = await client.query('SELECT * FROM grant_ip WHERE grant_id = $1 AND document_id = $2', [grantId, docId]);
        expect(linkCheck.rows.length).toBe(0);
      });
    });
  });

  describe('Unique Constraints', () => {
    it('enforces uniqueness on department name and code', async () => {
      await withRollback(async (client) => {
        await client.query("INSERT INTO department (department_name, department_code) VALUES ('Civil Eng', 'CIVIL')");

        await expectQueryError(
          client,
          "INSERT INTO department (department_name, department_code) VALUES ('Civil Eng', 'CIVIL2')",
          [],
          /uq_dept_name/i
        );

        await expectQueryError(
          client,
          "INSERT INTO department (department_name, department_code) VALUES ('Civil Engineering', 'CIVIL')",
          [],
          /uq_dept_code/i
        );
      });
    });

    it('enforces uniqueness on faculty email and user email', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('Bio', 'BIO') RETURNING department_id");
        const deptId = dept.rows[0].department_id;

        await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Mendel', 'mendel@univ.edu', 'Professor')", [deptId]);
        await expectQueryError(
          client,
          "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Another Mendel', 'mendel@univ.edu', 'Assistant Professor')",
          [deptId],
          /uq_faculty_email/i
        );

        await client.query("INSERT INTO users (email, password_hash, role) VALUES ('admin@univ.edu', 'hash123', 'ADMIN')");
        await expectQueryError(
          client,
          "INSERT INTO users (email, password_hash, role) VALUES ('admin@univ.edu', 'hash456', 'ADMIN')",
          [],
          /uq_user_email/i
        );
      });
    });

    it('enforces at most one user account per faculty member (uq_user_faculty)', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('Math', 'MATH') RETURNING department_id");
        const fac = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Gauss', 'gauss@univ.edu', 'Professor') RETURNING faculty_id", [dept.rows[0].department_id]);
        const facId = fac.rows[0].faculty_id;

        await client.query("INSERT INTO users (email, password_hash, role, faculty_id) VALUES ('gauss1@univ.edu', 'hash1', 'FACULTY', $1)", [facId]);
        await expectQueryError(
          client,
          "INSERT INTO users (email, password_hash, role, faculty_id) VALUES ('gauss2@univ.edu', 'hash2', 'FACULTY', $1)",
          [facId],
          /uq_user_faculty/i
        );
      });
    });

    it('enforces unique (grant_id, category) on grant_account', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('Aerospace', 'AERO') RETURNING department_id");
        const fac = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Von Braun', 'braun@univ.edu', 'Professor') RETURNING faculty_id", [dept.rows[0].department_id]);
        const grant = await client.query("INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-AERO', 'Rocket Propulsion', 'ISRO', $1, 500000, '2026-01-01', '2027-01-01') RETURNING grant_id", [fac.rows[0].faculty_id]);
        const grantId = grant.rows[0].grant_id;

        await client.query("INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'TRAVEL', 50000, 50000)", [grantId]);
        await expectQueryError(
          client,
          "INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'TRAVEL', 30000, 30000)",
          [grantId],
          /uq_grant_category/i
        );
      });
    });

    it('allows swapping two authors order in a transaction due to DEFERRABLE INITIALLY DEFERRED unique constraint', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('Genetics', 'GEN') RETURNING department_id");
        const deptId = dept.rows[0].department_id;
        const fac1 = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Author One', 'auth1@univ.edu', 'Professor') RETURNING faculty_id", [deptId]);
        const fac2 = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Author Two', 'auth2@univ.edu', 'Professor') RETURNING faculty_id", [deptId]);

        const doc = await client.query("INSERT INTO intellectual_property (doc_type, title, abstract) VALUES ('PAPER', 'CRISPR Gene Editing', 'Abstract on CRISPR') RETURNING document_id");
        const docId = doc.rows[0].document_id;

        // Insert author 1 at order 1, author 2 at order 2
        await client.query("INSERT INTO ip_author (document_id, faculty_id, author_order) VALUES ($1, $2, 1)", [docId, fac1.rows[0].faculty_id]);
        await client.query("INSERT INTO ip_author (document_id, faculty_id, author_order) VALUES ($1, $2, 2)", [docId, fac2.rows[0].faculty_id]);

        // Swap their order within the transaction
        await client.query("UPDATE ip_author SET author_order = 2 WHERE document_id = $1 AND faculty_id = $2", [docId, fac1.rows[0].faculty_id]);
        await client.query("UPDATE ip_author SET author_order = 1 WHERE document_id = $1 AND faculty_id = $2", [docId, fac2.rows[0].faculty_id]);

        // Assert that enforcing immediate constraint checking succeeds because the swap completed
        await client.query("SET CONSTRAINTS uq_doc_author_order IMMEDIATE");

        // Verify final order is swapped
        const check = await client.query("SELECT faculty_id, author_order FROM ip_author WHERE document_id = $1 ORDER BY author_order", [docId]);
        expect(check.rows[0].faculty_id).toBe(fac2.rows[0].faculty_id);
        expect(check.rows[0].author_order).toBe(1);
        expect(check.rows[1].faculty_id).toBe(fac1.rows[0].faculty_id);
        expect(check.rows[1].author_order).toBe(2);
      });
    });

    it('fails when two authors have duplicate author_order and constraints are checked immediate without swap', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('Genetics2', 'GEN2') RETURNING department_id");
        const deptId = dept.rows[0].department_id;
        const fac1 = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Author A', 'autha@univ.edu', 'Professor') RETURNING faculty_id", [deptId]);
        const fac2 = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Author B', 'authb@univ.edu', 'Professor') RETURNING faculty_id", [deptId]);

        const doc = await client.query("INSERT INTO intellectual_property (doc_type, title, abstract) VALUES ('PAPER', 'Gene Study', 'Abstract') RETURNING document_id");
        const docId = doc.rows[0].document_id;

        await client.query("INSERT INTO ip_author (document_id, faculty_id, author_order) VALUES ($1, $2, 1)", [docId, fac1.rows[0].faculty_id]);
        // Duplicate order 1 without subsequent swap
        await client.query("INSERT INTO ip_author (document_id, faculty_id, author_order) VALUES ($1, $2, 1)", [docId, fac2.rows[0].faculty_id]);

        // Setting constraints immediate must reject the duplicate
        await expectQueryError(
          client,
          "SET CONSTRAINTS uq_doc_author_order IMMEDIATE",
          [],
          /uq_doc_author_order/i
        );
      });
    });
  });

  describe('CHECK Constraints and Enums', () => {
    it('validates grant_record budget positive, end_date >= start_date, and status enum', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('EE', 'EE') RETURNING department_id");
        const fac = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Tesla', 'tesla@univ.edu', 'Professor') RETURNING faculty_id", [dept.rows[0].department_id]);
        const facId = fac.rows[0].faculty_id;

        // Negative budget rejected
        await expectQueryError(
          client,
          "INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-NEG', 'Negative', 'DST', $1, -100, '2026-01-01', '2027-01-01')",
          [facId],
          /chk_grant_budget_positive/i
        );

        // Invalid date range rejected
        await expectQueryError(
          client,
          "INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-DATES', 'Dates', 'DST', $1, 1000, '2027-01-01', '2026-01-01')",
          [facId],
          /chk_grant_dates/i
        );

        // Invalid status enum rejected
        await expectQueryError(
          client,
          "INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date, status) VALUES ('GR-STAT', 'Status', 'DST', $1, 1000, '2026-01-01', '2027-01-01', 'UNKNOWN')",
          [facId],
          /chk_grant_status/i
        );
      });
    });

    it('validates user role and faculty link requirement', async () => {
      await withRollback(async (client) => {
        // FACULTY role without faculty_id rejected
        await expectQueryError(
          client,
          "INSERT INTO users (email, password_hash, role, faculty_id) VALUES ('orphan@univ.edu', 'hash', 'FACULTY', NULL)",
          [],
          /chk_faculty_role_link/i
        );

        // Invalid role rejected
        await expectQueryError(
          client,
          "INSERT INTO users (email, password_hash, role) VALUES ('guest@univ.edu', 'hash', 'GUEST')",
          [],
          /(chk_user_role|chk_faculty_role_link)/i
        );
      });
    });

    it('validates grant_account budget allocation non-negative and balance in range', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('ME', 'ME') RETURNING department_id");
        const fac = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Watt', 'watt@univ.edu', 'Professor') RETURNING faculty_id", [dept.rows[0].department_id]);
        const grant = await client.query("INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-ME', 'Steam Engine', 'SERB', $1, 100000, '2026-01-01', '2027-01-01') RETURNING grant_id", [fac.rows[0].faculty_id]);
        const grantId = grant.rows[0].grant_id;

        // Negative budget rejected
        await expectQueryError(
          client,
          "INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'EQUIPMENT', -100, -100)",
          [grantId],
          /chk_budget_allocated_nonnegative/i
        );

        // Current balance > budget_allocated rejected
        await expectQueryError(
          client,
          "INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'EQUIPMENT', 50000, 60000)",
          [grantId],
          /chk_current_balance_range/i
        );

        // Current balance < 0 rejected
        await expectQueryError(
          client,
          "INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'EQUIPMENT', 50000, -1)",
          [grantId],
          /chk_current_balance_range/i
        );
      });
    });

    it('validates expenditure state machine combinations (chk_expenditure_state)', async () => {
      await withRollback(async (client) => {
        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('CS', 'CS') RETURNING department_id");
        const fac = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Turing', 'turing@univ.edu', 'Professor') RETURNING faculty_id", [dept.rows[0].department_id]);
        const adminUser = await client.query("INSERT INTO users (email, password_hash, role) VALUES ('admin_exp@univ.edu', 'hash', 'ADMIN') RETURNING user_id");
        const grant = await client.query("INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-CS', 'Computing Machines', 'SERB', $1, 200000, '2026-01-01', '2027-01-01') RETURNING grant_id", [fac.rows[0].faculty_id]);
        const acc = await client.query("INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'EQUIPMENT', 100000, 100000) RETURNING account_id", [grant.rows[0].grant_id]);

        const facId = fac.rows[0].faculty_id;
        const accId = acc.rows[0].account_id;
        const adminId = adminUser.rows[0].user_id;

        // 1. Valid PENDING
        const validPending = await client.query(
          "INSERT INTO expenditure (account_id, submitted_by, amount, description, status) VALUES ($1, $2, 500, 'Circuit board', 'PENDING') RETURNING transaction_id",
          [accId, facId]
        );
        expect(validPending.rows.length).toBe(1);

        // 2. Invalid PENDING with approved_by non-null
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, submitted_by, approved_by, amount, description, status) VALUES ($1, $2, $3, 500, 'Bad Pending', 'PENDING')",
          [accId, facId, adminId],
          /chk_expenditure_state/i
        );

        // 3. Valid APPROVED
        const validApproved = await client.query(
          "INSERT INTO expenditure (account_id, submitted_by, approved_by, decision_date, amount, description, status) VALUES ($1, $2, $3, NOW(), 500, 'Approved item', 'APPROVED') RETURNING transaction_id",
          [accId, facId, adminId]
        );
        expect(validApproved.rows.length).toBe(1);

        // 4. Invalid APPROVED with approved_by NULL
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, submitted_by, approved_by, decision_date, amount, description, status) VALUES ($1, $2, NULL, NOW(), 500, 'Bad Approved', 'APPROVED')",
          [accId, facId],
          /chk_expenditure_state/i
        );

        // 5. Valid REJECTED
        const validRejected = await client.query(
          "INSERT INTO expenditure (account_id, submitted_by, decision_date, rejection_reason, amount, description, status) VALUES ($1, $2, NOW(), 'Exceeds monthly cap', 500, 'Rejected item', 'REJECTED') RETURNING transaction_id",
          [accId, facId]
        );
        expect(validRejected.rows.length).toBe(1);

        // 6. Invalid REJECTED with rejection_reason NULL
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, submitted_by, decision_date, rejection_reason, amount, description, status) VALUES ($1, $2, NOW(), NULL, 500, 'Bad Rejected', 'REJECTED')",
          [accId, facId],
          /chk_expenditure_state/i
        );
      });
    });

    it('validates intellectual_property doc_type enum and ip_author author_order > 0', async () => {
      await withRollback(async (client) => {
        // Invalid doc_type
        await expectQueryError(
          client,
          "INSERT INTO intellectual_property (doc_type, title, abstract) VALUES ('BLOG_POST', 'Invalid Title', 'Abstract')",
          [],
          /chk_doc_type/i
        );

        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('Design', 'DES') RETURNING department_id");
        const fac = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Designer', 'des@univ.edu', 'Professor') RETURNING faculty_id", [dept.rows[0].department_id]);
        const doc = await client.query("INSERT INTO intellectual_property (doc_type, title, abstract) VALUES ('PATENT', 'Robotic Arm', 'Abstract') RETURNING document_id");

        // Invalid author_order (0 or negative)
        await expectQueryError(
          client,
          "INSERT INTO ip_author (document_id, faculty_id, author_order) VALUES ($1, $2, 0)",
          [doc.rows[0].document_id, fac.rows[0].faculty_id],
          /chk_author_order_positive/i
        );
      });
    });
  });

  describe('NOT NULL Constraints', () => {
    it('rejects NULL for representative required columns across entities', async () => {
      await withRollback(async (client) => {
        // 1. department.department_name
        await expectQueryError(
          client,
          "INSERT INTO department (department_name, department_code) VALUES (NULL, 'NN_CODE')",
          [],
          /null value in column "department_name"/i
        );

        const dept = await client.query("INSERT INTO department (department_name, department_code) VALUES ('NN Dept', 'NND') RETURNING department_id");
        const deptId = dept.rows[0].department_id;

        // 2. faculty.email
        await expectQueryError(
          client,
          "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Null', NULL, 'Professor')",
          [deptId],
          /null value in column "email"/i
        );

        const fac = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Valid', 'valid@univ.edu', 'Professor') RETURNING faculty_id", [deptId]);
        const facId = fac.rows[0].faculty_id;

        // 3. grant_record.total_budget
        await expectQueryError(
          client,
          "INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-NN', 'Null Budget', 'Agency', $1, NULL, '2026-01-01', '2027-01-01')",
          [facId],
          /null value in column "total_budget"/i
        );

        const grant = await client.query("INSERT INTO grant_record (grant_code, title, funding_agency, pi_faculty_id, total_budget, start_date, end_date) VALUES ('GR-NN', 'Valid Grant', 'Agency', $1, 100000, '2026-01-01', '2027-01-01') RETURNING grant_id", [facId]);
        const grantId = grant.rows[0].grant_id;
        const acc = await client.query("INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'TRAVEL', 50000, 50000) RETURNING account_id", [grantId]);
        const accId = acc.rows[0].account_id;

        // 4. expenditure.description
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, submitted_by, amount, description, status) VALUES ($1, $2, 500, NULL, 'PENDING')",
          [accId, facId],
          /null value in column "description"/i
        );

        // 5. intellectual_property.abstract
        await expectQueryError(
          client,
          "INSERT INTO intellectual_property (doc_type, title, abstract) VALUES ('PAPER', 'Title', NULL)",
          [],
          /null value in column "abstract"/i
        );
      });
    });
  });

  afterAll(async () => {
    // Assert all domain tables remain strictly empty after rollback discipline
    const domainTables = [
      'expenditure',
      'grant_account',
      'grant_ip',
      'ip_author',
      'intellectual_property',
      'grant_record',
      'users',
      'faculty',
      'department',
      'audit_log',
    ];
    for (const table of domainTables) {
      const res = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      expect(res.rows[0].count).toBe(0);
    }
  });
});
