import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '@/lib/db';

describe('Database Connection', () => {
  afterAll(async () => {
    // Keep pool open for subsequent tests or clean up if needed
  });

  it('connects successfully and reports PostgreSQL 16', async () => {
    const res = await pool.query('SELECT version()');
    expect(res.rows.length).toBe(1);
    const versionString = res.rows[0].version;
    expect(versionString).toMatch(/PostgreSQL 16\./);
  });
});
