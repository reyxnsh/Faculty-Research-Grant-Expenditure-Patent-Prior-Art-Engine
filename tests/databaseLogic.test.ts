import { describe, it, expect } from 'vitest';
import { PoolClient } from 'pg';
import { withRollback, expectQueryError } from './helpers';

describe('Database Logic: Triggers, Routines, Views and Full-Text Search', () => {
  // Helper to seed a standard fixture for trigger and workflow testing
  async function seedTestEnvironment(client: PoolClient) {
    // 1. Department
    const deptRes = await client.query(
      "INSERT INTO department (department_name, department_code) VALUES ('Computer Science', 'CS') RETURNING department_id"
    );
    const deptId = deptRes.rows[0].department_id;

    // 2. Faculty (PI and Collaborator)
    const piRes = await client.query(
      "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Alan Turing', 'turing@univ.edu', 'PROFESSOR') RETURNING faculty_id",
      [deptId]
    );
    const piFacultyId = piRes.rows[0].faculty_id;

    const otherFacultyRes = await client.query(
      "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Grace Hopper', 'hopper@univ.edu', 'ASSOCIATE_PROFESSOR') RETURNING faculty_id",
      [deptId]
    );
    const otherFacultyId = otherFacultyRes.rows[0].faculty_id;

    // 3. Users: Admin, Inactive Admin, Faculty (emails unique)
    const adminUserRes = await client.query(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES ('admin_active@univ.edu', 'dummyhash', 'ADMIN', TRUE) RETURNING user_id"
    );
    const adminUserId = adminUserRes.rows[0].user_id;

    const inactiveAdminRes = await client.query(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES ('admin_inactive@univ.edu', 'dummyhash', 'ADMIN', FALSE) RETURNING user_id"
    );
    const inactiveAdminUserId = inactiveAdminRes.rows[0].user_id;

    const facultyUserRes = await client.query(
      "INSERT INTO users (faculty_id, email, password_hash, role, is_active) VALUES ($1, 'turing_user@univ.edu', 'dummyhash', 'FACULTY', TRUE) RETURNING user_id",
      [piFacultyId]
    );
    const facultyUserId = facultyUserRes.rows[0].user_id;

    // 4. Grant (Active, spanning current date)
    const grantRes = await client.query(
      `INSERT INTO grant_record (
        grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
      ) VALUES (
        'GR-TEST-001', 'Quantum Algorithm Research', 'DST', 100000.00, $1,
        CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE + INTERVAL '335 days', 'ACTIVE'
      ) RETURNING grant_id`,
      [piFacultyId]
    );
    const grantId = grantRes.rows[0].grant_id;

    // 5. Grant Account
    const accountRes = await client.query(
      "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'EQUIPMENT', 50000.00) RETURNING account_id, current_balance",
      [grantId]
    );
    const accountId = accountRes.rows[0].account_id;

    return {
      deptId,
      piFacultyId,
      otherFacultyId,
      adminUserId,
      inactiveAdminUserId,
      facultyUserId,
      grantId,
      accountId,
    };
  }

  describe('Trigger 1 & 2: Budget Allocation Ceiling & Grant Budget Reduction Guard', () => {
    it('allows allocating accounts exactly up to the total sanctioned grant budget', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Grant has total_budget 100,000. account 1 has 50,000.
        // Inserting second account with exactly remaining 50,000 should succeed.
        const res = await client.query(
          "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'TRAVEL', 50000.00) RETURNING account_id",
          [env.grantId]
        );
        expect(res.rows.length).toBe(1);

        const sumRes = await client.query(
          'SELECT SUM(budget_allocated)::numeric AS total_alloc FROM grant_account WHERE grant_id = $1',
          [env.grantId]
        );
        expect(Number(sumRes.rows[0].total_alloc)).toBe(100000.00);
      });
    });

    it('rejects inserting account allocation that exceeds the sanctioned grant budget ceiling', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Remaining unallocated is 50,000. Attempting to allocate 50,000.01 must fail.
        await expectQueryError(
          client,
          "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'TRAVEL', 50000.01)",
          [env.grantId],
          /Allocation violation: Total allocated .* exceeds sanctioned grant budget/i
        );
      });
    });

    it('rejects updating an existing account budget_allocated beyond the sanctioned grant budget ceiling', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Account has 50,000 out of 100,000. Increasing to 100,000.01 must fail.
        await expectQueryError(
          client,
          'UPDATE grant_account SET budget_allocated = 100000.01 WHERE account_id = $1',
          [env.accountId],
          /Allocation violation: Total allocated .* exceeds sanctioned grant budget/i
        );
      });
    });

    it('prohibits lowering grant total_budget below the sum of existing allocated account budgets', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Grant has 50,000 allocated. Reducing total_budget to 49,999.99 must fail.
        await expectQueryError(
          client,
          'UPDATE grant_record SET total_budget = 49999.99 WHERE grant_id = $1',
          [env.grantId],
          /Cannot reduce total budget to .*: Allocated accounts sum to/i
        );

        // Lowering total_budget down to 50,000 exactly should succeed.
        const res = await client.query(
          'UPDATE grant_record SET total_budget = 50000.00 WHERE grant_id = $1 RETURNING total_budget',
          [env.grantId]
        );
        expect(Number(res.rows[0].total_budget)).toBe(50000.00);
      });
    });
  });

  describe('Trigger 3: Grant Account Balance Initialization & Integrity Guard', () => {
    it('initializes current_balance to budget_allocated on INSERT, ignoring any client-supplied value', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Client attempts to supply current_balance = 0 or 999
        const res = await client.query(
          "INSERT INTO grant_account (grant_id, category, budget_allocated, current_balance) VALUES ($1, 'CONSUMABLES', 20000.00, 1.00) RETURNING current_balance, budget_allocated",
          [env.grantId]
        );
        expect(Number(res.rows[0].budget_allocated)).toBe(20000.00);
        expect(Number(res.rows[0].current_balance)).toBe(20000.00);
      });
    });

    it('shifts current_balance by the exact delta when budget_allocated is increased or decreased', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Increase allocation by +10,000 (from 50,000 to 60,000)
        const incRes = await client.query(
          'UPDATE grant_account SET budget_allocated = 60000.00 WHERE account_id = $1 RETURNING budget_allocated, current_balance',
          [env.accountId]
        );
        expect(Number(incRes.rows[0].budget_allocated)).toBe(60000.00);
        expect(Number(incRes.rows[0].current_balance)).toBe(60000.00);

        // Decrease allocation by -15,000 (from 60,000 to 45,000)
        const decRes = await client.query(
          'UPDATE grant_account SET budget_allocated = 45000.00 WHERE account_id = $1 RETURNING budget_allocated, current_balance',
          [env.accountId]
        );
        expect(Number(decRes.rows[0].budget_allocated)).toBe(45000.00);
        expect(Number(decRes.rows[0].current_balance)).toBe(45000.00);
      });
    });

    it('rejects budget_allocated reduction that would cause current_balance to become negative', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // First, approve an expenditure of 40,000 so current_balance becomes 10,000
        const expRes = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 40000.00, 'Compute Cluster', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        await client.query('SELECT approve_expenditure($1, $2)', [expRes.rows[0].transaction_id, env.adminUserId]);

        const balCheck = await client.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [env.accountId]);
        expect(Number(balCheck.rows[0].current_balance)).toBe(10000.00);

        // Reducing budget_allocated from 50,000 to 35,000 (delta -15,000) would make balance -5,000, which must fail
        await expectQueryError(
          client,
          'UPDATE grant_account SET budget_allocated = 35000.00 WHERE account_id = $1',
          [env.accountId],
          /would cause negative balance on account/i
        );
      });
    });

    it('prohibits direct modification of current_balance from SQL statements', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        await expectQueryError(
          client,
          'UPDATE grant_account SET current_balance = 99999.00 WHERE account_id = $1',
          [env.accountId],
          /Direct update of current_balance on account .* is prohibited/i
        );
      });
    });

    it('strictly enforces immutability of grant_id on grant_account', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Create a second grant
        const grant2Res = await client.query(
          `INSERT INTO grant_record (
            grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
          ) VALUES (
            'GR-TEST-002', 'Grant Two', 'SERB', 80000.00, $1,
            CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '100 days', 'ACTIVE'
          ) RETURNING grant_id`,
          [env.piFacultyId]
        );
        const grant2Id = grant2Res.rows[0].grant_id;

        await expectQueryError(
          client,
          'UPDATE grant_account SET grant_id = $1 WHERE account_id = $2',
          [grant2Id, env.accountId],
          /grant_id on account .* cannot be changed/i
        );
      });
    });
  });

  describe('Trigger 4: Expenditure Pre-Submission Validation Guard', () => {
    it('rejects expenditure submission when the associated grant is not ACTIVE', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Set grant status to SUSPENDED
        await client.query("UPDATE grant_record SET status = 'SUSPENDED' WHERE grant_id = $1", [env.grantId]);

        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Supplies', CURRENT_DATE, $2)",
          [env.accountId, env.piFacultyId],
          /only ACTIVE grants accept expenses/i
        );
      });
    });

    it('rejects expenditure submission when transaction_date is outside the grant active window', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Prior to start_date
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Old Invoice', CURRENT_DATE - INTERVAL '40 days', $2)",
          [env.accountId, env.piFacultyId],
          /falls outside grant active window/i
        );

        // After end_date
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Future Invoice', CURRENT_DATE + INTERVAL '350 days', $2)",
          [env.accountId, env.piFacultyId],
          /falls outside grant active window/i
        );
      });
    });

    it('rejects expenditure submission when submitted_by is not the Principal Investigator of the grant', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Unauthorized submission', CURRENT_DATE, $2)",
          [env.accountId, env.otherFacultyId],
          /is not the Principal Investigator for grant/i
        );
      });
    });

    it('rejects direct INSERT attempting to set status other than PENDING or providing approval fields', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Direct insert with status = APPROVED
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by, status) VALUES ($1, 500.00, 'Sneak approve', CURRENT_DATE, $2, 'APPROVED')",
          [env.accountId, env.piFacultyId],
          /New expenditure must be submitted with status PENDING and NULL approval fields/i
        );

        // Direct insert with approved_by non-null
        await expectQueryError(
          client,
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by, approved_by) VALUES ($1, 500.00, 'Sneak approver', CURRENT_DATE, $2, $3)",
          [env.accountId, env.piFacultyId, env.adminUserId],
          /New expenditure must be submitted with status PENDING and NULL approval fields/i
        );
      });
    });

    it('successfully accepts valid expenditure submission with initial PENDING status', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const res = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 1250.00, 'Laboratory Consumables', CURRENT_DATE, $2) RETURNING transaction_id, status, approved_by, decision_date",
          [env.accountId, env.piFacultyId]
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].status).toBe('PENDING');
        expect(res.rows[0].approved_by).toBeNull();
        expect(res.rows[0].decision_date).toBeNull();
      });
    });
  });

  describe('Trigger 5: Expenditure State Transition Matrix & Immutability Rules', () => {
    it('allows legal transitions: PENDING -> APPROVED, PENDING -> REJECTED, and APPROVED -> REJECTED (revert)', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);

        // 1. PENDING -> APPROVED
        const exp1 = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 1000.00, 'Item 1', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const tx1 = exp1.rows[0].transaction_id;

        const appRes = await client.query(
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2 RETURNING status",
          [env.adminUserId, tx1]
        );
        expect(appRes.rows[0].status).toBe('APPROVED');

        // 2. APPROVED -> REJECTED (revert)
        const revRes = await client.query(
          "UPDATE expenditure SET status = 'REJECTED', approved_by = $1, decision_date = CURRENT_TIMESTAMP, rejection_reason = 'Disallowed item' WHERE transaction_id = $2 RETURNING status",
          [env.adminUserId, tx1]
        );
        expect(revRes.rows[0].status).toBe('REJECTED');

        // 3. PENDING -> REJECTED
        const exp2 = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 2000.00, 'Item 2', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const tx2 = exp2.rows[0].transaction_id;

        const rejRes = await client.query(
          "UPDATE expenditure SET status = 'REJECTED', approved_by = $1, decision_date = CURRENT_TIMESTAMP, rejection_reason = 'Over budget head' WHERE transaction_id = $2 RETURNING status",
          [env.adminUserId, tx2]
        );
        expect(rejRes.rows[0].status).toBe('REJECTED');
      });
    });

    it('rejects all illegal status transitions across the state matrix', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);

        // Helper to insert a fresh expenditure
        const insertExp = async () => {
          const res = await client.query(
            "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Test', CURRENT_DATE, $2) RETURNING transaction_id",
            [env.accountId, env.piFacultyId]
          );
          return res.rows[0].transaction_id;
        };

        // 1. APPROVED -> PENDING
        const txApp = await insertExp();
        await client.query("UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2", [env.adminUserId, txApp]);
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'PENDING' WHERE transaction_id = $1",
          [txApp],
          /Illegal status transition/i
        );

        // 2. REJECTED -> PENDING
        const txRej = await insertExp();
        await client.query("UPDATE expenditure SET status = 'REJECTED', approved_by = $1, decision_date = CURRENT_TIMESTAMP, rejection_reason = 'Denied' WHERE transaction_id = $2", [env.adminUserId, txRej]);
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'PENDING' WHERE transaction_id = $1",
          [txRej],
          /Illegal status transition/i
        );

        // 3. REJECTED -> APPROVED
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.adminUserId, txRej],
          /Illegal status transition/i
        );
      });
    });

    it('enforces immutability of account_id and submitted_by on expenditure rows', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Test', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        // Attempt to change account_id
        await expectQueryError(
          client,
          'UPDATE expenditure SET account_id = 99999 WHERE transaction_id = $1',
          [txId],
          /account_id on expenditure .* cannot be changed/i
        );

        // Attempt to change submitted_by
        await expectQueryError(
          client,
          'UPDATE expenditure SET submitted_by = $1 WHERE transaction_id = $2',
          [env.otherFacultyId, txId],
          /submitted_by on expenditure .* cannot be changed/i
        );
      });
    });

    it('permits amount modification only while PENDING; freezes decided expenditure records', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Initial description', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        // Editing amount while PENDING is allowed
        const editRes = await client.query(
          'UPDATE expenditure SET amount = 750.00 WHERE transaction_id = $1 RETURNING amount',
          [txId]
        );
        expect(Number(editRes.rows[0].amount)).toBe(750.00);

        // Approve the expenditure
        await client.query(
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.adminUserId, txId]
        );

        // Attempting to modify amount after approval must fail
        await expectQueryError(
          client,
          'UPDATE expenditure SET amount = 800.00 WHERE transaction_id = $1',
          [txId],
          /is already APPROVED and cannot be modified/i
        );

        // Attempting to modify description after approval must fail (decided records are frozen)
        await expectQueryError(
          client,
          "UPDATE expenditure SET description = 'Tampered description' WHERE transaction_id = $1",
          [txId],
          /is already APPROVED and cannot be modified/i
        );
      });
    });

    it('requires approver to be an active ADMIN user', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 500.00, 'Test', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        // 1. Approver is FACULTY user (not ADMIN)
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.facultyUserId, txId],
          /must be an active ADMIN/i
        );

        // 2. Approver is INACTIVE ADMIN
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.inactiveAdminUserId, txId],
          /must be an active ADMIN/i
        );

        // 3. Approver is unknown user ID
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'APPROVED', approved_by = 99999, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $1",
          [txId],
          /must be an active ADMIN/i
        );
      });
    });
    it('enforces separation of duties: approver cannot decide their own expenditure', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);

        // Create faculty member who is also an ADMIN
        const dualFacultyRes = await client.query(
          "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Dual Role', 'dual@univ.edu', 'PROFESSOR') RETURNING faculty_id",
          [env.deptId]
        );
        const dualFacultyId = dualFacultyRes.rows[0].faculty_id;

        const dualAdminUserRes = await client.query(
          "INSERT INTO users (faculty_id, email, password_hash, role, is_active) VALUES ($1, 'dual_admin@univ.edu', 'dummyhash', 'ADMIN', TRUE) RETURNING user_id",
          [dualFacultyId]
        );
        const dualAdminUserId = dualAdminUserRes.rows[0].user_id;

        // Create another ADMIN linked to a different faculty member
        const otherAdminUserRes = await client.query(
          "INSERT INTO users (faculty_id, email, password_hash, role, is_active) VALUES ($1, 'other_admin@univ.edu', 'dummyhash', 'ADMIN', TRUE) RETURNING user_id",
          [env.otherFacultyId]
        );
        const otherAdminUserId = otherAdminUserRes.rows[0].user_id;

        // Create grant with dualFaculty as PI
        const dualGrantRes = await client.query(
          `INSERT INTO grant_record (grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status)
           VALUES ('GR-DUAL-001', 'Dual Role Project', 'ISRO', 50000.00, $1, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '100 days', 'ACTIVE')
           RETURNING grant_id`,
          [dualFacultyId]
        );
        const dualGrantId = dualGrantRes.rows[0].grant_id;

        const dualAccountRes = await client.query(
          "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'TRAVEL', 20000.00) RETURNING account_id",
          [dualGrantId]
        );
        const dualAccountId = dualAccountRes.rows[0].account_id;

        // Submit an expenditure by dualFaculty
        const expRes = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 1000.00, 'Flight', CURRENT_DATE, $2) RETURNING transaction_id",
          [dualAccountId, dualFacultyId]
        );
        const txId = expRes.rows[0].transaction_id;

        // 1. Dual ADMIN attempting to approve own submission -> REJECTED
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [dualAdminUserId, txId],
          /an approver cannot decide their own expenditure/i
        );

        // 2. Dual ADMIN attempting to reject own submission -> REJECTED
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'REJECTED', approved_by = $1, decision_date = CURRENT_TIMESTAMP, rejection_reason = 'Self reject' WHERE transaction_id = $2",
          [dualAdminUserId, txId],
          /an approver cannot decide their own expenditure/i
        );

        // 3. ADMIN linked to a different faculty member -> SUCCEEDS
        await client.query('SAVEPOINT sp_other_admin');
        const otherApproveRes = await client.query(
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2 RETURNING status, approved_by",
          [otherAdminUserId, txId]
        );
        expect(otherApproveRes.rows[0].status).toBe('APPROVED');
        expect(otherApproveRes.rows[0].approved_by).toBe(otherAdminUserId);
        await client.query('ROLLBACK TO SAVEPOINT sp_other_admin');

        // 4. ADMIN with NO faculty link (faculty_id IS NULL) -> SUCCEEDS
        const neutralApproveRes = await client.query(
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2 RETURNING status, approved_by",
          [env.adminUserId, txId]
        );
        expect(neutralApproveRes.rows[0].status).toBe('APPROVED');
        expect(neutralApproveRes.rows[0].approved_by).toBe(env.adminUserId);
      });
    });
  });

  describe('Trigger 6: Automated Balance Maintenance & Multi-Expenditure Accounting', () => {
    it('deducts funds on approval and restores funds on rejection / revert', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Initial balance is 50,000
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 15000.00, 'Server Rack', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        // Approve
        await client.query(
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.adminUserId, txId]
        );

        const balAfterApprove = await client.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [env.accountId]);
        expect(Number(balAfterApprove.rows[0].current_balance)).toBe(35000.00);

        // Revert (APPROVED -> REJECTED)
        await client.query(
          "UPDATE expenditure SET status = 'REJECTED', approved_by = $1, decision_date = CURRENT_TIMESTAMP, rejection_reason = 'Disallowed by audit' WHERE transaction_id = $2",
          [env.adminUserId, txId]
        );

        const balAfterRevert = await client.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [env.accountId]);
        expect(Number(balAfterRevert.rows[0].current_balance)).toBe(50000.00);
      });
    });

    it('rejects approval when expenditure amount exceeds current_balance', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Account balance is 50,000. Request 50,000.01
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 50000.01, 'Supercomputer', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.adminUserId, txId],
          /Insufficient balance: Account .* has 50000.00, requested 50000.01/i
        );

        // Verify balance remained untouched
        const balCheck = await client.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [env.accountId]);
        expect(Number(balCheck.rows[0].current_balance)).toBe(50000.00);
      });
    });

    it('handles multiple concurrent and sequential expenditures on a single account accurately', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        // Start: 50,000
        // Exp 1: 10,000
        const exp1 = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 10000.00, 'Batch 1', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        await client.query("UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2", [env.adminUserId, exp1.rows[0].transaction_id]);

        // Exp 2: 25,000
        const exp2 = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 25000.00, 'Batch 2', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        await client.query("UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2", [env.adminUserId, exp2.rows[0].transaction_id]);

        // Balance should be 50,000 - 10,000 - 25,000 = 15,000
        const balRes = await client.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [env.accountId]);
        expect(Number(balRes.rows[0].current_balance)).toBe(15000.00);

        // Exp 3: 20,000 should fail because only 15,000 left
        const exp3 = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 20000.00, 'Batch 3', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        await expectQueryError(
          client,
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.adminUserId, exp3.rows[0].transaction_id],
          /Insufficient balance/i
        );

        // Revert Exp 1 (10,000 restored -> balance becomes 25,000)
        await client.query("UPDATE expenditure SET status = 'REJECTED', approved_by = $1, decision_date = CURRENT_TIMESTAMP, rejection_reason = 'Audit error' WHERE transaction_id = $2", [env.adminUserId, exp1.rows[0].transaction_id]);

        const balRestored = await client.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [env.accountId]);
        expect(Number(balRestored.rows[0].current_balance)).toBe(25000.00);

        // Now Exp 3 (20,000) can succeed!
        await client.query("UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2", [env.adminUserId, exp3.rows[0].transaction_id]);

        const balFinal = await client.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [env.accountId]);
        expect(Number(balFinal.rows[0].current_balance)).toBe(5000.00);
      });
    });
  });

  describe('Trigger 7 & 8: Audit Trail Lifecycle & Append-Only Immutability', () => {
    it('creates audit_log records on submission, approval, and rejection with exact state snapshots', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);

        // 1. Submit creates CREATED log
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 4500.00, 'GPU Cloud Units', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        const log1 = await client.query(
          "SELECT * FROM audit_log WHERE entity_id = $1 AND action = 'CREATED'",
          [txId]
        );
        expect(log1.rows.length).toBe(1);
        expect(log1.rows[0].entity_type).toBe('EXPENDITURE');
        expect(log1.rows[0].changed_by).toBe(env.facultyUserId);
        expect(Number(log1.rows[0].new_state.amount)).toBe(4500.00);
        expect(log1.rows[0].new_state.status).toBe('PENDING');

        // 2. Approve creates STATUS_CHANGE_APPROVED log
        await client.query(
          "UPDATE expenditure SET status = 'APPROVED', approved_by = $1, decision_date = CURRENT_TIMESTAMP WHERE transaction_id = $2",
          [env.adminUserId, txId]
        );

        const log2 = await client.query(
          "SELECT * FROM audit_log WHERE entity_id = $1 AND action = 'STATUS_CHANGE_APPROVED'",
          [txId]
        );
        expect(log2.rows.length).toBe(1);
        expect(log2.rows[0].changed_by).toBe(env.adminUserId);
        expect(log2.rows[0].old_state.status).toBe('PENDING');
        expect(log2.rows[0].new_state.status).toBe('APPROVED');

        // 3. Revert creates STATUS_CHANGE_REJECTED log
        await client.query(
          "UPDATE expenditure SET status = 'REJECTED', approved_by = $1, decision_date = CURRENT_TIMESTAMP, rejection_reason = 'Incorrect cost center' WHERE transaction_id = $2",
          [env.adminUserId, txId]
        );

        const log3 = await client.query(
          "SELECT * FROM audit_log WHERE entity_id = $1 AND action = 'STATUS_CHANGE_REJECTED'",
          [txId]
        );
        expect(log3.rows.length).toBe(1);
        expect(log3.rows[0].remarks).toBe('Incorrect cost center');
        expect(log3.rows[0].old_state.status).toBe('APPROVED');
        expect(log3.rows[0].new_state.status).toBe('REJECTED');
      });
    });

    it('prohibits UPDATE, DELETE, and TRUNCATE on audit_log even for database superuser / table owner', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 100.00, 'Audit target', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        const logRes = await client.query('SELECT log_id FROM audit_log WHERE entity_id = $1', [txId]);
        const logId = logRes.rows[0].log_id;

        // Prohibit UPDATE
        await expectQueryError(
          client,
          "UPDATE audit_log SET remarks = 'Unauthorized tamper' WHERE log_id = $1",
          [logId],
          /audit_log is append-only: updates, deletes, and truncates are prohibited/i
        );

        // Prohibit DELETE
        await expectQueryError(
          client,
          'DELETE FROM audit_log WHERE log_id = $1',
          [logId],
          /audit_log is append-only: updates, deletes, and truncates are prohibited/i
        );

        // Prohibit TRUNCATE
        await expectQueryError(
          client,
          'TRUNCATE TABLE audit_log',
          [],
          /audit_log is append-only: updates, deletes, and truncates are prohibited/i
        );
      });
    });
  });

  describe('Workflow Routines: Stored Functions & Callable Procedures', () => {
    it('executes approve_expenditure returning well-formed JSON summary', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 7500.00, 'Optics Bench', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        const res = await client.query('SELECT approve_expenditure($1, $2) AS outcome', [txId, env.adminUserId]);
        const outcome = res.rows[0].outcome;

        expect(outcome.transaction_id).toBe(txId);
        expect(outcome.status).toBe('APPROVED');
        expect(Number(outcome.amount_approved)).toBe(7500.00);
        expect(Number(outcome.remaining_balance)).toBe(42500.00);
        expect(outcome.approved_by).toBe(env.adminUserId);
      });
    });

    it('rejects approve_expenditure for non-admin callers, invalid IDs, or non-PENDING status', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 1000.00, 'Test item', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        // Non-admin caller
        await expectQueryError(
          client,
          'SELECT approve_expenditure($1, $2)',
          [txId, env.facultyUserId],
          /User .* is not an active ADMIN/i
        );

        // Unknown expenditure ID
        await expectQueryError(
          client,
          'SELECT approve_expenditure(99999, $1)',
          [env.adminUserId],
          /Expenditure with transaction ID 99999 does not exist/i
        );

        // Approve once
        await client.query('SELECT approve_expenditure($1, $2)', [txId, env.adminUserId]);

        // Attempting to approve again (wrong status)
        await expectQueryError(
          client,
          'SELECT approve_expenditure($1, $2)',
          [txId, env.adminUserId],
          /only PENDING claims can be approved/i
        );
      });
    });

    it('executes reject_or_revert_expenditure requiring mandatory non-empty reason', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 2000.00, 'Travel claim', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        // Missing or empty reason
        await expectQueryError(
          client,
          'SELECT reject_or_revert_expenditure($1, $2, $3)',
          [txId, env.adminUserId, '   '],
          /Rejection reason is required/i
        );

        // Valid rejection of PENDING expenditure
        const rejRes = await client.query(
          'SELECT reject_or_revert_expenditure($1, $2, $3) AS outcome',
          [txId, env.adminUserId, 'Exceeds per-diem limit']
        );
        expect(rejRes.rows[0].outcome.status).toBe('REJECTED');
        expect(rejRes.rows[0].outcome.rejection_reason).toBe('Exceeds per-diem limit');

        // Cannot reject an already REJECTED expenditure
        await expectQueryError(
          client,
          'SELECT reject_or_revert_expenditure($1, $2, $3)',
          [txId, env.adminUserId, 'Reject again'],
          /already .* REJECTED/i
        );
      });
    });

    it('executes procedure wrappers approve_expenditure_proc and reject_or_revert_expenditure_proc via CALL', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);
        const exp = await client.query(
          "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 3000.00, 'Proc Test', CURRENT_DATE, $2) RETURNING transaction_id",
          [env.accountId, env.piFacultyId]
        );
        const txId = exp.rows[0].transaction_id;

        // CALL approve_expenditure_proc
        const procAppRes = await client.query(
          'CALL approve_expenditure_proc($1, $2, NULL)',
          [txId, env.adminUserId]
        );
        expect(procAppRes.rows[0].p_result.status).toBe('APPROVED');

        // CALL reject_or_revert_expenditure_proc (reverting the approved item)
        const procRejRes = await client.query(
          'CALL reject_or_revert_expenditure_proc($1, $2, $3, NULL)',
          [txId, env.adminUserId, 'Proc revert test']
        );
        expect(procRejRes.rows[0].p_result.status).toBe('REJECTED');
      });
    });
  });

  describe('Full-Text Search & TSVector Synchronization', () => {
    it('automatically maintains weighted tsv on INSERT and UPDATE of intellectual_property', async () => {
      await withRollback(async (client) => {
        const ipRes = await client.query(
          `INSERT INTO intellectual_property (
            title, abstract, doc_type, filing_date
          ) VALUES (
            'Fault Tolerant Quantum Computation',
            'Error correction algorithms and surface codes for superconducting qubits',
            'PATENT', CURRENT_DATE
          ) RETURNING document_id, tsv`,
          []
        );
        const ip = ipRes.rows[0];
        expect(ip.tsv).toBeDefined();
        expect(ip.tsv).toContain('fault');
        expect(ip.tsv).toContain('quantum');

        // Verify title has weight A and abstract has weight B
        expect(ip.tsv).toMatch(/'quantum':\d+A/);
        expect(ip.tsv).toMatch(/'superconduct':\d+B/);

        // Update abstract and verify synchronization
        const updRes = await client.query(
          "UPDATE intellectual_property SET abstract = 'Topological braiding mechanisms' WHERE document_id = $1 RETURNING tsv",
          [ip.document_id]
        );
        expect(updRes.rows[0].tsv).toContain('topolog');
        expect(updRes.rows[0].tsv).not.toContain('superconduct');
      });
    });

    it('performs full-text ranking with search_ip_fulltext prioritizing title matches over abstract matches', async () => {
      await withRollback(async (client) => {
        // Document 1: Search keyword in title (Weight A)
        const d1 = await client.query(
          `INSERT INTO intellectual_property (
            title, abstract, doc_type, filing_date
          ) VALUES (
            'Advanced Robotics Sensor Fusion',
            'A comprehensive treatise on sensor systems for industrial automation',
            'PAPER', CURRENT_DATE
          ) RETURNING document_id`,
          []
        );

        // Document 2: Search keyword only in abstract (Weight B)
        const d2 = await client.query(
          `INSERT INTO intellectual_property (
            title, abstract, doc_type, filing_date
          ) VALUES (
            'Mechatronic System Automation',
            'Integration of robotics actuators with embedded industrial controllers',
            'PATENT', CURRENT_DATE
          ) RETURNING document_id`,
          []
        );

        // Search for 'robotics'
        const results = await client.query('SELECT * FROM search_ip_fulltext($1, $2)', ['robotics', 10]);
        expect(results.rows.length).toBe(2);

        // Document 1 with title match must rank strictly higher than Document 2 with abstract match
        expect(results.rows[0].document_id).toBe(d1.rows[0].document_id);
        expect(results.rows[1].document_id).toBe(d2.rows[0].document_id);
        expect(results.rows[0].rank).toBeGreaterThan(results.rows[1].rank);

        // Non-matching query returns zero rows
        const emptyRes = await client.query('SELECT * FROM search_ip_fulltext($1, $2)', ['nonexistenttermxyz', 10]);
        expect(emptyRes.rows.length).toBe(0);
      });
    });

    it('retrieves an intellectual property record with a 390-character title intact via search_ip_fulltext', async () => {
      await withRollback(async (client) => {
        const prefix = 'Quantum Cryptographic Key Distribution Protocol Using Entangled Photons for Secure Satellite Communications';
        const filler = ' Across Long Distances Under Severe Atmospheric Turbulence And Channel Losses';
        const title390 = (prefix + filler.repeat(5)).slice(0, 390);
        expect(title390.length).toBe(390);

        await client.query(
          `INSERT INTO intellectual_property (title, abstract, doc_type, filing_date)
           VALUES ($1, 'Experimental realization of deep space quantum key exchange.', 'PATENT', CURRENT_DATE)`,
          [title390]
        );

        const searchRes = await client.query(
          'SELECT document_id, title, doc_type, rank FROM search_ip_fulltext($1, 5)',
          ['Quantum Cryptographic Key Distribution']
        );

        expect(searchRes.rows.length).toBeGreaterThan(0);
        expect(searchRes.rows[0].title).toBe(title390);
        expect(searchRes.rows[0].title.length).toBe(390);
        expect(searchRes.rows[0].doc_type).toBe('PATENT');
        expect(searchRes.rows[0].rank).toBeGreaterThan(0);
      });
    });
  });

  describe('Analytical Reporting Views against Controlled Hand-Computed Datasets', () => {
    it('verifies v_grant_financial_summary and v_department_expenditure_overview avoid join inflation with multi-account and multi-expenditure data', async () => {
      await withRollback(async (client) => {
        // Create 1 Department
        const dRes = await client.query("INSERT INTO department (department_name, department_code) VALUES ('Physics Research', 'PHYS') RETURNING department_id");
        const deptId = dRes.rows[0].department_id;

        // Create 2 Faculty
        const f1 = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Prof. Alpha', 'alpha@univ.edu', 'PROFESSOR') RETURNING faculty_id", [deptId]);
        const alphaId = f1.rows[0].faculty_id;

        const f2 = await client.query("INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Prof. Beta', 'beta@univ.edu', 'ASSOCIATE_PROFESSOR') RETURNING faculty_id", [deptId]);
        const betaId = f2.rows[0].faculty_id;

        // Admin user for approvals
        const adminRes = await client.query("INSERT INTO users (email, password_hash, role, is_active) VALUES ('admin_view@univ.edu', 'dummyhash', 'ADMIN', TRUE) RETURNING user_id");
        const adminId = adminRes.rows[0].user_id;

        // Grant 1 for Prof Alpha: Total Budget = 100,000.00
        const g1 = await client.query(`
          INSERT INTO grant_record (
            grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
          ) VALUES ('GR-PHYS-01', 'High Energy Particles', 'CERN', 100000.00, $1, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '300 days', 'ACTIVE')
          RETURNING grant_id
        `, [alphaId]);
        const g1Id = g1.rows[0].grant_id;

        // Grant 2 for Prof Beta: Total Budget = 50,000.00 (No accounts/expenditures)
        await client.query(`
          INSERT INTO grant_record (
            grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
          ) VALUES ('GR-PHYS-02', 'Astrophysics Simulation', 'ISRO', 50000.00, $1, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '300 days', 'ACTIVE')
        `, [betaId]);

        // Grant 1 has 2 Accounts:
        // Account A: Allocated 60,000.00
        const accA = await client.query("INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'EQUIPMENT', 60000.00) RETURNING account_id", [g1Id]);
        const accAId = accA.rows[0].account_id;

        // Account B: Allocated 30,000.00
        const accB = await client.query("INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'TRAVEL', 30000.00) RETURNING account_id", [g1Id]);
        const accBId = accB.rows[0].account_id;

        // Account A expenditures:
        // Exp 1: 10,000.00 (APPROVED)
        const exp1 = await client.query("INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 10000.00, 'Detector Parts', CURRENT_DATE, $2) RETURNING transaction_id", [accAId, alphaId]);
        await client.query('SELECT approve_expenditure($1, $2)', [exp1.rows[0].transaction_id, adminId]);

        // Exp 2: 5,000.00 (PENDING)
        await client.query("INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 5000.00, 'Cables', CURRENT_DATE, $2)", [accAId, alphaId]);

        // Account B expenditures:
        // Exp 3: 8,000.00 (APPROVED)
        const exp3 = await client.query("INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 8000.00, 'Geneva Flight', CURRENT_DATE, $2) RETURNING transaction_id", [accBId, alphaId]);
        await client.query('SELECT approve_expenditure($1, $2)', [exp3.rows[0].transaction_id, adminId]);

        // 1. Verify v_grant_financial_summary for Grant 1
        const gSummary = await client.query('SELECT * FROM v_grant_financial_summary WHERE grant_id = $1', [g1Id]);
        expect(gSummary.rows.length).toBe(1);
        const row = gSummary.rows[0];

        expect(Number(row.sanctioned_budget)).toBe(100000.00);
        expect(Number(row.total_allocated)).toBe(90000.00); // 60k + 30k
        expect(Number(row.unallocated_reserve)).toBe(10000.00); // 100k - 90k
        // Spent = 10k (accA) + 8k (accB) = 18,000.00
        expect(Number(row.total_spent)).toBe(18000.00);
        // Cash balance = (60k - 10k) + (30k - 8k) = 50k + 22k = 72,000.00
        expect(Number(row.remaining_cash_balance)).toBe(72000.00);
        expect(Number(row.budget_utilization_pct)).toBe(18.00);
        expect(Number(row.total_budget_heads)).toBe(2);

        // 2. Verify v_department_expenditure_overview for Physics Department
        const dOverview = await client.query('SELECT * FROM v_department_expenditure_overview WHERE department_id = $1', [deptId]);
        expect(dOverview.rows.length).toBe(1);
        const dRow = dOverview.rows[0];

        expect(Number(dRow.total_grants)).toBe(2);
        expect(Number(dRow.active_grants)).toBe(2);
        // Total sanctioned funds = 100,000 + 50,000 = 150,000.00 (MUST NOT be multiplied by accounts or expenditures!)
        expect(Number(dRow.total_sanctioned_funds)).toBe(150000.00);
        expect(Number(dRow.total_approved_expenditure)).toBe(18000.00);
        expect(Number(dRow.pending_claims_value)).toBe(5000.00);
        expect(Number(dRow.approved_transaction_count)).toBe(2);
      });
    });

    it('verifies v_faculty_ip_portfolio aggregates faculty IP disclosures accurately', async () => {
      await withRollback(async (client) => {
        const env = await seedTestEnvironment(client);

        // Create 2 IP records for PI
        const p1 = await client.query(
          "INSERT INTO intellectual_property (title, abstract, doc_type, filing_date) VALUES ('Patent A', 'Quantum circuit', 'PATENT', CURRENT_DATE) RETURNING document_id"
        );
        const p2 = await client.query(
          "INSERT INTO intellectual_property (title, abstract, doc_type, filing_date) VALUES ('Paper B', 'Quantum algorithms', 'PAPER', CURRENT_DATE) RETURNING document_id"
        );

        // Authorship
        await client.query("INSERT INTO ip_author (document_id, faculty_id, author_order, is_corresponding) VALUES ($1, $2, 1, TRUE)", [p1.rows[0].document_id, env.piFacultyId]);
        await client.query("INSERT INTO ip_author (document_id, faculty_id, author_order, is_corresponding) VALUES ($1, $2, 2, FALSE)", [p2.rows[0].document_id, env.piFacultyId]);

        // Link Patent A to Grant
        await client.query("INSERT INTO grant_ip (grant_id, document_id) VALUES ($1, $2)", [env.grantId, p1.rows[0].document_id]);

        const ipSummary = await client.query('SELECT * FROM v_faculty_ip_portfolio WHERE faculty_id = $1', [env.piFacultyId]);
        expect(ipSummary.rows.length).toBe(1);
        const fRow = ipSummary.rows[0];

        expect(Number(fRow.total_ip_disclosures)).toBe(2);
        expect(Number(fRow.patents_filed)).toBe(1);
        expect(Number(fRow.papers_published)).toBe(1);
        expect(Number(fRow.draft_disclosures)).toBe(0);
        expect(Number(fRow.corresponding_author_count)).toBe(1);
        expect(Number(fRow.associated_funded_grants)).toBe(1);
      });
    });
  });
});
