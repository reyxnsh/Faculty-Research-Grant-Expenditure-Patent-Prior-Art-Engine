import { describe, it, expect } from 'vitest';
import { getAdminPool, withTransaction } from '@/lib/db';
import { formatPgVector } from '@/lib/embeddings';

describe('Schema Indexes & Vector HNSW Retrieval Plan', () => {
  const pool = getAdminPool();

  it('verifies all expected B-tree, GIN, and HNSW indexes exist in pg_indexes', async () => {
    const res = await pool.query(`
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname;
    `);

    const indexNames = res.rows.map((r) => r.indexname);

    // Foreign key and filter B-tree indexes
    expect(indexNames).toContain('idx_faculty_dept');
    expect(indexNames).toContain('idx_grant_pi');
    expect(indexNames).toContain('idx_account_grant');
    expect(indexNames).toContain('idx_expenditure_account');
    expect(indexNames).toContain('idx_expenditure_submitted_by');
    expect(indexNames).toContain('idx_expenditure_status_date');
    expect(indexNames).toContain('idx_ip_author_faculty');
    expect(indexNames).toContain('idx_grant_ip_document');
    expect(indexNames).toContain('idx_audit_entity');

    // Full-text search and vector indexes
    expect(indexNames).toContain('idx_ip_tsv_gin');
    expect(indexNames).toContain('idx_ip_embedding_hnsw');
  });

  it('verifies HNSW index parameters (m=16, ef_construction=64) and GIN index access method', async () => {
    const res = await pool.query(`
      SELECT c.relname AS index_name, am.amname AS access_method, c.reloptions
      FROM pg_class c
      JOIN pg_am am ON c.relam = am.oid
      WHERE c.relname IN ('idx_ip_embedding_hnsw', 'idx_ip_tsv_gin');
    `);

    interface IndexClassRow {
      index_name: string;
      access_method: string;
      reloptions: string[] | null;
    }
    const byName = new Map<string, IndexClassRow>(
      res.rows.map((r) => [r.index_name, r as IndexClassRow])
    );

    const hnswIndex = byName.get('idx_ip_embedding_hnsw');
    expect(hnswIndex).toBeDefined();
    if (!hnswIndex) throw new Error('idx_ip_embedding_hnsw not found');
    expect(hnswIndex.access_method).toBe('hnsw');
    expect(hnswIndex.reloptions).toContain('m=16');
    expect(hnswIndex.reloptions).toContain('ef_construction=64');

    const ginIndex = byName.get('idx_ip_tsv_gin');
    expect(ginIndex).toBeDefined();
    if (!ginIndex) throw new Error('idx_ip_tsv_gin not found');
    expect(ginIndex.access_method).toBe('gin');
  });

  it('proves HNSW index scan execution via EXPLAIN with enable_seqscan = off', async () => {
    await withTransaction(async (client) => {
      // 1. Insert multiple documents with distinct vector embeddings
      for (let i = 0; i < 20; i++) {
        const vec = new Array(384).fill(0);
        vec[i % 384] = 1;
        await client.query(
          `INSERT INTO intellectual_property (doc_type, title, abstract, embedding)
           VALUES ('PATENT', $1, $2, $3)`,
          [`Patent Title ${i}`, `Abstract content for patent disclosure ${i}`, formatPgVector(vec)]
        );
      }

      // 2. Disable sequential scans locally to force index evaluation
      await client.query('SET LOCAL enable_seqscan = off');

      const targetVec = new Array(384).fill(0);
      targetVec[0] = 1;

      // 3. Inspect query execution plan
      const planRes = await client.query(
        `EXPLAIN (COSTS OFF)
         SELECT document_id, title
         FROM intellectual_property
         ORDER BY embedding <=> $1
         LIMIT 5`,
        [formatPgVector(targetVec)]
      );

      const planLines = planRes.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(planLines).toMatch(/Index Scan.*using idx_ip_embedding_hnsw/i);
    }, pool);
  });
});
