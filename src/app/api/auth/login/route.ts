import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { verifyPassword, verifyDummyPassword } from '@/lib/auth/password';
import { signSessionToken, getSessionCookieOptions } from '@/lib/auth/session';
import { validateCsrf, parseJsonBody } from '@/lib/auth/guard';

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

export async function POST(request: Request): Promise<Response> {
  // 1. CSRF Protection
  if (!validateCsrf(request)) {
    return NextResponse.json(
      { error: 'Forbidden: Request failed CSRF validation' },
      { status: 403 }
    );
  }

  // 2. Body Validation & Payload Size Guard
  const { data: body, errorResponse } = await parseJsonBody(request);
  if (errorResponse) {
    return errorResponse;
  }

  const parseResult = loginSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Invalid email or password format' },
      { status: 400 }
    );
  }

  const email = parseResult.data.email.trim().toLowerCase();
  const password = parseResult.data.password;

  const pool = getPool();

  try {
    // 3. User Lookup
    const userRes = await pool.query(
      `SELECT user_id, email, password_hash, role, faculty_id, is_active, failed_login_count, locked_until
       FROM users
       WHERE email = $1`,
      [email]
    );

    // Uniform 401 error message to prevent account enumeration
    const genericAuthError = { error: 'Invalid email or password' };

    if (userRes.rows.length === 0) {
      // Execute dummy password verification for timing resistance
      await verifyDummyPassword(password);
      return NextResponse.json(genericAuthError, { status: 401 });
    }

    const user = userRes.rows[0];

    // Check account lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await verifyDummyPassword(password);
      return NextResponse.json(genericAuthError, { status: 401 });
    }

    // Check active status
    if (!user.is_active) {
      await verifyDummyPassword(password);
      return NextResponse.json(genericAuthError, { status: 401 });
    }

    // 4. Verify Password
    const isValid = await verifyPassword(password, user.password_hash);

    if (!isValid) {
      // Atomic failure counter increment and conditional 15-minute lockout in a single SQL statement.
      // If a previous lock has expired, the counter restarts at 1.
      await pool.query(
        `UPDATE users
         SET failed_login_count = CASE
               WHEN locked_until IS NOT NULL AND locked_until <= CURRENT_TIMESTAMP THEN 1
               ELSE failed_login_count + 1
             END,
             locked_until = CASE
               WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= CURRENT_TIMESTAMP THEN 1 ELSE failed_login_count + 1 END) >= 5
               THEN CURRENT_TIMESTAMP + INTERVAL '15 minutes'
               WHEN locked_until IS NOT NULL AND locked_until <= CURRENT_TIMESTAMP
               THEN NULL
               ELSE locked_until
             END
         WHERE user_id = $1
         RETURNING failed_login_count, locked_until`,
        [user.user_id]
      );

      return NextResponse.json(genericAuthError, { status: 401 });
    }

    // 5. Successful Login: Reset failure counters conditionally (only if account is not locked)
    const updateRes = await pool.query(
      `UPDATE users
       SET failed_login_count = 0,
           locked_until = NULL,
           last_login_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND (locked_until IS NULL OR locked_until <= CURRENT_TIMESTAMP)
       RETURNING user_id`,
      [user.user_id]
    );

    if (updateRes.rows.length === 0) {
      return NextResponse.json(genericAuthError, { status: 401 });
    }

    // 6. Sign JWT Session Token
    const token = await signSessionToken({
      userId: user.user_id,
      email: user.email,
      role: user.role,
      facultyId: user.faculty_id !== null ? Number(user.faculty_id) : null,
    });

    // 7. Construct Response with httpOnly Cookie
    const response = NextResponse.json({
      user: {
        id: user.user_id,
        email: user.email,
        role: user.role,
        faculty_id: user.faculty_id !== null ? Number(user.faculty_id) : null,
      },
    });

    const cookieOptions = getSessionCookieOptions();
    response.cookies.set(cookieOptions.name, token, cookieOptions);

    return response;
  } catch (err) {
    console.error('Login error:', {
      name: (err as Error)?.name || 'Error',
      code: (err as { code?: string })?.code,
      message: (err as Error)?.message || String(err),
    });
    return NextResponse.json(
      { error: 'An unexpected internal error occurred' },
      { status: 500 }
    );
  }
}
