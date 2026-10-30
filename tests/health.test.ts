import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/health/route';

describe('Health API Route Handler', () => {
  it('returns status ok, db true, and pgvector version', async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('status', 'ok');
    expect(data).toHaveProperty('db', true);
    expect(typeof data.pgvector).toBe('string');
    expect(data.pgvector).toMatch(/^0\.8\./);
  });
});
