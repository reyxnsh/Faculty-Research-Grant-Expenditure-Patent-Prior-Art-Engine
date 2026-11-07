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

export interface DbConfig {
  user: string;
  password: string;
  database: string;
  host: string;
  port: number;
}

export function validateDbEnv(): DbConfig {
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
  const poolInstance = new Pool({
    user: config.user,
    password: config.password,
    database: databaseOverride ?? config.database,
    host: config.host,
    port: config.port,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  poolInstance.on('error', (err) => {
    console.error('Unexpected error on idle database client:', err.message);
  });

  return poolInstance;
}

/**
 * Returns the lazily initialized default connection pool.
 */
export function getPool(): Pool {
  if (!globalForDb.dbPool) {
    globalForDb.dbPool = createPool();
  }
  return globalForDb.dbPool;
}

// Lazy proxy export ensuring importing this module does not eagerly initialize the pool
export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const targetPool = getPool();
    const value = Reflect.get(targetPool, prop, receiver);
    return typeof value === 'function' ? value.bind(targetPool) : value;
  },
});

export async function query<
  R extends QueryResultRow = QueryResultRow,
  I extends unknown[] = unknown[]
>(
  text: string,
  params?: I
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params);
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  clientPool?: Pool
): Promise<T> {
  const targetPool = clientPool ?? getPool();
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (originalError) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        'Failed to rollback transaction:',
        rollbackError instanceof Error ? rollbackError.message : rollbackError
      );
    }
    throw originalError;
  } finally {
    client.release();
  }
}

export default pool;
