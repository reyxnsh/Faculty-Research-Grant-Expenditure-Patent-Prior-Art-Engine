import { describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import path from 'path';

describe('Database Migrations (node-pg-migrate)', () => {
  it('executes the complete migration chain up, down to zero, and up again on a scratch database with no leftovers', async () => {
    const user = process.env.POSTGRES_USER!;
    const password = process.env.POSTGRES_PASSWORD!;
    const host = process.env.POSTGRES_HOST!;
    const port = parseInt(process.env.POSTGRES_PORT!, 10);
    const baseDb = process.env.POSTGRES_DB?.replace(/_test$/, '') || 'grant_priorart_db';
    const migDb = `${baseDb}_migtest`;

    const adminClient = new Client({
      user,
      password,
      host,
      port,
      database: 'postgres',
    });
    await adminClient.connect();

    try {
      const escapedDb = adminClient.escapeIdentifier(migDb);

      // 1. Initialize fresh scratch database
      await adminClient.query(`DROP DATABASE IF EXISTS ${escapedDb} WITH (FORCE);`);
      await adminClient.query(`CREATE DATABASE ${escapedDb};`);

      const migDbUrl = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(migDb)}`;
      const migrationsDir = path.resolve(process.cwd(), 'migrations');

      // 2. Run migrations UP to completion
      await runner({
        databaseUrl: migDbUrl,
        dir: migrationsDir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        verbose: false,
      });

      // Verify UP state: all 13 migrations present and domain tables created
      const checkClient = new Client({
        user,
        password,
        host,
        port,
        database: migDb,
      });
      await checkClient.connect();

      try {
        const upMigRes = await checkClient.query(
          'SELECT name FROM pgmigrations ORDER BY id ASC'
        );
        expect(upMigRes.rows.length).toBe(13);
        expect(upMigRes.rows.map((r) => r.name)).toEqual([
          '001_enable_extensions',
          '002_department_faculty_users',
          '003_grant_account',
          '004_expenditure',
          '005_intellectual_property',
          '006_audit_log',
          '007_indexes',
          '008_application_role',
          '009_integrity_triggers',
          '010_workflow_routines',
          '011_reporting_views',
          '012_fulltext_search',
          '013_application_role_permissions',
        ]);

        const tablesRes = await checkClient.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name;
        `);
        const tableNames = tablesRes.rows.map((r) => r.table_name);
        expect(tableNames).toContain('department');
        expect(tableNames).toContain('faculty');
        expect(tableNames).toContain('users');
        expect(tableNames).toContain('grant_record');
        expect(tableNames).toContain('grant_account');
        expect(tableNames).toContain('expenditure');
        expect(tableNames).toContain('intellectual_property');
        expect(tableNames).toContain('ip_author');
        expect(tableNames).toContain('grant_ip');
        expect(tableNames).toContain('audit_log');

        const viewsRes = await checkClient.query(`
          SELECT table_name
          FROM information_schema.views
          WHERE table_schema = 'public'
          ORDER BY table_name;
        `);
        const viewNames = viewsRes.rows.map((r) => r.table_name);
        expect(viewNames).toContain('v_grant_financial_summary');
        expect(viewNames).toContain('v_department_expenditure_overview');
        expect(viewNames).toContain('v_faculty_ip_portfolio');
      } finally {
        await checkClient.end();
      }

      // 3. Run migrations DOWN all the way to zero
      await runner({
        databaseUrl: migDbUrl,
        dir: migrationsDir,
        direction: 'down',
        count: 13,
        migrationsTable: 'pgmigrations',
        verbose: false,
      });

      // Verify DOWN state: zero migrations recorded, domain tables dropped
      const downClient = new Client({
        user,
        password,
        host,
        port,
        database: migDb,
      });
      await downClient.connect();

      try {
        const downMigRes = await downClient.query(
          'SELECT name FROM pgmigrations'
        );
        expect(downMigRes.rows.length).toBe(0);

        const downTablesRes = await downClient.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'pgmigrations';
        `);
        expect(downTablesRes.rows.length).toBe(0);

        const extRes = await downClient.query(
          "SELECT extname FROM pg_extension WHERE extname = 'vector'"
        );
        expect(extRes.rows.length).toBe(0);
      } finally {
        await downClient.end();
      }

      // 4. Run migrations UP again
      await runner({
        databaseUrl: migDbUrl,
        dir: migrationsDir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        verbose: false,
      });

      // Verify UP again state
      const reUpClient = new Client({
        user,
        password,
        host,
        port,
        database: migDb,
      });
      await reUpClient.connect();

      try {
        const reUpMigRes = await reUpClient.query(
          'SELECT name FROM pgmigrations ORDER BY id ASC'
        );
        expect(reUpMigRes.rows.length).toBe(13);
      } finally {
        await reUpClient.end();
      }
    } finally {
      // 5. Clean up scratch database leaving zero leftovers
      const escapedDb = adminClient.escapeIdentifier(migDb);
      await adminClient.query(`DROP DATABASE IF EXISTS ${escapedDb} WITH (FORCE);`);
      await adminClient.end();
    }
  });
});
