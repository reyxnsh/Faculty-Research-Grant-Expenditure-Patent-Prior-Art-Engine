import { SignJWT, jwtVerify } from 'jose';

export interface SessionPayload {
  userId: number;
  email: string;
  role: 'ADMIN' | 'FACULTY';
  facultyId: number | null;
}

export const SESSION_COOKIE_NAME = 'auth_session';

/**
 * Retrieves the cryptographic secret key for JWT signing and verification.
 * Fails fast with a descriptive error if AUTH_SECRET is missing or under 32 characters.
 */
export function getAuthSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.trim().length < 32) {
    throw new Error('AUTH_SECRET must be configured and contain at least 32 characters');
  }
  return new TextEncoder().encode(secret.trim());
}

/**
 * Returns session duration in seconds, defaulting to 8 hours (28800s).
 */
export function getSessionTtlSeconds(): number {
  const hours = parseInt(process.env.SESSION_TTL_HOURS || '8', 10);
  return (isNaN(hours) || hours <= 0 ? 8 : hours) * 3600;
}

/**
 * Signs a cryptographically secure session JWT pinned strictly to HS256.
 */
export async function signSessionToken(payload: SessionPayload): Promise<string> {
  const secretKey = getAuthSecret();
  const ttlSeconds = getSessionTtlSeconds();

  return new SignJWT({
    role: payload.role,
    email: payload.email,
    facultyId: payload.facultyId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(payload.userId))
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey);
}

/**
 * Verifies a session JWT, strictly pinning the algorithm to HS256 to prevent 'none'
 * or algorithm confusion vulnerabilities.
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const secretKey = getAuthSecret();
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ['HS256'],
    });

    if (!payload.sub) {
      return null;
    }

    const userId = parseInt(payload.sub, 10);
    if (isNaN(userId)) {
      return null;
    }

    return {
      userId,
      email: String(payload.email || ''),
      role: payload.role as 'ADMIN' | 'FACULTY',
      facultyId: payload.facultyId !== undefined && payload.facultyId !== null ? Number(payload.facultyId) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Constructs the standard Set-Cookie header options for httpOnly session cookies.
 */
export function getSessionCookieOptions(maxAgeSeconds: number = getSessionTtlSeconds()) {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Extracts the session token from an incoming Request's Cookie header.
 */
export function extractTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.split('=');
    if (name === SESSION_COOKIE_NAME) {
      return rest.join('=');
    }
  }
  return null;
}
