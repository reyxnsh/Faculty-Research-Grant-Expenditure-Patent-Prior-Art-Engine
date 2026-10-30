import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET() {
  try {
    const pingResult = await query('SELECT 1 AS ok');
    const isDbConnected = pingResult.rows.length > 0 && pingResult.rows[0].ok === 1;

    const extResult = await query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
    );
    const pgvectorVersion = extResult.rows.length > 0 ? extResult.rows[0].extversion : null;

    return NextResponse.json({
      status: 'ok',
      db: isDbConnected,
      pgvector: pgvectorVersion,
    });
  } catch {
    return NextResponse.json(
      {
        status: 'error',
        message: 'Service unavailable',
      },
      { status: 503 }
    );
  }
}
