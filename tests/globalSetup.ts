import dotenv from 'dotenv';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import path from 'path';

dotenv.config();

const REQUIRED_SETUP_VARS = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
] as const;

export async function setup() {
  const missing = REQUIRED_SETUP_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `tests/globalSetup.ts: missing required environment variable(s): ${missing.join(', ')}`
    );
  }

  const user = process.env.POSTGRES_USER!;
  const password = process.env.POSTGRES_PASSWORD!;
  const host = process.env.POSTGRES_HOST!;
  const port = parseInt(process.env.POSTGRES_PORT!, 10);
  if (isNaN(port)) {
    throw new Error(`tests/globalSetup.ts: invalid POSTGRES_PORT: ${process.env.POSTGRES_PORT}`);
  }

  const baseDb = process.env.POSTGRES_DB!;
  const testDb = baseDb.endsWith('_test') ? baseDb : `${baseDb}_test`;

  // Connect to default maintenance database via structured configuration object
  const client = new Client({
    user,
    password,
    host,
    port,
    database: 'postgres',
  });

  await client.connect();

  try {
    // Safely quote the database identifier using pg's identifier escaping
    const escapedDb = client.escapeIdentifier(testDb);
    await client.query(`DROP DATABASE IF EXISTS ${escapedDb} WITH (FORCE);`);
    await client.query(`CREATE DATABASE ${escapedDb};`);
  } finally {
    await client.end();
  }

  // Construct URL with encoded credentials for node-pg-migrate
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  const encodedDb = encodeURIComponent(testDb);
  const testDbUrl = `postgres://${encodedUser}:${encodedPassword}@${host}:${port}/${encodedDb}`;

  await runner({
    databaseUrl: testDbUrl,
    dir: path.resolve(process.cwd(), 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
  });
}
