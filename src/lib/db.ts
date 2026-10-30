import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

// Ensure environment variables are loaded
dotenv.config();

const REQUIRED_ENV_VARS = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
] as const;

export function validateDbEnv(): {
  user: string;
  password: string;
  database: string;
  host: string;
  port: number;
} {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required database environment variable(s): ${missing.join(', ')}`
    );
  }

  const port = parseInt(process.env.POSTGRES_PORT!, 10);
  if (isNaN(port)) {
    throw new Error(`Invalid POSTGRES_PORT: ${process.env.POSTGRES_PORT}`);
  }

  return {
    user: process.env.POSTGRES_USER!,
    password: process.env.POSTGRES_PASSWORD!,
    database: process.env.POSTGRES_DB!,
    host: process.env.POSTGRES_HOST!,
    port,
  };
}

// Global cache to maintain a single pool across hot reloads in development
const globalForDb = globalThis as unknown as {
  dbPool?: Pool;
};

export function createPool(databaseOverride?: string): Pool {
  const config = validateDbEnv();
  return new Pool({
    user: config.user,
    password: config.password,
    database: databaseOverride ?? config.database,
    host: config.host,
    port: config.port,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

export const pool: Pool = globalForDb.dbPool ?? createPool();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.dbPool = pool;
}

export async function query<
  R extends QueryResultRow = QueryResultRow,
  I extends unknown[] = unknown[]
>(
  text: string,
  params?: I
): Promise<QueryResult<R>> {
  return pool.query<R>(text, params);
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  clientPool: Pool = pool
): Promise<T> {
  const client = await clientPool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
