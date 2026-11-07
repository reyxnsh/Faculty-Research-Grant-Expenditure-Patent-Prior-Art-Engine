import { NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from './session';
import { getPool } from '@/lib/db';

export interface AuthenticatedUser {
  id: number;
  email: string;
  role: 'ADMIN' | 'FACULTY';
  facultyId: number | null;
}

export type AuthenticatedHandler<TContext = unknown> = (
  request: Request,
  user: AuthenticatedUser,
  context?: TContext
) => Promise<Response>;

export interface GuardOptions {
  roles?: Array<'ADMIN' | 'FACULTY'>;
}

export const MAX_BODY_BYTES = 65536; // 64 KB body size limit

/**
 * Validates request payload size and safely parses JSON content.
 * Returns HTTP 413 if the payload exceeds 64 KB, or 400 if JSON is malformed.
 */
export async function parseJsonBody<T = unknown>(
  request: Request
): Promise<{ data?: T; errorResponse?: NextResponse }> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Payload Too Large: Request body exceeds maximum allowed size' },
        { status: 413 }
      ),
    };
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      errorResponse: NextResponse.json({ error: 'Failed to read request body' }, { status: 400 }),
    };
  }

  if (text.length > MAX_BODY_BYTES) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Payload Too Large: Request body exceeds maximum allowed size' },
        { status: 413 }
      ),
    };
  }

  try {
    const data = JSON.parse(text) as T;
    return { data };
  } catch {
    return {
      errorResponse: NextResponse.json({ error: 'Invalid JSON request payload' }, { status: 400 }),
    };
  }
}

/**
 * Validates request origin and headers to guard state-changing methods against CSRF attacks.
 */
export function validateCsrf(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const secFetchSite = request.headers.get('sec-fetch-site');

  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) {
    return false;
  }

  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return false;
  }

  return true;
}

/**
 * Extracts session token from Cookie header.
 * Only accepts SESSION_COOKIE_NAME, splits on the first '=' only, and handles malformed percent-encoding safely.
 */
export function extractSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const c of cookies) {
    const eqIdx = c.indexOf('=');
    if (eqIdx === -1) continue;
    const name = c.slice(0, eqIdx).trim();
    const val = c.slice(eqIdx + 1).trim();
    if (name === SESSION_COOKIE_NAME && val) {
      try {
        return decodeURIComponent(val);
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Higher-order Route Handler wrapper enforcing authentication, live role verification,
 * account lockout status, and CSRF protection.
 */
export function withAuth<TContext = unknown>(
  handler: AuthenticatedHandler<TContext>,
  options: GuardOptions = {}
) {
  return async (request: Request, context?: TContext): Promise<Response> => {
    // 1. CSRF Protection for mutating methods
    if (!validateCsrf(request)) {
      return NextResponse.json(
        { error: 'Forbidden: Request failed CSRF validation' },
        { status: 403 }
      );
    }

    // 2. Cookie Extraction & Session Verification
    const token = extractSessionCookie(request);
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized: Missing session authentication' },
        { status: 401 }
      );
    }

    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: 'Unauthorized: Session token is invalid or expired' },
        { status: 401 }
      );
    }

    // 3. Live database user verification using restricted application pool
    const pool = getPool();
    try {
      const userRes = await pool.query(
        `SELECT user_id, email, role, faculty_id, is_active, locked_until
         FROM users
         WHERE user_id = $1`,
        [payload.userId]
      );

      if (userRes.rows.length === 0) {
        return NextResponse.json(
          { error: 'Unauthorized: User account not found' },
          { status: 401 }
        );
      }

      const dbUser = userRes.rows[0];

      // Immediately reject deactivated users
      if (!dbUser.is_active) {
        return NextResponse.json(
          { error: 'Unauthorized: User account has been deactivated' },
          { status: 401 }
        );
      }

      // Check lockout status
      if (dbUser.locked_until && new Date(dbUser.locked_until) > new Date()) {
        return NextResponse.json(
          { error: 'Unauthorized: Account is temporarily locked' },
          { status: 401 }
        );
      }

      // 4. Role-based access control
      if (options.roles && !options.roles.includes(dbUser.role)) {
        return NextResponse.json(
          { error: 'Forbidden: Insufficient privileges for this operation' },
          { status: 403 }
        );
      }

      const authenticatedUser: AuthenticatedUser = {
        id: dbUser.user_id,
        email: dbUser.email,
        role: dbUser.role,
        facultyId: dbUser.faculty_id !== null ? Number(dbUser.faculty_id) : null,
      };

      return await handler(request, authenticatedUser, context);
    } catch (err) {
      return formatErrorResponse(err);
    }
  };
}

/**
 * Formats caught database exceptions into safe HTTP responses with appropriate status codes,
 * strictly preventing stack traces, SQL syntax, or internal table schemas from leaking.
 */
