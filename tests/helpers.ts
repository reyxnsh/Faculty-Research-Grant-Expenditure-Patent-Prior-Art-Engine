import { PoolClient } from 'pg';
import { getAdminPool } from '@/lib/db';
import { expect } from 'vitest';

/**
 * Executes a callback within a database transaction that is ALWAYS rolled back.
 * Guarantees zero committed rows across test runs and ensures client release.
 */
export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getAdminPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    return result;
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // rollback error suppressed to avoid masking original callback error
    }
    client.release();
  }
}

/**
 * Asserts that executing a query fails with an error message matching the provided regex.
 * Runs inside a SAVEPOINT to preserve outer transaction usability on database errors.
 * Fails the test if the statement unexpectedly succeeds or matches the wrong error pattern.
 */
export async function expectQueryError(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
  expectedRegex: RegExp
): Promise<void> {
  await client.query('SAVEPOINT eqe_sp');
  let threw = false;
  let caughtError: unknown = null;

  try {
    await client.query(sql, params);
  } catch (err) {
    threw = true;
    caughtError = err;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT eqe_sp');
    await client.query('RELEASE SAVEPOINT eqe_sp');
  }

  if (!threw) {
    throw new Error(`Expected statement to fail with ${expectedRegex}, but it succeeded: ${sql}`);
  }

  const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
  expect(message).toMatch(expectedRegex);
}
