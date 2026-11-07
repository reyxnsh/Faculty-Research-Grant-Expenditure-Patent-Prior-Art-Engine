import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { withAuth, AuthenticatedUser, formatErrorResponse } from '@/lib/auth/guard';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/expenditures/[id]/approve
 * - ADMIN only: Approves a pending expenditure claim
 * - Admin identity is derived exclusively from the session; any body-supplied ID is ignored.
 */
export const POST = withAuth(
  async (
    _request: Request,
    user: AuthenticatedUser,
    context?: { params?: Promise<Record<string, string | string[]>> }
  ) => {
    const rawParams = await (context as unknown as RouteContext)?.params;
    const rawId = rawParams?.id;
    const transactionId = parseInt(String(rawId), 10);

    if (isNaN(transactionId) || transactionId <= 0) {
      return NextResponse.json({ error: 'Invalid transaction ID parameter' }, { status: 400 });
    }

    const pool = getPool();

    try {
      const res = await pool.query(
        'SELECT approve_expenditure($1, $2) AS outcome',
        [transactionId, user.id]
      );

      return NextResponse.json(res.rows[0].outcome, { status: 200 });
    } catch (err) {
      return formatErrorResponse(err);
    }
  },
  { roles: ['ADMIN'] }
);
