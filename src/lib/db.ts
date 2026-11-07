import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

// Ensure environment variables are loaded
dotenv.config();

const REQUIRED_ADMIN_VARS = [
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

export function validateAdminDbEnv(): DbConfig {
  const missing = REQUIRED_ADMIN_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required administrative database environment variable(s): ${missing.join(', ')}`
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

export function validateAppDbEnv(): DbConfig {
  const adminConfig = validateAdminDbEnv();
  const appUser = process.env.APP_DB_USER || adminConfig.user;
  const appPassword = process.env.APP_DB_PASSWORD || adminConfig.password;

  return {
    user: appUser,
    password: appPassword,
    database: adminConfig.database,
    host: adminConfig.host,
    port: adminConfig.port,
  };
}

// Global cache to maintain single pools across hot reloads in development
const globalForDb = globalThis as unknown as {
  appDbPool?: Pool;
  adminDbPool?: Pool;
};

export function createPool(config: DbConfig, databaseOverride?: string): Pool {
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
 * Returns the lazily initialized application runtime pool (connected via APP_DB_USER).
 */
export function getPool(databaseOverride?: string): Pool {
  if (databaseOverride) {
    return createPool(validateAppDbEnv(), databaseOverride);
  }
  if (!globalForDb.appDbPool) {
    globalForDb.appDbPool = createPool(validateAppDbEnv());
  }
  return globalForDb.appDbPool;
}

/**
 * Returns the lazily initialized administrative pool (used for migrations and administrative tests).
 */
export function getAdminPool(databaseOverride?: string): Pool {
  if (databaseOverride) {
    return createPool(validateAdminDbEnv(), databaseOverride);
  }
  if (!globalForDb.adminDbPool) {
    globalForDb.adminDbPool = createPool(validateAdminDbEnv());
  }
  return globalForDb.adminDbPool;
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
