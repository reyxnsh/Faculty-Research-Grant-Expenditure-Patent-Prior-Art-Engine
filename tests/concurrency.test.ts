import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import path from 'path';

describe('Concurrency & Lock Serialization on Scratch Database', () => {
  const user = process.env.POSTGRES_USER!;
  const password = process.env.POSTGRES_PASSWORD!;
  const host = process.env.POSTGRES_HOST!;
  const port = parseInt(process.env.POSTGRES_PORT!, 10);
  const baseDb = process.env.POSTGRES_DB?.replace(/_test$/, '') || 'grant_priorart_db';
  const concDb = `${baseDb}_conctest`;
  const concDbUrl = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(concDb)}`;

  let adminClient: Client;

  beforeAll(async () => {
    // 1. Create scratch database
    adminClient = new Client({
      user,
      password,
      host,
      port,
      database: 'postgres',
    });
    await adminClient.connect();

    const escapedDb = adminClient.escapeIdentifier(concDb);
    await adminClient.query(`DROP DATABASE IF EXISTS ${escapedDb} WITH (FORCE);`);
    await adminClient.query(`CREATE DATABASE ${escapedDb};`);

    // 2. Run migrations UP to completion
    await runner({
      databaseUrl: concDbUrl,
      dir: path.resolve(process.cwd(), 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });
  }, 30000);

  afterAll(async () => {
    if (adminClient) {
      const escapedDb = adminClient.escapeIdentifier(concDb);
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS ${escapedDb} WITH (FORCE);`);
      } catch {
        // cleanup suppression
      }
      await adminClient.end();
    }
  });

  // Helper to acquire a new independent client connected to the scratch database
  async function createScratchClient(): Promise<Client> {
    const client = new Client({
      user,
      password,
      host,
      port,
      database: concDb,
    });
    await client.connect();
    return client;
  }

  it('two concurrent approvals that together exceed balance: exactly one succeeds and balance is never negative', async () => {
    const setupClient = await createScratchClient();
    const clientA = await createScratchClient();
    const clientB = await createScratchClient();

    try {
      // 1. Fixtures: Dept, Faculty, Admin, Grant (100k), Account (10k)
      const deptRes = await setupClient.query(
        "INSERT INTO department (department_name, department_code) VALUES ('Concurrency Lab', 'CONC') RETURNING department_id"
      );
      const deptId = deptRes.rows[0].department_id;

      const facRes = await setupClient.query(
        "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Concurrency', 'conc@univ.edu', 'PROFESSOR') RETURNING faculty_id",
        [deptId]
      );
      const facId = facRes.rows[0].faculty_id;

      const adminRes = await setupClient.query(
        "INSERT INTO users (email, password_hash, role, is_active) VALUES ('conc_admin@univ.edu', 'hash', 'ADMIN', TRUE) RETURNING user_id"
      );
      const adminId = adminRes.rows[0].user_id;

      const grantRes = await setupClient.query(
        `INSERT INTO grant_record (
          grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
        ) VALUES ('GR-CONC-01', 'Parallel Systems', 'NSF', 100000.00, $1, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '200 days', 'ACTIVE')
        RETURNING grant_id`,
        [facId]
      );
      const grantId = grantRes.rows[0].grant_id;

      // Account with initial balance = 10,000.00
      const accRes = await setupClient.query(
        "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'EQUIPMENT', 10000.00) RETURNING account_id",
        [grantId]
      );
      const accountId = accRes.rows[0].account_id;

      // Two expenditures of 6,000.00 each (6k + 6k = 12k > 10k balance)
      const exp1 = await setupClient.query(
        "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 6000.00, 'Order 1', CURRENT_DATE, $2) RETURNING transaction_id",
        [accountId, facId]
      );
      const tx1 = exp1.rows[0].transaction_id;

      const exp2 = await setupClient.query(
        "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 6000.00, 'Order 2', CURRENT_DATE, $2) RETURNING transaction_id",
        [accountId, facId]
      );
      const tx2 = exp2.rows[0].transaction_id;

      // 2. Fire concurrent approval requests across separate database connections
      const results = await Promise.allSettled([
        clientA.query('SELECT approve_expenditure($1, $2)', [tx1, adminId]),
        clientB.query('SELECT approve_expenditure($1, $2)', [tx2, adminId]),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one must succeed, exactly one must fail
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Rejection reason must indicate insufficient balance
      const rejectionError = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectionError.message).toMatch(/Insufficient balance/i);

      // Verify resulting balance is exactly 4,000.00 and never negative
      const balRes = await setupClient.query(
        'SELECT current_balance FROM grant_account WHERE account_id = $1',
        [accountId]
      );
      expect(Number(balRes.rows[0].current_balance)).toBe(4000.00);
      expect(Number(balRes.rows[0].current_balance)).toBeGreaterThanOrEqual(0);
    } finally {
      await clientA.end();
      await clientB.end();
      await setupClient.end();
    }
  });

  it('concurrent mix of approve and budget change shows no deadlock', async () => {
    const setupClient = await createScratchClient();
    const workerA = await createScratchClient();
    const workerB = await createScratchClient();

    try {
      const deptRes = await setupClient.query(
        "INSERT INTO department (department_name, department_code) VALUES ('Deadlock Test Dept', 'DLOCK') RETURNING department_id"
      );
      const deptId = deptRes.rows[0].department_id;

      const facRes = await setupClient.query(
        "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Deadlock Free', 'dl@univ.edu', 'PROFESSOR') RETURNING faculty_id",
        [deptId]
      );
      const facId = facRes.rows[0].faculty_id;

      const adminRes = await setupClient.query(
        "INSERT INTO users (email, password_hash, role, is_active) VALUES ('dl_admin@univ.edu', 'hash', 'ADMIN', TRUE) RETURNING user_id"
      );
      const adminId = adminRes.rows[0].user_id;

      const grantRes = await setupClient.query(
        `INSERT INTO grant_record (
          grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
        ) VALUES ('GR-DLOCK-01', 'High Concurrency', 'DST', 80000.00, $1, CURRENT_DATE - INTERVAL '5 days', CURRENT_DATE + INTERVAL '180 days', 'ACTIVE')
        RETURNING grant_id`,
        [facId]
      );
      const grantId = grantRes.rows[0].grant_id;

      const accRes = await setupClient.query(
        "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'CONSUMABLES', 30000.00) RETURNING account_id",
        [grantId]
      );
      const accountId = accRes.rows[0].account_id;

      // Submit an expenditure of 2,000
      const expRes = await setupClient.query(
        "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 2000.00, 'Batch Item', CURRENT_DATE, $2) RETURNING transaction_id",
        [accountId, facId]
      );
      const txId = expRes.rows[0].transaction_id;

      // Concurrently execute:
      // Worker A approves expenditure (Locks expenditure Level 1 -> grant_account Level 2)
      // Worker B updates account allocation from 30,000 to 35,000 (Locks grant_record Level 3 -> grant_account Level 2)
      // Strict locking order prevents cycle deadlock
      const results = await Promise.allSettled([
        workerA.query('SELECT approve_expenditure($1, $2)', [txId, adminId]),
        workerB.query('UPDATE grant_account SET budget_allocated = 35000.00 WHERE account_id = $1', [accountId]),
      ]);

      // Confirm no deadlock exceptions (SQLSTATE 40P01) occurred
      for (const res of results) {
        if (res.status === 'rejected') {
          expect(res.reason.code).not.toBe('40P01');
          expect(res.reason.message).not.toMatch(/deadlock detected/i);
        }
      }

      // Check final state integrity
      const finalBal = await setupClient.query(
        'SELECT budget_allocated, current_balance FROM grant_account WHERE account_id = $1',
        [accountId]
      );
      expect(Number(finalBal.rows[0].current_balance)).toBeGreaterThanOrEqual(0);
    } finally {
      await workerA.end();
      await workerB.end();
      await setupClient.end();
    }
  });

  it('two concurrent account inserts that together exceed total_budget: exactly one succeeds', async () => {
    const setupClient = await createScratchClient();
    const clientA = await createScratchClient();
    const clientB = await createScratchClient();

    try {
      const deptRes = await setupClient.query(
        "INSERT INTO department (department_name, department_code) VALUES ('Ceiling Concurrency', 'CEIL') RETURNING department_id"
      );
      const deptId = deptRes.rows[0].department_id;

      const facRes = await setupClient.query(
        "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Budget Ceiling', 'ceil@univ.edu', 'PROFESSOR') RETURNING faculty_id",
        [deptId]
      );
      const facId = facRes.rows[0].faculty_id;

      // Sanctioned grant budget = 100,000.00
      const grantRes = await setupClient.query(
        `INSERT INTO grant_record (
          grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
        ) VALUES ('GR-CEIL-01', 'Budget Ceiling Serialization', 'DBT', 100000.00, $1, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '200 days', 'ACTIVE')
        RETURNING grant_id`,
        [facId]
      );
      const grantId = grantRes.rows[0].grant_id;

      // Already allocated: 60,000.00 (Leaves 40,000.00 unallocated)
      await setupClient.query(
        "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'EQUIPMENT', 60000.00)",
        [grantId]
      );

      // Two concurrent inserts of 30,000.00 each on different categories
      // Together: 60k + 30k + 30k = 120,000 > 100,000 total_budget
      const results = await Promise.allSettled([
        clientA.query(
          "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'TRAVEL', 30000.00)",
          [grantId]
        ),
        clientB.query(
          "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'CONSUMABLES', 30000.00)",
          [grantId]
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Due to row-level locking on grant_record in fn_check_grant_budget_ceiling:
      // Exactly one must succeed, and exactly one must fail with budget ceiling error
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err.message).toMatch(/Allocation violation: Total allocated .* exceeds sanctioned grant budget/i);

      // Verify total allocated sum in database equals 90,000.00 (strictly <= 100,000.00)
      const sumRes = await setupClient.query(
        'SELECT SUM(budget_allocated)::numeric AS total_alloc FROM grant_account WHERE grant_id = $1',
        [grantId]
      );
      expect(Number(sumRes.rows[0].total_alloc)).toBe(90000.00);
    } finally {
      await clientA.end();
      await clientB.end();
      await setupClient.end();
    }
  });
});
