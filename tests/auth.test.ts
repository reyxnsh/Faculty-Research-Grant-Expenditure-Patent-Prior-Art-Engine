import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SignJWT } from 'jose';
import { Client, Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import path from 'path';
import { createPool, validateAdminDbEnv, validateAppDbEnv } from '@/lib/db';
import { formatErrorResponse } from '@/lib/auth/guard';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  signSessionToken,
  verifySessionToken,
  getAuthSecret,
  SESSION_COOKIE_NAME,
} from '@/lib/auth/session';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { GET as adminUsersGet, POST as adminUsersPost } from '@/app/api/admin/users/route';
import { GET as expendituresGet, POST as expendituresPost } from '@/app/api/expenditures/route';
import { POST as approveRoute } from '@/app/api/expenditures/[id]/approve/route';
import { POST as rejectRoute } from '@/app/api/expenditures/[id]/reject/route';

describe('Authentication, Role-Based Access Control and Workflow Endpoints', () => {
  const user = process.env.POSTGRES_USER!;
  const password = process.env.POSTGRES_PASSWORD!;
  const host = process.env.POSTGRES_HOST!;
  const port = parseInt(process.env.POSTGRES_PORT!, 10);
  const baseDb = process.env.POSTGRES_DB?.replace(/_test$/, '') || 'grant_priorart_db';
  const authDb = `${baseDb}_authtest`;
  const authDbUrl = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(authDb)}`;

  let masterClient: Client;
  let adminPool: Pool;
  let appPool: Pool;
  let savedDbName: string | undefined;

  let adminUserId: number;
  let adminEmail: string;
  const adminPassword = 'AdminPassword123!';

  let facultyUserId1: number;
  let facultyId1: number;
  let facultyEmail1: string;
  const facultyPassword1 = 'FacultyPassword123!';

  let facultyUserId2: number;
  let facultyId2: number;
  let facultyEmail2: string;
  const facultyPassword2 = 'FacultyPassword456!';

  let testDeptId: number;
  let testGrantId1: number;
  let testAccountId1: number;
  let testGrantId2: number;
  let testAccountId2: number;

  beforeAll(async () => {
    savedDbName = process.env.POSTGRES_DB;

    // 1. Initialize scratch database
    masterClient = new Client({
      user,
      password,
      host,
      port,
      database: 'postgres',
    });
    await masterClient.connect();

    const escapedDb = masterClient.escapeIdentifier(authDb);
    await masterClient.query(`DROP DATABASE IF EXISTS ${escapedDb} WITH (FORCE);`);
    await masterClient.query(`CREATE DATABASE ${escapedDb};`);

    // 2. Run all migrations UP
    await runner({
      databaseUrl: authDbUrl,
      dir: path.resolve(process.cwd(), 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    // 3. Configure pools and environment to point to scratch database
    process.env.POSTGRES_DB = authDb;
    adminPool = createPool(validateAdminDbEnv(), authDb);
    appPool = createPool(validateAppDbEnv(), authDb);

    // Override global cached pool instances for Route Handlers
    const globalForDb = globalThis as unknown as { appDbPool?: Pool; adminDbPool?: Pool };
    globalForDb.appDbPool = appPool;
    globalForDb.adminDbPool = adminPool;

    // 4. Seed fixtures
    const timestamp = Date.now();
    adminEmail = `admin_auth_${timestamp}@univ.edu`;
    facultyEmail1 = `faculty1_auth_${timestamp}@univ.edu`;
    facultyEmail2 = `faculty2_auth_${timestamp}@univ.edu`;

    const deptRes = await adminPool.query(
      `INSERT INTO department (department_name, department_code)
       VALUES ('Auth Dept ${timestamp}', 'AUTH_${timestamp.toString().slice(-4)}')
       RETURNING department_id`
    );
    testDeptId = deptRes.rows[0].department_id;

    const fac1Res = await adminPool.query(
      `INSERT INTO faculty (department_id, full_name, email, designation)
       VALUES ($1, 'Dr. Alice Auth', $2, 'PROFESSOR') RETURNING faculty_id`,
      [testDeptId, facultyEmail1]
    );
    facultyId1 = fac1Res.rows[0].faculty_id;

    const fac2Res = await adminPool.query(
      `INSERT INTO faculty (department_id, full_name, email, designation)
       VALUES ($1, 'Dr. Bob Auth', $2, 'ASSOCIATE_PROFESSOR') RETURNING faculty_id`,
      [testDeptId, facultyEmail2]
    );
    facultyId2 = fac2Res.rows[0].faculty_id;

    const adminHash = await hashPassword(adminPassword);
    const adminUserRes = await adminPool.query(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1, $2, 'ADMIN', TRUE) RETURNING user_id`,
      [adminEmail, adminHash]
    );
    adminUserId = adminUserRes.rows[0].user_id;

    const facHash1 = await hashPassword(facultyPassword1);
    const facUser1Res = await adminPool.query(
      `INSERT INTO users (faculty_id, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'FACULTY', TRUE) RETURNING user_id`,
      [facultyId1, facultyEmail1, facHash1]
    );
    facultyUserId1 = facUser1Res.rows[0].user_id;

    const facHash2 = await hashPassword(facultyPassword2);
    const facUser2Res = await adminPool.query(
      `INSERT INTO users (faculty_id, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'FACULTY', TRUE) RETURNING user_id`,
      [facultyId2, facultyEmail2, facHash2]
    );
    facultyUserId2 = facUser2Res.rows[0].user_id;

    const grant1Res = await adminPool.query(
      `INSERT INTO grant_record (
        grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
      ) VALUES (
        'GR-AUTH-01-${timestamp}', 'Quantum Security', 'SERB', 100000.00, $1,
        CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '300 days', 'ACTIVE'
      ) RETURNING grant_id`,
      [facultyId1]
    );
    testGrantId1 = grant1Res.rows[0].grant_id;

    const acc1Res = await adminPool.query(
      `INSERT INTO grant_account (grant_id, category, budget_allocated)
       VALUES ($1, 'EQUIPMENT', 50000.00) RETURNING account_id`,
      [testGrantId1]
    );
    testAccountId1 = acc1Res.rows[0].account_id;

    const grant2Res = await adminPool.query(
      `INSERT INTO grant_record (
        grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status
      ) VALUES (
        'GR-AUTH-02-${timestamp}', 'Cyber Defense', 'DST', 80000.00, $1,
        CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '300 days', 'ACTIVE'
      ) RETURNING grant_id`,
      [facultyId2]
    );
    testGrantId2 = grant2Res.rows[0].grant_id;

    const acc2Res = await adminPool.query(
      `INSERT INTO grant_account (grant_id, category, budget_allocated)
       VALUES ($1, 'TRAVEL', 40000.00) RETURNING account_id`,
      [testGrantId2]
    );
    testAccountId2 = acc2Res.rows[0].account_id;
  }, 30000);

  afterAll(async () => {
    // 1. Close scratch pools
    if (adminPool) await adminPool.end();
    if (appPool) await appPool.end();

    // 2. Drop scratch database
    if (masterClient) {
      const escapedDb = masterClient.escapeIdentifier(authDb);
      try {
        await masterClient.query(`DROP DATABASE IF EXISTS ${escapedDb} WITH (FORCE);`);
      } catch {
        // cleanup suppression
      }
      await masterClient.end();
    }

    // 3. Restore environment and clear global pool cache
    if (savedDbName) {
      process.env.POSTGRES_DB = savedDbName;
    }
    const globalForDb = globalThis as unknown as { appDbPool?: Pool; adminDbPool?: Pool };
    delete globalForDb.appDbPool;
    delete globalForDb.adminDbPool;
  });

  // Helper to build simulated requests
  function makeRequest(url: string, options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    origin?: string;
    contentType?: string;
  } = {}): Request {
    const headers: Record<string, string> = {};
    const method = options.method || 'GET';

    if (options.contentType !== undefined) {
      if (options.contentType) {
        headers['Content-Type'] = options.contentType;
      }
    } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['Content-Type'] = 'application/json';
    }

    if (options.origin) {
      headers['Origin'] = options.origin;
    } else {
      headers['Origin'] = 'http://localhost:3000';
    }
    headers['Host'] = 'localhost:3000';

    if (options.token) {
      headers['Cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
    }

    return new Request(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  }

  describe('1. Password Hashing (crypto.scrypt)', () => {
    it('verifies correctly with matching password and fails with wrong password', async () => {
      const password = 'CorrectHorseBatteryStaple123!';
      const hash = await hashPassword(password);

      expect(await verifyPassword(password, hash)).toBe(true);
      expect(await verifyPassword('WrongPassword123!', hash)).toBe(false);
    });

    it('generates unique hashes for identical passwords due to random salts', async () => {
      const password = 'IdenticalPassword123!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2);
      expect(await verifyPassword(password, hash1)).toBe(true);
      expect(await verifyPassword(password, hash2)).toBe(true);
    });

    it('safely rejects malformed stored hash strings without throwing', async () => {
      expect(await verifyPassword('password', 'invalid-hash')).toBe(false);
      expect(await verifyPassword('password', 'scrypt$bad$parameters$here')).toBe(false);
      expect(await verifyPassword('password', '')).toBe(false);
      expect(await verifyPassword('password', null as unknown as string)).toBe(false);
    });

    it('refuses stored hashes with parameters outside safe bounds', async () => {
      const dummySalt = '0123456789abcdef0123456789abcdef';
      const dummyHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

      // N < 1024
      expect(await verifyPassword('pw', `scrypt$N=512,r=8,p=1${dummySalt}${dummyHash}`)).toBe(false);
      // N > 1048576
      expect(await verifyPassword('pw', `scrypt$N=2097152,r=8,p=1${dummySalt}${dummyHash}`)).toBe(false);
      // N not power of 2
      expect(await verifyPassword('pw', `scrypt$N=1000,r=8,p=1${dummySalt}${dummyHash}`)).toBe(false);
      // r < 1 or r > 16
      expect(await verifyPassword('pw', `scrypt$N=16384,r=0,p=1${dummySalt}${dummyHash}`)).toBe(false);
      expect(await verifyPassword('pw', `scrypt$N=16384,r=32,p=1${dummySalt}${dummyHash}`)).toBe(false);
      // p < 1 or p > 4
      expect(await verifyPassword('pw', `scrypt$N=16384,r=8,p=0${dummySalt}${dummyHash}`)).toBe(false);
      expect(await verifyPassword('pw', `scrypt$N=16384,r=8,p=10${dummySalt}${dummyHash}`)).toBe(false);
    });
  });

  describe('2. Session Tokens (jose JWT, HS256 Pinned)', () => {
    it('signs and verifies valid session tokens', async () => {
      const token = await signSessionToken({
        userId: 100,
        email: 'user@univ.edu',
        role: 'ADMIN',
        facultyId: null,
      });

      const payload = await verifySessionToken(token);
      expect(payload).not.toBeNull();
      expect(payload?.userId).toBe(100);
      expect(payload?.role).toBe('ADMIN');
      expect(payload?.facultyId).toBeNull();
    });

    it('rejects expired tokens', async () => {
      const secret = getAuthSecret();
      const expiredToken = await new SignJWT({ role: 'ADMIN' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('101')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
        .sign(secret);

      const payload = await verifySessionToken(expiredToken);
      expect(payload).toBeNull();
    });

    it('rejects tampered tokens', async () => {
      const token = await signSessionToken({
        userId: 102,
        email: 'tamper@univ.edu',
        role: 'FACULTY',
        facultyId: 5,
      });

      const parts = token.split('.');
      parts[1] = Buffer.from(JSON.stringify({ sub: '102', role: 'ADMIN' })).toString('base64url');
      const tampered = parts.join('.');

      const payload = await verifySessionToken(tampered);
      expect(payload).toBeNull();
    });

    it('rejects tokens signed with a different secret', async () => {
      const differentSecret = new TextEncoder().encode('different_secret_key_that_is_32_characters_long!');
      const foreignToken = await new SignJWT({ role: 'ADMIN' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('103')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(differentSecret);

      const payload = await verifySessionToken(foreignToken);
      expect(payload).toBeNull();
    });

    it('rejects tokens using alg "none"', async () => {
      const unsignedToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"104","role":"ADMIN"}').toString('base64url')}.`;
      const payload = await verifySessionToken(unsignedToken);
      expect(payload).toBeNull();
    });

    it('fails fast if AUTH_SECRET is missing or under 32 characters', () => {
      const oldSecret = process.env.AUTH_SECRET;
      try {
        process.env.AUTH_SECRET = 'short_secret';
        expect(() => getAuthSecret()).toThrow(/AUTH_SECRET must be configured and contain at least 32 characters/i);
      } finally {
        process.env.AUTH_SECRET = oldSecret;
      }
    });
  });

  describe('3. Login, Logout & Account Lockout Flow', () => {
    it('sets httpOnly cookie on successful login and never leaks hash or token in response body', async () => {
      const req = makeRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: { email: adminEmail, password: adminPassword },
      });

      const res = await loginRoute(req);
      expect(res.status).toBe(200);

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain(SESSION_COOKIE_NAME);
      expect(setCookie?.toLowerCase()).toContain('httponly');
      expect(setCookie?.toLowerCase()).toContain('samesite=lax');

      const json = await res.json();
      expect(json.user).toBeDefined();
      expect(json.user.id).toBe(adminUserId);
      expect(json.user.email).toBe(adminEmail);
      expect(json.user.role).toBe('ADMIN');

      const rawBody = JSON.stringify(json);
      expect(rawBody).not.toContain('password_hash');
      expect(rawBody).not.toContain(adminPassword);
      expect(rawBody).not.toContain('auth_session');
    });

    it('returns uniform 401 response for unknown user, wrong password, and inactive user', async () => {
      // 1. Unknown user
      const reqUnknown = makeRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: { email: 'nonexistent@univ.edu', password: 'AnyPassword123!' },
      });
      const resUnknown = await loginRoute(reqUnknown);
      expect(resUnknown.status).toBe(401);
      const jsonUnknown = await resUnknown.json();
      expect(jsonUnknown).toEqual({ error: 'Invalid email or password' });

      // 2. Wrong password
      const reqWrongPass = makeRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: { email: adminEmail, password: 'IncorrectPassword999!' },
      });
      const resWrongPass = await loginRoute(reqWrongPass);
      expect(resWrongPass.status).toBe(401);
      const jsonWrongPass = await resWrongPass.json();
      expect(jsonWrongPass).toEqual({ error: 'Invalid email or password' });

      // 3. Inactive user
      await adminPool.query('UPDATE users SET is_active = FALSE WHERE user_id = $1', [facultyUserId2]);
      const reqInactive = makeRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: { email: facultyEmail2, password: facultyPassword2 },
      });
      const resInactive = await loginRoute(reqInactive);
      expect(resInactive.status).toBe(401);
      const jsonInactive = await resInactive.json();
      expect(jsonInactive).toEqual({ error: 'Invalid email or password' });

      // Restore active status
      await adminPool.query('UPDATE users SET is_active = TRUE WHERE user_id = $1', [facultyUserId2]);
    });

    it('locks account after 5 consecutive failures, unlocks after timeout, and resets count on success', async () => {
      const lockEmail = `lock_test_${Date.now()}@univ.edu`;
      const lockPass = 'LockPassword123!';
      const lockHash = await hashPassword(lockPass);
      const uRes = await adminPool.query(
        "INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'ADMIN', TRUE) RETURNING user_id",
        [lockEmail, lockHash]
      );
      const lockUserId = uRes.rows[0].user_id;

      try {
        // Fail 4 times: account remains unlocked
        for (let i = 1; i <= 4; i++) {
          const req = makeRequest('http://localhost:3000/api/auth/login', {
            method: 'POST',
            body: { email: lockEmail, password: 'WrongPassword!' },
          });
          const res = await loginRoute(req);
          expect(res.status).toBe(401);

          const check = await adminPool.query('SELECT failed_login_count, locked_until FROM users WHERE user_id = $1', [lockUserId]);
          expect(check.rows[0].failed_login_count).toBe(i);
          expect(check.rows[0].locked_until).toBeNull();
        }

        // 5th failure triggers lockout
        const req5 = makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body: { email: lockEmail, password: 'WrongPassword!' },
        });
        const res5 = await loginRoute(req5);
        expect(res5.status).toBe(401);

        const checkLocked = await adminPool.query('SELECT failed_login_count, locked_until FROM users WHERE user_id = $1', [lockUserId]);
        expect(checkLocked.rows[0].failed_login_count).toBe(5);
        expect(checkLocked.rows[0].locked_until).not.toBeNull();
        expect(new Date(checkLocked.rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());

        // Even with the CORRECT password, locked user is denied
        const reqCorrectWhileLocked = makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body: { email: lockEmail, password: lockPass },
        });
        const resLocked = await loginRoute(reqCorrectWhileLocked);
        expect(resLocked.status).toBe(401);

        // Simulate unlock by setting locked_until to the past
        await adminPool.query(
          "UPDATE users SET locked_until = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE user_id = $1",
          [lockUserId]
        );

        // Now login with correct password succeeds and resets counter
        const reqSuccess = makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body: { email: lockEmail, password: lockPass },
        });
        const resSuccess = await loginRoute(reqSuccess);
        expect(resSuccess.status).toBe(200);

        const checkReset = await adminPool.query('SELECT failed_login_count, locked_until, last_login_at FROM users WHERE user_id = $1', [lockUserId]);
        expect(checkReset.rows[0].failed_login_count).toBe(0);
        expect(checkReset.rows[0].locked_until).toBeNull();
        expect(checkReset.rows[0].last_login_at).not.toBeNull();
      } finally {
        await adminPool.query('DELETE FROM users WHERE user_id = $1', [lockUserId]);
      }
    });

    it('handles concurrent wrong-password attempts atomically and locks account', async () => {
      const concurrentEmail = `conc_lock_${Date.now()}@univ.edu`;
      const pass = 'ConcurrentPass123!';
      const hash = await hashPassword(pass);
      const res = await adminPool.query(
        "INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'ADMIN', TRUE) RETURNING user_id",
        [concurrentEmail, hash]
      );
      const uid = res.rows[0].user_id;

      try {
        // Fire 10 wrong-password login attempts concurrently
        const attempts = Array.from({ length: 10 }, () =>
          loginRoute(
            makeRequest('http://localhost:3000/api/auth/login', {
              method: 'POST',
              body: { email: concurrentEmail, password: 'WrongPassword!' },
            })
          )
        );
        const responses = await Promise.all(attempts);
        for (const resp of responses) {
          expect(resp.status).toBe(401);
        }

        // Account must be locked with failed_login_count >= 5
        const userCheck = await adminPool.query(
          'SELECT failed_login_count, locked_until FROM users WHERE user_id = $1',
          [uid]
        );
        expect(userCheck.rows[0].failed_login_count).toBeGreaterThanOrEqual(5);
        expect(userCheck.rows[0].locked_until).not.toBeNull();
        expect(new Date(userCheck.rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());

        // Correct password login immediately afterwards still returns generic 401
        const correctReq = makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body: { email: concurrentEmail, password: pass },
        });
        const correctRes = await loginRoute(correctReq);
        expect(correctRes.status).toBe(401);
      } finally {
        await adminPool.query('DELETE FROM users WHERE user_id = $1', [uid]);
      }
    });

    it('restarts failure counter at 1 after locked_until expires into the past', async () => {
      const expireEmail = `expire_lock_${Date.now()}@univ.edu`;
      const pass = 'ExpirePass123!';
      const hash = await hashPassword(pass);
      const res = await adminPool.query(
        `INSERT INTO users (email, password_hash, role, is_active, failed_login_count, locked_until)
         VALUES ($1, $2, 'ADMIN', TRUE, 5, CURRENT_TIMESTAMP - INTERVAL '1 minute')
         RETURNING user_id`,
        [expireEmail, hash]
      );
      const uid = res.rows[0].user_id;

      try {
        // 1 wrong password after expiration resets counter to 1 with no new lock
        const req = makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body: { email: expireEmail, password: 'WrongPassword!' },
        });
        const resp = await loginRoute(req);
        expect(resp.status).toBe(401);

        const check = await adminPool.query(
          'SELECT failed_login_count, locked_until FROM users WHERE user_id = $1',
          [uid]
        );
        expect(check.rows[0].failed_login_count).toBe(1);
        expect(check.rows[0].locked_until).toBeNull();
      } finally {
        await adminPool.query('DELETE FROM users WHERE user_id = $1', [uid]);
      }
    });

    it('supports case-insensitive email matching during login', async () => {
      const upperEmail = adminEmail.toUpperCase();
      const req = makeRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: { email: upperEmail, password: adminPassword },
      });
      const res = await loginRoute(req);
      expect(res.status).toBe(200);
    });

    it('refuses to issue session cookie if account is locked at the moment of successful authentication', async () => {
      const userEmail = `lock_race_${Date.now()}@univ.edu`;
      const pass = 'SecretPassword123!';
      const hash = await hashPassword(pass);
      const userRes = await adminPool.query(
        "INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'ADMIN', TRUE) RETURNING user_id",
        [userEmail, hash]
      );
      const uid = userRes.rows[0].user_id;

      // Spy on verifyPassword and lock the account in database right before returning true
      const passwordModule = await import('@/lib/auth/password');
      const spy = vi.spyOn(passwordModule, 'verifyPassword').mockImplementation(async () => {
        await adminPool.query(
          "UPDATE users SET locked_until = CURRENT_TIMESTAMP + INTERVAL '15 minutes' WHERE user_id = $1",
          [uid]
        );
        return true;
      });

      try {
        const res = await loginRoute(
          makeRequest('http://localhost:3000/api/auth/login', {
            method: 'POST',
            body: { email: userEmail, password: pass },
          })
        );

        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json).toEqual({ error: 'Invalid email or password' });
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally {
        spy.mockRestore();
        await adminPool.query('DELETE FROM users WHERE user_id = $1', [uid]);
      }
    });

    it('clears session cookie on logout', async () => {
      const req = makeRequest('http://localhost:3000/api/auth/logout', { method: 'POST' });
      const res = await logoutRoute(req);
      expect(res.status).toBe(200);

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    });
  });

  describe('4. RBAC Protection Matrix & Faculty Isolation', () => {
    it('returns 401 Unauthorized for unauthenticated requests on protected routes', async () => {
      const unauthRoutes = [
        () => meRoute(makeRequest('http://localhost:3000/api/auth/me')),
        () => adminUsersGet(makeRequest('http://localhost:3000/api/admin/users')),
        () => adminUsersPost(makeRequest('http://localhost:3000/api/admin/users', { method: 'POST', body: {} })),
        () => expendituresGet(makeRequest('http://localhost:3000/api/expenditures')),
        () => expendituresPost(makeRequest('http://localhost:3000/api/expenditures', { method: 'POST', body: {} })),
        () => approveRoute(makeRequest('http://localhost:3000/api/expenditures/1/approve', { method: 'POST' }), { params: Promise.resolve({ id: '1' }) }),
        () => rejectRoute(makeRequest('http://localhost:3000/api/expenditures/1/reject', { method: 'POST', body: { reason: 'Test' } }), { params: Promise.resolve({ id: '1' }) }),
      ];

      for (const routeFn of unauthRoutes) {
        const res = await routeFn();
        expect(res.status).toBe(401);
      }
    });

    it('returns 403 Forbidden when FACULTY attempts to access ADMIN-only routes', async () => {
      const facultyToken = await signSessionToken({
        userId: facultyUserId1,
        email: facultyEmail1,
        role: 'FACULTY',
        facultyId: facultyId1,
      });

      // 1. GET /api/admin/users
      const resUsersGet = await adminUsersGet(
        makeRequest('http://localhost:3000/api/admin/users', { token: facultyToken })
      );
      expect(resUsersGet.status).toBe(403);

      // 2. POST /api/admin/users
      const resUsersPost = await adminUsersPost(
        makeRequest('http://localhost:3000/api/admin/users', {
          method: 'POST',
          token: facultyToken,
          body: { email: 'new@univ.edu', password: 'Password123!', role: 'ADMIN' },
        })
      );
      expect(resUsersPost.status).toBe(403);

      // 3. POST /api/expenditures/[id]/approve
      const resApprove = await approveRoute(
        makeRequest('http://localhost:3000/api/expenditures/1/approve', {
          method: 'POST',
          token: facultyToken,
        }),
        { params: Promise.resolve({ id: '1' }) }
      );
      expect(resApprove.status).toBe(403);

      // 4. POST /api/expenditures/[id]/reject
      const resReject = await rejectRoute(
        makeRequest('http://localhost:3000/api/expenditures/1/reject', {
          method: 'POST',
          token: facultyToken,
          body: { reason: 'Denied' },
        }),
        { params: Promise.resolve({ id: '1' }) }
      );
      expect(resReject.status).toBe(403);
    });

    it('enforces that FACULTY can only view expenditures belonging to their own grants', async () => {
      const exp1 = await adminPool.query(
        `INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by)
         VALUES ($1, 1000.00, 'Faculty 1 Item', CURRENT_DATE, $2) RETURNING transaction_id`,
        [testAccountId1, facultyId1]
      );
      const tx1 = exp1.rows[0].transaction_id;

      const exp2 = await adminPool.query(
        `INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by)
         VALUES ($1, 2000.00, 'Faculty 2 Item', CURRENT_DATE, $2) RETURNING transaction_id`,
        [testAccountId2, facultyId2]
      );
      const tx2 = exp2.rows[0].transaction_id;

      try {
        const faculty1Token = await signSessionToken({
          userId: facultyUserId1,
          email: facultyEmail1,
          role: 'FACULTY',
          facultyId: facultyId1,
        });

        const resFac1 = await expendituresGet(
          makeRequest('http://localhost:3000/api/expenditures', { token: faculty1Token })
        );
        expect(resFac1.status).toBe(200);
        const jsonFac1 = await resFac1.json();
        const txIds1 = jsonFac1.expenditures.map((e: { transaction_id: number }) => e.transaction_id);
        expect(txIds1).toContain(tx1);
        expect(txIds1).not.toContain(tx2);

        const adminToken = await signSessionToken({
          userId: adminUserId,
          email: adminEmail,
          role: 'ADMIN',
          facultyId: null,
        });
        const resAdmin = await expendituresGet(
          makeRequest('http://localhost:3000/api/expenditures', { token: adminToken })
        );
        expect(resAdmin.status).toBe(200);
        const jsonAdmin = await resAdmin.json();
        const adminTxIds = jsonAdmin.expenditures.map((e: { transaction_id: number }) => e.transaction_id);
        expect(adminTxIds).toContain(tx1);
        expect(adminTxIds).toContain(tx2);
      } finally {
        await adminPool.query('DELETE FROM expenditure WHERE transaction_id IN ($1, $2)', [tx1, tx2]);
      }
    });

    it('rejects expenditure submission when faculty attempts to claim against another faculty member grant', async () => {
      const faculty1Token = await signSessionToken({
        userId: facultyUserId1,
        email: facultyEmail1,
        role: 'FACULTY',
        facultyId: facultyId1,
      });

      const req = makeRequest('http://localhost:3000/api/expenditures', {
        method: 'POST',
        token: faculty1Token,
        body: {
          account_id: testAccountId2,
          amount: 500.00,
          description: 'Intrusion claim',
        },
      });

      const res = await expendituresPost(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/Only the Principal Investigator can submit claims for this grant/i);
    });

    it('immediately invalidates existing token when a user is deactivated in the database', async () => {
      const token = await signSessionToken({
        userId: facultyUserId1,
        email: facultyEmail1,
        role: 'FACULTY',
        facultyId: facultyId1,
      });

      const res1 = await meRoute(makeRequest('http://localhost:3000/api/auth/me', { token }));
      expect(res1.status).toBe(200);

      await adminPool.query('UPDATE users SET is_active = FALSE WHERE user_id = $1', [facultyUserId1]);

      try {
        const res2 = await meRoute(makeRequest('http://localhost:3000/api/auth/me', { token }));
        expect(res2.status).toBe(401);
      } finally {
        await adminPool.query('UPDATE users SET is_active = TRUE WHERE user_id = $1', [facultyUserId1]);
      }
    });
  });

  describe('5. CSRF & Request Security Validation', () => {
    it('rejects mutating requests originating from cross-origin sources', async () => {
      const token = await signSessionToken({
        userId: adminUserId,
        email: adminEmail,
        role: 'ADMIN',
        facultyId: null,
      });

      const req = makeRequest('http://localhost:3000/api/admin/users', {
        method: 'POST',
        token,
        origin: 'http://malicious-attacker-site.com',
        body: { email: 'cross@univ.edu', password: 'Password123!', role: 'ADMIN' },
      });

      const res = await adminUsersPost(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/CSRF/i);
    });

    it('enforces Content-Type: application/json on all mutating requests including body-less calls', async () => {
      const adminToken = await signSessionToken({
        userId: adminUserId,
        email: adminEmail,
        role: 'ADMIN',
        facultyId: null,
      });

      const expRes = await adminPool.query(
        "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 50.00, 'CSRF test claim', CURRENT_DATE, $2) RETURNING transaction_id",
        [testAccountId1, facultyId1]
      );
      const txId = expRes.rows[0].transaction_id;

      try {
        // 1. Approve WITHOUT Content-Type header -> 403 Forbidden
        const reqNoContentType = new Request(`http://localhost:3000/api/expenditures/${txId}/approve`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            Host: 'localhost:3000',
            Cookie: `${SESSION_COOKIE_NAME}=${adminToken}`,
          },
        });
        const resNoContentType = await approveRoute(reqNoContentType, { params: Promise.resolve({ id: String(txId) }) });
        expect(resNoContentType.status).toBe(403);

        // 2. Approve WITH Content-Type: application/json -> 200 OK
        const reqWithContentType = new Request(`http://localhost:3000/api/expenditures/${txId}/approve`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            Host: 'localhost:3000',
            'Content-Type': 'application/json',
            Cookie: `${SESSION_COOKIE_NAME}=${adminToken}`,
          },
        });
        const resWithContentType = await approveRoute(reqWithContentType, { params: Promise.resolve({ id: String(txId) }) });
        expect(resWithContentType.status).toBe(200);
      } finally {
        await adminPool.query('DELETE FROM expenditure WHERE transaction_id = $1', [txId]);
      }
    });

    it('rejects mutating requests with non-JSON Content-Type', async () => {
      const token = await signSessionToken({
        userId: adminUserId,
        email: adminEmail,
        role: 'ADMIN',
        facultyId: null,
      });

      const req = makeRequest('http://localhost:3000/api/admin/users', {
        method: 'POST',
        token,
        contentType: 'application/x-www-form-urlencoded',
        body: { email: 'badtype@univ.edu', password: 'Password123!', role: 'ADMIN' },
      });

      const res = await adminUsersPost(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/CSRF/i);
    });
  });

  describe('6. Input Validation & Safe Error Responses', () => {
    it('rejects malformed bodies with HTTP 400', async () => {
      const adminToken = await signSessionToken({
        userId: adminUserId,
        email: adminEmail,
        role: 'ADMIN',
        facultyId: null,
      });

      const resShortPass = await adminUsersPost(
        makeRequest('http://localhost:3000/api/admin/users', {
          method: 'POST',
          token: adminToken,
          body: { email: 'valid@univ.edu', password: 'short', role: 'ADMIN' },
        })
      );
      expect(resShortPass.status).toBe(400);

      const resEmptyReason = await rejectRoute(
        makeRequest('http://localhost:3000/api/expenditures/1/reject', {
          method: 'POST',
          token: adminToken,
          body: { reason: '   ' },
        }),
        { params: Promise.resolve({ id: '1' }) }
      );
      expect(resEmptyReason.status).toBe(400);
    });

    it('maps every business rule RAISE EXCEPTION from migrations 009 and 010 to a safe 4xx response without SQL or schema leaks', async () => {
      const fs = await import('fs');

      function extractRaises(filePath: string): string[] {
        const text = fs.readFileSync(filePath, 'utf8');
        const regex = /RAISE EXCEPTION\s+['']([^'']+)['']/g;
        const list: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
          list.push(m[1].replace(/\s+/g, ' ').trim());
        }
        return list;
      }

      const f009 = extractRaises(path.resolve(process.cwd(), 'migrations/009_integrity_triggers.sql'));
      const f010 = extractRaises(path.resolve(process.cwd(), 'migrations/010_workflow_routines.sql'));
      const allRaises = [...f009, ...f010];

      expect(allRaises.length).toBeGreaterThanOrEqual(28);

      const forbiddenSubstrings = [
        'select', 'insert', 'update', 'delete', 'where', 'table',
        'expenditure', 'grant_account', 'grant_record', 'audit_log', 'users',
        'department', 'faculty', 'intellectual_property', 'ip_author', 'grant_ip',
        'chk_', 'uq_', 'fk_'
      ];

      for (const raiseMsg of allRaises) {
        const instantiated = raiseMsg.replace(/%/g, '123');
        const dbErr = new Error(instantiated);
        (dbErr as unknown as { code: string }).code = 'P0001';
        const response = formatErrorResponse(dbErr);
        const body = await response.json();

        expect(response.status).not.toBe(500);
        expect([400, 403, 404, 409]).toContain(response.status);

        const err = (body.error || '').toLowerCase();
        for (const leak of forbiddenSubstrings) {
          const re = new RegExp('\\b' + leak + '\\b', 'i');
          expect(re.test(err)).toBe(false);
          expect(err.includes('chk_')).toBe(false);
          expect(err.includes('uq_')).toBe(false);
          expect(err.includes('fk_')).toBe(false);
        }
      }
    });

    it('enforces API-level status codes: 409 for duplicate approvals/rejections and 403 for self-approval', async () => {
      const adminToken = await signSessionToken({
        userId: adminUserId,
        email: adminEmail,
        role: 'ADMIN',
        facultyId: null,
      });

      // Submit an expenditure
      const facultyToken = await signSessionToken({
        userId: facultyUserId1,
        email: facultyEmail1,
        role: 'FACULTY',
        facultyId: facultyId1,
      });

      const submitRes = await expendituresPost(
        makeRequest('http://localhost:3000/api/expenditures', {
          method: 'POST',
          token: facultyToken,
          body: {
            account_id: testAccountId1,
            amount: 500.00,
            description: 'Status conflict test expenditure',
            transaction_date: new Date().toISOString().slice(0, 10),
          },
        })
      );
      expect(submitRes.status).toBe(201);
      const submitData = await submitRes.json();
      const txId = submitData.expenditure.transaction_id;

      // 1. Approve once -> 200 OK
      const approve1 = await approveRoute(
        makeRequest(`http://localhost:3000/api/expenditures/${txId}/approve`, {
          method: 'POST',
          token: adminToken,
        }),
        { params: Promise.resolve({ id: String(txId) }) }
      );
      expect(approve1.status).toBe(200);

      // 2. Approve again -> 409 Conflict (not PENDING)
      const approve2 = await approveRoute(
        makeRequest(`http://localhost:3000/api/expenditures/${txId}/approve`, {
          method: 'POST',
          token: adminToken,
        }),
        { params: Promise.resolve({ id: String(txId) }) }
      );
      expect(approve2.status).toBe(409);

      // 3. Reject/revert -> 200 OK
      const revert1 = await rejectRoute(
        makeRequest(`http://localhost:3000/api/expenditures/${txId}/reject`, {
          method: 'POST',
          token: adminToken,
          body: { reason: 'Reverting claim' },
        }),
        { params: Promise.resolve({ id: String(txId) }) }
      );
      expect(revert1.status).toBe(200);

      // 4. Reject again -> 409 Conflict (already REJECTED)
      const revert2 = await rejectRoute(
        makeRequest(`http://localhost:3000/api/expenditures/${txId}/reject`, {
          method: 'POST',
          token: adminToken,
          body: { reason: 'Reverting again' },
        }),
        { params: Promise.resolve({ id: String(txId) }) }
      );
      expect(revert2.status).toBe(409);

      // 5. Admin approving own submission (linked faculty) -> 403 Forbidden
      const selfFacRes = await adminPool.query(
        "INSERT INTO faculty (department_id, full_name, email, designation) VALUES ($1, 'Dr. Self Admin', 'self_fac@univ.edu', 'PROFESSOR') RETURNING faculty_id",
        [testDeptId]
      );
      const selfFacultyId = selfFacRes.rows[0].faculty_id;

      const selfAdminRes = await adminPool.query(
        "INSERT INTO users (email, password_hash, role, faculty_id, is_active) VALUES ('self_admin@univ.edu', 'dummyhash', 'ADMIN', $1, TRUE) RETURNING user_id",
        [selfFacultyId]
      );
      const selfAdminId = selfAdminRes.rows[0].user_id;

      const selfAdminToken = await signSessionToken({
        userId: selfAdminId,
        email: 'self_admin@univ.edu',
        role: 'ADMIN',
        facultyId: selfFacultyId,
      });

      // Create grant where selfFaculty is PI
      const selfGrantRes = await adminPool.query(
        `INSERT INTO grant_record (grant_code, title, funding_agency, total_budget, pi_faculty_id, start_date, end_date, status)
         VALUES ('GR-SELF-001', 'Self Project', 'DST', 40000.00, $1, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '100 days', 'ACTIVE')
         RETURNING grant_id`,
        [selfFacultyId]
      );
      const selfGrantId = selfGrantRes.rows[0].grant_id;

      const selfAccRes = await adminPool.query(
        "INSERT INTO grant_account (grant_id, category, budget_allocated) VALUES ($1, 'EQUIPMENT', 20000.00) RETURNING account_id",
        [selfGrantId]
      );
      const selfAccountId = selfAccRes.rows[0].account_id;

      // Submit expenditure by selfFacultyId directly
      const selfExpRes = await adminPool.query(
        "INSERT INTO expenditure (account_id, amount, description, transaction_date, submitted_by) VALUES ($1, 300.00, 'Self-approval test claim', CURRENT_DATE, $2) RETURNING transaction_id",
        [selfAccountId, selfFacultyId]
      );
      const selfTxId = selfExpRes.rows[0].transaction_id;

      // Self-approval returns 403
      const selfApproveRes = await approveRoute(
        makeRequest(`http://localhost:3000/api/expenditures/${selfTxId}/approve`, {
          method: 'POST',
          token: selfAdminToken,
        }),
        { params: Promise.resolve({ id: String(selfTxId) }) }
      );
      expect(selfApproveRes.status).toBe(403);
    });

    it('properly distinguishes SQLSTATE error codes and prevents diagnostic leaks', async () => {
      // 1. Error with code 42703 and 'column "x" does not exist' returns 500 (not 404) and is logged
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err42703 = new Error('column "secret_col" does not exist');
      (err42703 as unknown as { code: string }).code = '42703';
      const res42703 = formatErrorResponse(err42703);
      expect(res42703.status).toBe(500);
      expect(await res42703.json()).toEqual({ error: 'An unexpected internal error occurred' });
      expect(errSpy).toHaveBeenCalledWith(
        'Unexpected internal error:',
        expect.objectContaining({ code: '42703', message: 'column "secret_col" does not exist' })
      );

      // 2. Error with code 42P01 returns 500
      const err42P01 = new Error('relation "expenditure" does not exist');
      (err42P01 as unknown as { code: string }).code = '42P01';
      const res42P01 = formatErrorResponse(err42P01);
      expect(res42P01.status).toBe(500);

      // 3. Non-P0001 error whose message contains "not found" returns 500
      const errNotFound = new Error('Resource not found in cache system');
      const resNotFound = formatErrorResponse(errNotFound);
      expect(resNotFound.status).toBe(500);

      // 4. PostgreSQL standard codes: 22003 (numeric overflow), 22008 (datetime overflow), 23514 (check violation) -> 400
      const err22003 = new Error('numeric field overflow');
      (err22003 as unknown as { code: string }).code = '22003';
      const res22003 = formatErrorResponse(err22003);
      expect(res22003.status).toBe(400);
      expect(await res22003.json()).toEqual({ error: 'Invalid input format or data range' });

      const err22008 = new Error('date/time field value out of range');
      (err22008 as unknown as { code: string }).code = '22008';
      const res22008 = formatErrorResponse(err22008);
      expect(res22008.status).toBe(400);

      const err23514 = new Error('check constraint "chk_total_budget_positive" violated');
      (err23514 as unknown as { code: string }).code = '23514';
      const res23514 = formatErrorResponse(err23514);
      expect(res23514.status).toBe(400);
      expect(await res23514.json()).toEqual({ error: 'Value violates a data rule' });

      errSpy.mockRestore();
    });

    it('enforces expenditure input validation: amount decimals/bounds, calendar dates, and query filters', async () => {
      const facultyToken = await signSessionToken({
        userId: facultyUserId1,
        email: facultyEmail1,
        role: 'FACULTY',
        facultyId: facultyId1,
      });

      // 1. Overflow amount (> 9999999999.99) -> 400
      const resOverflow = await expendituresPost(
        makeRequest('http://localhost:3000/api/expenditures', {
          method: 'POST',
          token: facultyToken,
          body: {
            account_id: testAccountId1,
            amount: 10000000000.00,
            description: 'Overflow claim',
          },
        })
      );
      expect(resOverflow.status).toBe(400);

      // 2. 3-decimal amount -> 400
      const resThreeDecimals = await expendituresPost(
        makeRequest('http://localhost:3000/api/expenditures', {
          method: 'POST',
          token: facultyToken,
          body: {
            account_id: testAccountId1,
            amount: 125.456,
            description: 'Three decimal places claim',
          },
        })
      );
      expect(resThreeDecimals.status).toBe(400);

      // 3. Invalid date: 2026-02-31 (calendar invalid) -> 400
      const resInvalidCalendar = await expendituresPost(
        makeRequest('http://localhost:3000/api/expenditures', {
          method: 'POST',
          token: facultyToken,
          body: {
            account_id: testAccountId1,
            amount: 100.00,
            description: 'Invalid calendar date claim',
            transaction_date: '2026-02-31',
          },
        })
      );
      expect(resInvalidCalendar.status).toBe(400);

      // 4. Out of range years: 1999 and 2101 -> 400
      const resOldYear = await expendituresPost(
        makeRequest('http://localhost:3000/api/expenditures', {
          method: 'POST',
          token: facultyToken,
          body: {
            account_id: testAccountId1,
            amount: 100.00,
            description: 'Year 1999 claim',
            transaction_date: '1999-12-31',
          },
        })
      );
      expect(resOldYear.status).toBe(400);

      const resFutureYear = await expendituresPost(
        makeRequest('http://localhost:3000/api/expenditures', {
          method: 'POST',
          token: facultyToken,
          body: {
            account_id: testAccountId1,
            amount: 100.00,
            description: 'Year 2101 claim',
            transaction_date: '2101-01-01',
          },
        })
      );
      expect(resFutureYear.status).toBe(400);

      // 5. Invalid status filter in GET /api/expenditures -> 400
      const resInvalidStatus = await expendituresGet(
        makeRequest('http://localhost:3000/api/expenditures?status=UNAPPROVED', {
          token: facultyToken,
        })
      );
      expect(resInvalidStatus.status).toBe(400);

      // 6. Invalid grant_id filter in GET /api/expenditures -> 400
      const resNonIntGrantId = await expendituresGet(
        makeRequest('http://localhost:3000/api/expenditures?grant_id=not-an-int', {
          token: facultyToken,
        })
      );
      expect(resNonIntGrantId.status).toBe(400);

      const resNegativeGrantId = await expendituresGet(
        makeRequest('http://localhost:3000/api/expenditures?grant_id=-1', {
          token: facultyToken,
        })
      );
      expect(resNegativeGrantId.status).toBe(400);
    });

    it('enforces input limits: rejects oversized passwords, emails, and payload bodies', async () => {
      // 1. Oversized password (> 256 characters)
      const oversizedPassword = 'A'.repeat(257);
      const resOversizedPass = await loginRoute(
        makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body: { email: adminEmail, password: oversizedPassword },
        })
      );
      expect(resOversizedPass.status).toBe(400);

      // 2. Oversized email (> 255 characters)
      const oversizedEmail = 'a'.repeat(250) + '@univ.edu';
      const resOversizedEmail = await loginRoute(
        makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          body: { email: oversizedEmail, password: 'ValidPassword123!' },
        })
      );
      expect(resOversizedEmail.status).toBe(400);

      // 3. Oversized payload body (> 64 KB)
      const bigString = 'X'.repeat(70000);
      const resOversizedBody = await loginRoute(
        new Request('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'origin': 'http://localhost:3000',
            'host': 'localhost:3000',
          },
          body: JSON.stringify({ email: adminEmail, password: 'password', extra: bigString }),
        })
      );
      expect(resOversizedBody.status).toBe(413);
    });
  });

  describe('7. End-to-End Workflow through Route Handlers', () => {
    it('executes submit -> approve -> balance deduction -> revert -> balance restoration cycle', async () => {
      const facultyToken = await signSessionToken({
        userId: facultyUserId1,
        email: facultyEmail1,
        role: 'FACULTY',
        facultyId: facultyId1,
      });

      const adminToken = await signSessionToken({
        userId: adminUserId,
        email: adminEmail,
        role: 'ADMIN',
        facultyId: null,
      });

      const bal0 = await appPool.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [testAccountId1]);
      const initialBalance = Number(bal0.rows[0].current_balance);

      const submitReq = makeRequest('http://localhost:3000/api/expenditures', {
        method: 'POST',
        token: facultyToken,
        body: {
          account_id: testAccountId1,
          amount: 5000.00,
          description: 'E2E Testing Instrument',
        },
      });

      const submitRes = await expendituresPost(submitReq);
      expect(submitRes.status).toBe(201);
      const submitJson = await submitRes.json();
      expect(submitJson.expenditure).toBeDefined();
      expect(submitJson.expenditure.status).toBe('PENDING');
      const txId = submitJson.expenditure.transaction_id;

      try {
        const approveReq = makeRequest(`http://localhost:3000/api/expenditures/${txId}/approve`, {
          method: 'POST',
          token: adminToken,
          body: { fake_admin_id: 999999 },
        });

        const approveRes = await approveRoute(approveReq, {
          params: Promise.resolve({ id: String(txId) }),
        });
        expect(approveRes.status).toBe(200);
        const approveJson = await approveRes.json();
        expect(approveJson.status).toBe('APPROVED');
        expect(Number(approveJson.remaining_balance)).toBe(initialBalance - 5000.00);

        const bal1 = await appPool.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [testAccountId1]);
        expect(Number(bal1.rows[0].current_balance)).toBe(initialBalance - 5000.00);

        const revertReq = makeRequest(`http://localhost:3000/api/expenditures/${txId}/reject`, {
          method: 'POST',
          token: adminToken,
          body: { reason: 'E2E Audit cancellation' },
        });

        const revertRes = await rejectRoute(revertReq, {
          params: Promise.resolve({ id: String(txId) }),
        });
        expect(revertRes.status).toBe(200);
        const revertJson = await revertRes.json();
        expect(revertJson.status).toBe('REJECTED');

        const bal2 = await appPool.query('SELECT current_balance FROM grant_account WHERE account_id = $1', [testAccountId1]);
        expect(Number(bal2.rows[0].current_balance)).toBe(initialBalance);

        const auditRes = await appPool.query(
          'SELECT action, entity_type FROM audit_log WHERE entity_id = $1 ORDER BY log_id ASC',
          [txId]
        );
        const actions = auditRes.rows.map((r) => r.action);
        expect(actions).toContain('CREATED');
        expect(actions).toContain('STATUS_CHANGE_APPROVED');
        expect(actions).toContain('STATUS_CHANGE_REJECTED');
      } finally {
        await adminPool.query('DELETE FROM expenditure WHERE transaction_id = $1', [txId]);
      }
    });
  });

  describe('8. User Table Authentication Constraints (Migration 014)', () => {
    it('rejects inserting mixed-case emails via chk_user_email_lowercase constraint', async () => {
      let threw = false;
      try {
        await adminPool.query(
          "INSERT INTO users (email, password_hash, role) VALUES ('MixedCaseEmail@univ.edu', 'hash', 'ADMIN')"
        );
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/chk_user_email_lowercase/i);
      }
      expect(threw).toBe(true);
    });

    it('rejects negative failed_login_count via chk_failed_login_count_nonnegative constraint', async () => {
      let threw = false;
      try {
        await adminPool.query(
          'UPDATE users SET failed_login_count = -1 WHERE user_id = $1',
          [adminUserId]
        );
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/chk_failed_login_count_nonnegative/i);
      }
      expect(threw).toBe(true);
    });
  });
  describe('9. Administrator Provisioning Script (scripts/createAdmin.js)', () => {
    it('manages admin provisioning via provisionAdmin and rejects non-admin promotion or oversized input', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { provisionAdmin, hashPassword: hashAdminPassword } = require('../scripts/createAdmin');

      // 1. Creates a new admin
      const emailNew = `new_admin_${Date.now()}@univ.edu`;
      const hashNew = await hashAdminPassword('ValidPassword123!');
      const createRes = await provisionAdmin(adminPool, emailNew, hashNew);
      expect(createRes.created).toBe(true);
      expect(createRes.user.email).toBe(emailNew);
      expect(createRes.user.role).toBe('ADMIN');

      try {
        // 2. Updates an existing admin's password
        const hashUpdated = await hashAdminPassword('AnotherPassword123!');
        const updateRes = await provisionAdmin(adminPool, emailNew, hashUpdated);
        expect(updateRes.created).toBe(false);
        expect(updateRes.user.email).toBe(emailNew);

        // 3. Refuses to promote an existing FACULTY user
        await expect(
          provisionAdmin(adminPool, facultyEmail1, hashUpdated)
        ).rejects.toThrow(/Cannot promote user.*with role "FACULTY" to ADMIN/);

        // 4. Rejects over-long email (> 255 chars)
        const oversizedEmail = 'a'.repeat(250) + '@univ.edu';
        await expect(
          provisionAdmin(adminPool, oversizedEmail, hashUpdated)
        ).rejects.toThrow(/Email cannot exceed 255 characters/);
      } finally {
        await adminPool.query('DELETE FROM users WHERE email = $1', [emailNew]);
      }
    });
  });
});
