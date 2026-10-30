import { describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import path from 'path';

describe('Database Migrations (node-pg-migrate)', () => {
  it('executes up, down, and up again cleanly on a scratch database with no leftovers', async () => {
    const user = process.env.POSTGRES_USER || 'grant_admin';
    const password = process.env.POSTGRES_PASSWORD || '';
    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = parseInt(process.env.POSTGRES_PORT || '5433', 10);
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
      // 1. Initialize fresh scratch database
      await adminClient.query(`DROP DATABASE IF EXISTS ${migDb} WITH (FORCE);`);
      await adminClient.query(`CREATE DATABASE ${migDb};`);

      const migDbUrl = `postgres://${user}:${password}@${host}:${port}/${migDb}`;
      const migrationsDir = path.resolve(process.cwd(), 'migrations');

      // 2. Run migrations UP
      await runner({
        databaseUrl: migDbUrl,
        dir: migrationsDir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
      });

      // Verify UP state
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
          "SELECT name FROM pgmigrations WHERE name = '001_enable_extensions'"
        );
        expect(upMigRes.rows.length).toBe(1);

        const upExtRes = await checkClient.query(
          "SELECT extname FROM pg_extension WHERE extname = 'vector'"
        );
        expect(upExtRes.rows.length).toBe(1);
      } finally {
        await checkClient.end();
      }

      // 3. Run migrations DOWN
      await runner({
        databaseUrl: migDbUrl,
        dir: migrationsDir,
        direction: 'down',
        migrationsTable: 'pgmigrations',
      });

      // Verify DOWN state
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
          "SELECT name FROM pgmigrations WHERE name = '001_enable_extensions'"
        );
        expect(downMigRes.rows.length).toBe(0);

        const downExtRes = await downClient.query(
          "SELECT extname FROM pg_extension WHERE extname = 'vector'"
        );
        expect(downExtRes.rows.length).toBe(0);
      } finally {
        await downClient.end();
      }

      // 4. Run migrations UP again
      await runner({
        databaseUrl: migDbUrl,
        dir: migrationsDir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
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
          "SELECT name FROM pgmigrations WHERE name = '001_enable_extensions'"
        );
        expect(reUpMigRes.rows.length).toBe(1);

        const reUpExtRes = await reUpClient.query(
          "SELECT extname FROM pg_extension WHERE extname = 'vector'"
        );
        expect(reUpExtRes.rows.length).toBe(1);
      } finally {
        await reUpClient.end();
      }
    } finally {
      // 5. Clean up scratch database leaving zero leftovers
      await adminClient.query(`DROP DATABASE IF EXISTS ${migDb} WITH (FORCE);`);
      await adminClient.end();
    }
  });
});
