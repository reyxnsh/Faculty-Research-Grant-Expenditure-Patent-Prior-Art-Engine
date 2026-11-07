import { NextResponse } from 'next/server';
import { getSessionCookieOptions, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { validateCsrf } from '@/lib/auth/guard';

export async function POST(request: Request): Promise<Response> {
  if (!validateCsrf(request)) {
    return NextResponse.json(
      { error: 'Forbidden: Request failed CSRF validation' },
      { status: 403 }
    );
  }

  const response = NextResponse.json({ message: 'Successfully logged out' });
  const cookieOptions = getSessionCookieOptions(0);
  response.cookies.set(SESSION_COOKIE_NAME, '', cookieOptions);

  return response;
}
