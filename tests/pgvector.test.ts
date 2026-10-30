import { describe, it, expect } from 'vitest';
import { pool } from '@/lib/db';
import { formatPgVector } from '@/lib/embeddings';

describe('pgvector Extension and Operations', () => {
  it('verifies pgvector extension version is >= 0.8.0', async () => {
    const res = await pool.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
    );
    expect(res.rows.length).toBe(1);
    const version = res.rows[0].extversion;
    const [major, minor] = version.split('.').map(Number);
    expect(major > 0 || (major === 0 && minor >= 8)).toBe(true);
  });

  it('supports vector(384) operations, cosine distance ordering, and HNSW indexing', async () => {
    const client = await pool.connect();
    try {
      // 1. Create a temp table with vector(384)
      await client.query(`
        CREATE TEMP TABLE temp_vectors (
          id serial PRIMARY KEY,
          label text NOT NULL,
          embedding vector(384) NOT NULL
        );
      `);

      // 2. Generate three deterministic vectors:
      // Target: [1, 0, 0, ...]
      // Similar: [0.99, 0.05, 0, ...] normalized
      // Distant: [0, 1, 0, ...]
      const targetVec = new Array(384).fill(0);
      targetVec[0] = 1;

      const similarVec = new Array(384).fill(0);
      similarVec[0] = 0.99;
      similarVec[1] = 0.05;
      const simNorm = Math.sqrt(similarVec[0] ** 2 + similarVec[1] ** 2);
      similarVec[0] /= simNorm;
      similarVec[1] /= simNorm;

      const distantVec = new Array(384).fill(0);
      distantVec[1] = 1;

      // 3. Insert vectors
      await client.query(
        'INSERT INTO temp_vectors (label, embedding) VALUES ($1, $2), ($3, $4), ($5, $6)',
        [
          'target',
          formatPgVector(targetVec),
          'similar',
          formatPgVector(similarVec),
          'distant',
          formatPgVector(distantVec),
        ]
      );

      // 4. Verify cosine distance (<=>) ordering
      const searchRes = await client.query(
        `SELECT label, embedding <=> $1 AS distance
         FROM temp_vectors
         ORDER BY distance ASC`,
        [formatPgVector(targetVec)]
      );

      expect(searchRes.rows.length).toBe(3);
      expect(searchRes.rows[0].label).toBe('target');
      expect(searchRes.rows[0].distance).toBeCloseTo(0, 4);
      expect(searchRes.rows[1].label).toBe('similar');
      expect(searchRes.rows[2].label).toBe('distant');
      expect(searchRes.rows[1].distance).toBeLessThan(searchRes.rows[2].distance);

      // 5. Create an HNSW index with vector_cosine_ops, m=16, ef_construction=64
      await client.query(`
        CREATE INDEX temp_vectors_hnsw_idx
        ON temp_vectors
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
      `);

      // Verify index was created in pg_indexes
      const idxCheck = await client.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'temp_vectors' AND indexname = 'temp_vectors_hnsw_idx'"
      );
      expect(idxCheck.rows.length).toBe(1);
    } finally {
      client.release();
    }
  });

  it('confirms SHOW hnsw.iterative_scan setting exists in pgvector 0.8+', async () => {
    const res = await pool.query('SHOW hnsw.iterative_scan');
    expect(res.rows.length).toBe(1);
    const setting = res.rows[0]['hnsw.iterative_scan'];
    expect(setting).toBeDefined();
    expect(['off', 'relaxed', 'strict']).toContain(setting);
  });
});
