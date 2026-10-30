import dotenv from 'dotenv';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import path from 'path';

dotenv.config();

export async function setup() {
  const user = process.env.POSTGRES_USER || 'grant_admin';
  const password = process.env.POSTGRES_PASSWORD || '';
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = parseInt(process.env.POSTGRES_PORT || '5433', 10);
  const baseDb = process.env.POSTGRES_DB || 'grant_priorart_db';
  const testDb = baseDb.endsWith('_test') ? baseDb : `${baseDb}_test`;

  // Connect to default postgres database to drop and recreate test database
  const client = new Client({
    user,
    password,
    host,
    port,
    database: 'postgres',
  });

  await client.connect();

  try {
    // Terminate existing connections and drop test database
    await client.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE);`);
    await client.query(`CREATE DATABASE ${testDb};`);
  } finally {
    await client.end();
  }

  // Run migrations against the newly created test database
  const testDbUrl = `postgres://${user}:${password}@${host}:${port}/${testDb}`;
  await runner({
    databaseUrl: testDbUrl,
    dir: path.resolve(process.cwd(), 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
}
