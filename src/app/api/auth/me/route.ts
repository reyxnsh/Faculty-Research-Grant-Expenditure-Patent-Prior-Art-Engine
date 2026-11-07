import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedUser } from '@/lib/auth/guard';

export const GET = withAuth(async (_request: Request, user: AuthenticatedUser) => {
  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      faculty_id: user.facultyId,
    },
  });
});
