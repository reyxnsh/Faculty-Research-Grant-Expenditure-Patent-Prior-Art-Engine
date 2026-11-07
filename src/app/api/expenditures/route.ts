import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { withAuth, AuthenticatedUser, formatErrorResponse, parseJsonBody } from '@/lib/auth/guard';

function isValidCalendarDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (year < 2000 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

const submitExpenditureSchema = z.object({
  account_id: z.number().int().positive('account_id must be a positive integer'),
  amount: z
    .number()
    .positive('amount must be greater than zero')
    .max(9999999999.99, 'amount cannot exceed 9999999999.99')
    .refine((val) => Number(val.toFixed(2)) === val, {
      message: 'amount must have at most 2 decimal places',
    }),
  description: z.string().min(1, 'description is required').max(2000),
  invoice_reference: z.string().max(100).nullable().optional(),
  transaction_date: z
    .string()
    .refine((val) => isValidCalendarDate(val), {
      message: 'transaction_date must be a valid calendar date (YYYY-MM-DD) between 2000 and 2100',
    })
    .optional(),
});

/**
 * GET /api/expenditures
 * - ADMIN: Retrieves all expenditures (optional filters: ?status=PENDING&grant_id=1)
 * - FACULTY: Retrieves only expenditures for grants where they are the Principal Investigator
 */
export const GET = withAuth(
  async (request: Request, user: AuthenticatedUser) => {
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get('status');
    const grantIdFilter = url.searchParams.get('grant_id');

    const pool = getPool();

    try {
      let query = `
        SELECT e.transaction_id, e.account_id, e.submitted_by, e.approved_by,
               e.amount, e.description, e.invoice_reference, e.transaction_date,
               e.status, e.decision_date, e.rejection_reason, e.created_at, e.updated_at,
               ga.category, gr.grant_id, gr.grant_code
        FROM expenditure e
        JOIN grant_account ga ON e.account_id = ga.account_id
        JOIN grant_record gr ON ga.grant_id = gr.grant_id
      `;

      const conditions: string[] = [];
      const params: unknown[] = [];

      // FACULTY role is strictly restricted to their own grants
      if (user.role === 'FACULTY') {
        if (!user.facultyId) {
          return NextResponse.json(
            { error: 'Forbidden: User is not linked to a faculty profile' },
            { status: 403 }
          );
        }
        params.push(user.facultyId);
        conditions.push(`gr.pi_faculty_id = $${params.length}`);
      }

      if (statusFilter !== null) {
        const upperStatus = statusFilter.toUpperCase();
        if (!['PENDING', 'APPROVED', 'REJECTED'].includes(upperStatus)) {
          return NextResponse.json(
            { error: 'Invalid status filter. Allowed values: PENDING, APPROVED, REJECTED' },
            { status: 400 }
          );
        }
        params.push(upperStatus);
        conditions.push(`e.status = $${params.length}`);
      }

      if (grantIdFilter !== null) {
        if (!/^\d+$/.test(grantIdFilter) || parseInt(grantIdFilter, 10) <= 0) {
          return NextResponse.json(
            { error: 'Invalid grant_id filter. Must be a positive integer' },
            { status: 400 }
          );
        }
        params.push(parseInt(grantIdFilter, 10));
        conditions.push(`gr.grant_id = $${params.length}`);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ` ORDER BY e.created_at DESC`;

      const res = await pool.query(query, params);
      return NextResponse.json({ expenditures: res.rows });
    } catch (err) {
      return formatErrorResponse(err);
    }
  },
  { roles: ['ADMIN', 'FACULTY'] }
);

/**
 * POST /api/expenditures
 * - FACULTY only: Submits an expenditure claim for a grant account
 * - Submitter identity is derived exclusively from the session; body parameters for submitter are ignored.
 */
export const POST = withAuth(
  async (request: Request, user: AuthenticatedUser) => {
    if (!user.facultyId) {
      return NextResponse.json(
        { error: 'Forbidden: Submitting user is not linked to a faculty member' },
        { status: 403 }
      );
    }

    const { data: body, errorResponse } = await parseJsonBody(request);
    if (errorResponse) {
      return errorResponse;
    }

    const parseResult = submitExpenditureSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues[0]?.message || 'Validation error' },
        { status: 400 }
      );
    }

    const { account_id, amount, description, invoice_reference, transaction_date } = parseResult.data;
    const pool = getPool();

    try {
      // Note: Triggers enforce PI check, active grant check, date bounds, and initial PENDING status
      const res = await pool.query(
        `INSERT INTO expenditure (
          account_id, submitted_by, amount, description, invoice_reference, transaction_date
        ) VALUES (
          $1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE)
        ) RETURNING *`,
        [account_id, user.facultyId, amount, description, invoice_reference ?? null, transaction_date ?? null]
      );

      return NextResponse.json({ expenditure: res.rows[0] }, { status: 201 });
    } catch (err) {
      return formatErrorResponse(err);
    }
  },
  { roles: ['FACULTY'] }
);
