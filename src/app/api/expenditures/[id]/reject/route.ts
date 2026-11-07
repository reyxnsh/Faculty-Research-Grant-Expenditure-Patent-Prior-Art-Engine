import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { withAuth, AuthenticatedUser, formatErrorResponse, parseJsonBody } from '@/lib/auth/guard';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const rejectSchema = z.object({
  reason: z.string().min(1, 'Rejection reason is required').max(2000).optional(),
  rejection_reason: z.string().min(1, 'Rejection reason is required').max(2000).optional(),
}).refine((data) => (data.reason && data.reason.trim().length > 0) || (data.rejection_reason && data.rejection_reason.trim().length > 0), {
  message: 'Rejection reason is required and cannot be empty',
});

/**
 * POST /api/expenditures/[id]/reject
 * - ADMIN only: Rejects or reverts an expenditure claim
 * - Admin identity is derived exclusively from the session; any body-supplied ID is ignored.
 */
export const POST = withAuth(
  async (
    request: Request,
    user: AuthenticatedUser,
    context?: { params?: Promise<Record<string, string | string[]>> }
  ) => {
    const rawParams = await (context as unknown as RouteContext)?.params;
    const rawId = rawParams?.id;
    const transactionId = parseInt(String(rawId), 10);

    if (isNaN(transactionId) || transactionId <= 0) {
      return NextResponse.json({ error: 'Invalid transaction ID parameter' }, { status: 400 });
    }

    const { data: body, errorResponse } = await parseJsonBody(request);
    if (errorResponse) {
      return errorResponse;
    }

    const parseResult = rejectSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues[0]?.message || 'Rejection reason is required' },
        { status: 400 }
      );
    }

    const reason = (parseResult.data.reason || parseResult.data.rejection_reason)!.trim();
    const pool = getPool();

    try {
      const res = await pool.query(
        'SELECT reject_or_revert_expenditure($1, $2, $3) AS outcome',
        [transactionId, user.id, reason]
      );

      return NextResponse.json(res.rows[0].outcome, { status: 200 });
    } catch (err) {
      return formatErrorResponse(err);
    }
  },
  { roles: ['ADMIN'] }
);
