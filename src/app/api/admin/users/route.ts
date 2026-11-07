import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { withAuth, formatErrorResponse, parseJsonBody } from '@/lib/auth/guard';
import { hashPassword } from '@/lib/auth/password';

const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10, 'Password must be at least 10 characters long').max(256),
  role: z.enum(['ADMIN', 'FACULTY']),
  faculty_id: z.number().int().positive().nullable().optional(),
});

export const GET = withAuth(
  async () => {
    const pool = getPool();
    try {
      const res = await pool.query(
        `SELECT user_id, email, role, faculty_id, is_active,
                failed_login_count, locked_until, last_login_at, created_at
         FROM users
         ORDER BY user_id ASC`
      );

      return NextResponse.json({ users: res.rows });
    } catch (err) {
      return formatErrorResponse(err);
    }
  },
  { roles: ['ADMIN'] }
);

export const POST = withAuth(
  async (request: Request) => {
    const { data: body, errorResponse } = await parseJsonBody(request);
    if (errorResponse) {
      return errorResponse;
    }

    const parseResult = createUserSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues[0]?.message || 'Validation error' },
        { status: 400 }
      );
    }

    const { role, password, faculty_id } = parseResult.data;
    const email = parseResult.data.email.trim().toLowerCase();

    // Faculty accounts require an associated faculty_id
    if (role === 'FACULTY' && !faculty_id) {
      return NextResponse.json(
        { error: 'faculty_id is required when creating a FACULTY user account' },
        { status: 400 }
      );
    }

    const pool = getPool();

    try {
      const passwordHash = await hashPassword(password);

      const res = await pool.query(
        `INSERT INTO users (email, password_hash, role, faculty_id)
         VALUES ($1, $2, $3, $4)
         RETURNING user_id, email, role, faculty_id, is_active, created_at`,
        [email, passwordHash, role, role === 'FACULTY' ? faculty_id : null]
      );

      return NextResponse.json(
        { user: res.rows[0] },
        { status: 201 }
      );
    } catch (err) {
      return formatErrorResponse(err);
    }
  },
  { roles: ['ADMIN'] }
);