export function formatErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;

  // 1. Business rule exceptions from database triggers/procedures (SQLSTATE P0001)
  if (code === 'P0001') {
    // 404 Not Found: Specific missing entity exceptions only
    if (/Target grant with ID.*does not exist/i.test(message) ||
        /Parent grant account not found/i.test(message) ||
        /Expenditure with transaction ID.*does not exist/i.test(message)) {
      return NextResponse.json({ error: 'Requested entity was not found' }, { status: 404 });
    }

    // 403 Forbidden: Domain authorization & permission rules
    if (/an approver cannot decide their own expenditure/i.test(message)) {
      return NextResponse.json({ error: 'An approver cannot decide their own claim' }, { status: 403 });
    }
    if (/must be an active ADMIN/i.test(message) || /Authorization failure/i.test(message)) {
      return NextResponse.json({ error: 'Administrative role required for this action' }, { status: 403 });
    }
    if (/is not the Principal Investigator/i.test(message)) {
      return NextResponse.json({ error: 'Only the Principal Investigator can submit claims for this grant' }, { status: 403 });
    }
    if (/only ACTIVE grants accept expenses/i.test(message)) {
      return NextResponse.json({ error: 'Claims can only be submitted for active grants' }, { status: 403 });
    }
    if (/Direct update of current_balance/i.test(message)) {
      return NextResponse.json({ error: 'Direct modification of account balance is prohibited' }, { status: 403 });
    }
    if (/audit_log is append-only/i.test(message)) {
      return NextResponse.json({ error: 'Audit records are permanent and cannot be altered or removed' }, { status: 403 });
    }

    // 409 Conflict: Domain state machine conflicts, balance constraints, frozen records
    if (/Insufficient balance/i.test(message)) {
      return NextResponse.json({ error: 'Insufficient account balance for this transaction' }, { status: 409 });
    }
    if (/Illegal status transition/i.test(message)) {
      return NextResponse.json({ error: 'Illegal status transition for claim' }, { status: 409 });
    }
    if (/Cannot approve: Expenditure/i.test(message) || /only PENDING claims can be approved/i.test(message)) {
      return NextResponse.json({ error: 'Only pending claims can be approved' }, { status: 409 });
    }
    if (/Cannot reject: Expenditure/i.test(message) || /already in REJECTED status/i.test(message)) {
      return NextResponse.json({ error: 'Claim is already rejected' }, { status: 409 });
    }
    if (/Cannot approve expenditure/i.test(message) || /Associated grant is/i.test(message)) {
      return NextResponse.json({ error: 'Claim cannot be approved because the associated grant is not active' }, { status: 409 });
    }
    if (/is already/i.test(message) && /cannot be modified/i.test(message)) {
      return NextResponse.json({ error: 'Decided claims cannot be modified' }, { status: 409 });
    }
    if (/cannot be modified once/i.test(message)) {
      return NextResponse.json({ error: 'Amount cannot be modified on decided claims' }, { status: 409 });
    }
    if (/Allocation violation/i.test(message) || /exceeds sanctioned grant budget/i.test(message)) {
      return NextResponse.json({ error: 'Budget allocation ceiling exceeded' }, { status: 409 });
    }
    if (/Cannot reduce total budget/i.test(message)) {
      return NextResponse.json({ error: 'Cannot reduce budget below allocated accounts' }, { status: 409 });
    }
    if (/negative balance/i.test(message)) {
      return NextResponse.json({ error: 'Budget reduction would cause negative account balance' }, { status: 409 });
    }

    // 400 Bad Request: Input data, immutability, date window validation
    if (/falls outside grant active window/i.test(message)) {
      return NextResponse.json({ error: 'Transaction date falls outside the active grant window' }, { status: 400 });
    }
    if (/Rejection reason is required/i.test(message)) {
      return NextResponse.json({ error: 'Rejection reason is required' }, { status: 400 });
    }
    if (/New expenditure must be submitted with status PENDING/i.test(message)) {
      return NextResponse.json({ error: 'New claims must be submitted in pending status' }, { status: 400 });
    }
    if (/account_id on expenditure/i.test(message) && /cannot be changed/i.test(message)) {
      return NextResponse.json({ error: 'Claim account cannot be modified' }, { status: 400 });
    }
    if (/submitted_by on expenditure/i.test(message) && /cannot be changed/i.test(message)) {
      return NextResponse.json({ error: 'Claim submitter cannot be modified' }, { status: 400 });
    }
    if (/grant_id on account/i.test(message) && /cannot be changed/i.test(message)) {
      return NextResponse.json({ error: 'Account allocation cannot be modified' }, { status: 400 });
    }
  }

  // 2. Explicit SQLSTATE mappings
  if (code === '23505') {
    return NextResponse.json({ error: 'Resource conflict: record already exists' }, { status: 409 });
  }
  if (code === '23503') {
    return NextResponse.json({ error: 'Referenced foreign record does not exist' }, { status: 400 });
  }
  if (code === '23514') {
    return NextResponse.json({ error: 'Value violates a data rule' }, { status: 400 });
  }
  if (code && code.startsWith('22')) {
    return NextResponse.json({ error: 'Invalid input format or data range' }, { status: 400 });
  }

  // 3. Fallback 500: Unexpected internal error logged server-side with name, code, message only
  console.error('Unexpected internal error:', {
    name: (error as Error)?.name || 'Error',
    code,
    message,
  });

  return NextResponse.json(
    { error: 'An unexpected internal error occurred' },
    { status: 500 }
  );
}
