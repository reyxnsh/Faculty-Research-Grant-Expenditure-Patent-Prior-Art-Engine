import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { getAdminPool } from '@/lib/db';

describe('Restricted Application Database Role (grant_app)', () => {
  const host = process.env.POSTGRES_HOST!;
  const port = parseInt(process.env.POSTGRES_PORT!, 10);
  const database = process.env.POSTGRES_DB!;
  const appUser = process.env.APP_DB_USER!;
  const appPassword = process.env.APP_DB_PASSWORD!;

  let appClient: Client;
  const adminPool = getAdminPool();

  beforeAll(async () => {
    appClient = new Client({
      user: appUser,
      password: appPassword,
      host,
      port,
      database,
    });
    await appClient.connect();
  });

  afterAll(async () => {
    if (appClient) {
      await appClient.end();
    }
  });

  it('connects successfully using restricted application role credentials', async () => {
    const roleRes = await appClient.query('SELECT current_user');
    expect(roleRes.rows[0].current_user).toBe(appUser);
  });

  it('permits SELECT, INSERT, UPDATE, and DELETE operations on domain tables within rolled back transaction', async () => {
    await appClient.query('BEGIN');
    try {
      // 1. INSERT permitted
      const insertRes = await appClient.query(
        "INSERT INTO department (department_name, department_code) VALUES ('Robotics Research', 'ROBO') RETURNING department_id"
      );
      expect(insertRes.rows.length).toBe(1);
      const deptId = insertRes.rows[0].department_id;

      // 2. SELECT permitted
      const selectRes = await appClient.query(
        'SELECT department_name FROM department WHERE department_id = $1',
        [deptId]
      );
      expect(selectRes.rows[0].department_name).toBe('Robotics Research');

      // 3. UPDATE permitted
      const updateRes = await appClient.query(
        "UPDATE department SET department_name = 'Advanced Robotics' WHERE department_id = $1 RETURNING department_name",
        [deptId]
      );
      expect(updateRes.rows[0].department_name).toBe('Advanced Robotics');

      // 4. DELETE permitted
      const deleteRes = await appClient.query(
        'DELETE FROM department WHERE department_id = $1',
        [deptId]
      );
      expect(deleteRes.rowCount).toBe(1);
    } finally {
      await appClient.query('ROLLBACK');
    }
  });

  it('denies DROP TABLE, ALTER TABLE, TRUNCATE, CREATE TABLE, and CREATE FUNCTION', async () => {
    await appClient.query('BEGIN');
    try {
      // Helper to test failure inside savepoint on appClient
      const expectAppFailure = async (sql: string, pattern: RegExp) => {
        await appClient.query('SAVEPOINT sp_app_fail');
        let threw = false;
        let caughtErr: unknown = null;
        try {
          await appClient.query(sql);
        } catch (err) {
          threw = true;
          caughtErr = err;
        } finally {
          await appClient.query('ROLLBACK TO SAVEPOINT sp_app_fail');
        }
        if (!threw) {
          throw new Error(`Expected statement to fail with ${pattern}, but succeeded: ${sql}`);
        }
        const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
        expect(msg).toMatch(pattern);
      };

      // DROP TABLE denied (requires table ownership)
      await expectAppFailure('DROP TABLE department', /(permission denied|must be owner)/i);

      // ALTER TABLE denied (requires table ownership)
      await expectAppFailure('ALTER TABLE department ADD COLUMN unauthorized_col text', /(permission denied|must be owner)/i);

      // TRUNCATE denied (requires TRUNCATE privilege)
      await expectAppFailure('TRUNCATE TABLE department', /permission denied/i);

      // CREATE TABLE denied (requires CREATE privilege on schema public)
      await expectAppFailure('CREATE TABLE unauthorized_table (id int)', /permission denied/i);

      // CREATE FUNCTION denied
      await expectAppFailure(
        `CREATE OR REPLACE FUNCTION dummy_trigger_func() RETURNS trigger AS $$
         BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;`,
        /permission denied/i
      );
    } finally {
      await appClient.query('ROLLBACK');
    }
  });

  it('denies CREATE TRIGGER on domain tables for restricted application role', async () => {
    // 1. As admin, create a trivial trigger function
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION dummy_noop_trigger() RETURNS trigger AS $$
      BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
    `);

    try {
      await appClient.query('BEGIN');
      try {
        await appClient.query('SAVEPOINT sp_trg_fail');
        let threw = false;
        let caughtErr: unknown = null;
        try {
          await appClient.query(`
            CREATE TRIGGER test_app_trg 
            BEFORE INSERT ON department 
            FOR EACH ROW EXECUTE FUNCTION dummy_noop_trigger();
          `);
        } catch (err) {
          threw = true;
          caughtErr = err;
        } finally {
          await appClient.query('ROLLBACK TO SAVEPOINT sp_trg_fail');
        }

        if (!threw) {
          throw new Error('Expected CREATE TRIGGER to fail for application role, but succeeded');
        }
        const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
        expect(msg).toMatch(/(permission denied|must be owner)/i);
      } finally {
        await appClient.query('ROLLBACK');
      }
    } finally {
      // 2. Cleanup function as admin
      await adminPool.query('DROP FUNCTION IF EXISTS dummy_noop_trigger()');
    }
  });

  it('permits SELECT and INSERT on audit_log while strictly denying UPDATE, DELETE, and TRUNCATE within rolled back transaction', async () => {
    await appClient.query('BEGIN');
    try {
      // 1. INSERT permitted
      const insertRes = await appClient.query(`
        INSERT INTO audit_log (entity_type, entity_id, action, remarks)
        VALUES ('EXPENDITURE', 101, 'SUBMIT', 'Audit submission permitted')
        RETURNING log_id;
      `);
      expect(insertRes.rows.length).toBe(1);
      const logId = insertRes.rows[0].log_id;

      // 2. SELECT permitted
      const selectRes = await appClient.query(
        'SELECT action, remarks FROM audit_log WHERE log_id = $1',
        [logId]
      );
      expect(selectRes.rows[0].action).toBe('SUBMIT');

      const expectAppFailure = async (sql: string, params: unknown[], pattern: RegExp) => {
        await appClient.query('SAVEPOINT sp_audit_fail');
        let threw = false;
        let caughtErr: unknown = null;
        try {
          await appClient.query(sql, params);
        } catch (err) {
          threw = true;
          caughtErr = err;
        } finally {
          await appClient.query('ROLLBACK TO SAVEPOINT sp_audit_fail');
        }
        if (!threw) {
          throw new Error(`Expected statement to fail with ${pattern}, but succeeded: ${sql}`);
        }
        const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
        expect(msg).toMatch(pattern);
      };

      // 3. UPDATE denied
      await expectAppFailure("UPDATE audit_log SET remarks = 'Tampered' WHERE log_id = $1", [logId], /permission denied/i);

      // 4. DELETE denied
      await expectAppFailure('DELETE FROM audit_log WHERE log_id = $1', [logId], /permission denied/i);

      // 5. TRUNCATE denied
      await expectAppFailure('TRUNCATE TABLE audit_log', [], /permission denied/i);
    } finally {
      await appClient.query('ROLLBACK');
    }

    // Verify audit_log has 0 rows left behind
    const auditCountRes = await adminPool.query('SELECT COUNT(*)::int AS count FROM audit_log');
    expect(auditCountRes.rows[0].count).toBe(0);
  });

  it('verifies privilege boundaries via PostgreSQL system catalog inspection', async () => {
    // 1. Check role flags in pg_roles
    const roleRes = await adminPool.query(
      'SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1',
      [appUser]
    );
    expect(roleRes.rows.length).toBe(1);
    expect(roleRes.rows[0].rolsuper).toBe(false);
    expect(roleRes.rows[0].rolcreaterole).toBe(false);
    expect(roleRes.rows[0].rolcreatedb).toBe(false);

    // 2. Check table ownership in pg_tables (owns no tables)
    const tablesOwnedRes = await adminPool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1",
      [appUser]
    );
    expect(tablesOwnedRes.rows.length).toBe(0);

    // 3. Check schema privileges (no CREATE on public)
    const schemaCreateRes = await adminPool.query(
      'SELECT has_schema_privilege($1, $2, $3) AS has_priv',
      [appUser, 'public', 'CREATE']
    );
    expect(schemaCreateRes.rows[0].has_priv).toBe(false);

    // 4. Check domain tables privileges
    const domainTables = [
      'department',
      'faculty',
      'users',
      'grant_record',
      'grant_account',
      'expenditure',
      'intellectual_property',
      'ip_author',
      'grant_ip',
    ];
    for (const table of domainTables) {
      const pTrunc = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, table, 'TRUNCATE']);
      const pTrig = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, table, 'TRIGGER']);
      const pRef = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, table, 'REFERENCES']);
      const pSel = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, table, 'SELECT']);
      const pIns = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, table, 'INSERT']);
      const pUpd = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, table, 'UPDATE']);
      const pDel = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, table, 'DELETE']);

      expect(pTrunc.rows[0].p).toBe(false);
      expect(pTrig.rows[0].p).toBe(false);
      expect(pRef.rows[0].p).toBe(false);
      expect(pSel.rows[0].p).toBe(true);
      expect(pIns.rows[0].p).toBe(true);
      expect(pUpd.rows[0].p).toBe(true);
      expect(pDel.rows[0].p).toBe(true);
    }

    // 5. Check audit_log privileges: SELECT and INSERT only
    const auditSel = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, 'audit_log', 'SELECT']);
    const auditIns = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, 'audit_log', 'INSERT']);
    const auditUpd = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, 'audit_log', 'UPDATE']);
    const auditDel = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, 'audit_log', 'DELETE']);
    const auditTrunc = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, 'audit_log', 'TRUNCATE']);
    const auditTrig = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, 'audit_log', 'TRIGGER']);
    const auditRef = await adminPool.query('SELECT has_table_privilege($1, $2, $3) AS p', [appUser, 'audit_log', 'REFERENCES']);

    expect(auditSel.rows[0].p).toBe(true);
    expect(auditIns.rows[0].p).toBe(true);
    expect(auditUpd.rows[0].p).toBe(false);
    expect(auditDel.rows[0].p).toBe(false);
    expect(auditTrunc.rows[0].p).toBe(false);
    expect(auditTrig.rows[0].p).toBe(false);
    expect(auditRef.rows[0].p).toBe(false);
  });

  it('permits SELECT on reporting views and EXECUTE on workflow routines for application role', async () => {
    // 1. SELECT on analytical views
    const v1 = await appClient.query('SELECT COUNT(*)::int AS cnt FROM v_grant_financial_summary');
    expect(v1.rows[0].cnt).toBeGreaterThanOrEqual(0);

    const v2 = await appClient.query('SELECT COUNT(*)::int AS cnt FROM v_department_expenditure_overview');
    expect(v2.rows[0].cnt).toBeGreaterThanOrEqual(0);

    const v3 = await appClient.query('SELECT COUNT(*)::int AS cnt FROM v_faculty_ip_portfolio');
    expect(v3.rows[0].cnt).toBeGreaterThanOrEqual(0);

    // 2. EXECUTE on search_ip_fulltext
    const searchRes = await appClient.query('SELECT * FROM search_ip_fulltext($1, $2)', ['quantum', 5]);
    expect(Array.isArray(searchRes.rows)).toBe(true);

    // 3. System catalog check for function EXECUTE privilege
    const routines = [
      'approve_expenditure(integer,integer)',
      'reject_or_revert_expenditure(integer,integer,text)',
      'approve_expenditure_proc(integer,integer,jsonb)',
      'reject_or_revert_expenditure_proc(integer,integer,text,jsonb)',
      'search_ip_fulltext(text,integer)',
    ];

    for (const routine of routines) {
      const privRes = await adminPool.query(
        'SELECT has_function_privilege($1, $2, $3) AS has_exec',
        [appUser, routine, 'EXECUTE']
      );
      expect(privRes.rows[0].has_exec).toBe(true);
    }
  });
});
