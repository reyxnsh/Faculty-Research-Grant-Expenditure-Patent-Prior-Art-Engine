#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');
const readline = require('readline');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_LEN).toString('hex');
    crypto.scrypt(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(`scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt}$${derivedKey.toString('hex')}`);
      }
    );
  });
}

/**
 * Provisions or updates an administrator account in the database.
 * - If user does not exist: creates new ADMIN user.
 * - If user exists and role is ADMIN: updates password, reactivates, resets failure count and lockout.
 * - If user exists and role is not ADMIN (e.g. FACULTY): refuses to promote and throws an error.
 * - Enforces maximum length bounds (email <= 255 chars).
 */
async function provisionAdmin(client, rawEmail, passwordHash) {
  if (!rawEmail || typeof rawEmail !== 'string') {
    throw new Error('A valid email address is required.');
  }

  const email = rawEmail.trim().toLowerCase();
  if (email.length > 255) {
    throw new Error('Email cannot exceed 255 characters.');
  }
  if (!email.includes('@')) {
    throw new Error('A valid email address is required.');
  }

  if (!passwordHash || typeof passwordHash !== 'string') {
    throw new Error('A valid password hash is required.');
  }

  // Check if a user with this email already exists
  const existingRes = await client.query(
    'SELECT user_id, email, role, is_active FROM users WHERE email = $1',
    [email]
  );

  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    if (existing.role !== 'ADMIN') {
      throw new Error(`Cannot promote user "${email}" with role "${existing.role}" to ADMIN.`);
    }

    const updateRes = await client.query(
      `UPDATE users
       SET password_hash = $1,
           is_active = TRUE,
           failed_login_count = 0,
           locked_until = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2
       RETURNING user_id, email, role`,
      [passwordHash, existing.user_id]
    );

    return { user: updateRes.rows[0], created: false };
  }

  const insertRes = await client.query(
    `INSERT INTO users (email, password_hash, role, is_active)
     VALUES ($1, $2, 'ADMIN', TRUE)
     RETURNING user_id, email, role`,
    [email, passwordHash]
  );

  return { user: insertRes.rows[0], created: true };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let email = null;
  let password = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) {
      email = args[i + 1];
      i++;
    } else if (args[i] === '--password' && args[i + 1]) {
      password = args[i + 1];
      i++;
    }
  }

  return { email, password };
}

/**
 * Cross-platform terminal password input that mutes output and safely restores terminal state on exit or Ctrl+C.
 */
function askHiddenPassword(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);

    const stdin = process.stdin;
    const isTTY = stdin.isTTY;
    const wasRaw = Boolean(stdin.isRaw);

    let password = '';

    const cleanup = () => {
      try {
        if (isTTY && stdin.setRawMode) {
          stdin.setRawMode(wasRaw);
        }
        stdin.pause();
        stdin.removeListener('data', onData);
      } catch {
        // cleanup suppression
      }
    };

    const onData = (chunk) => {
      const str = chunk.toString('utf8');
      for (const char of str) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(password);
          return;
        } else if (char === '\u0003') {
          // Ctrl+C
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (char === '\b' || char === '\x7f') {
          password = password.slice(0, -1);
        } else {
          password += char;
        }
      }
    };

    if (isTTY && stdin.setRawMode) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

async function main() {
  let { email, password } = parseArgs();

  if (!email) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    email = await new Promise((resolve) => {
      rl.question('Enter administrator email: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!email || !email.includes('@')) {
    console.error('Error: A valid email address is required.');
    process.exit(1);
  }

  email = email.trim().toLowerCase();
  if (email.length > 255) {
    console.error('Error: Email cannot exceed 255 characters.');
    process.exit(1);
  }

  if (!password) {
    password = await askHiddenPassword('Enter administrator password (min 10 characters): ');
  }

  if (!password || password.length < 10) {
    console.error('Error: Password must be at least 10 characters long.');
    process.exit(1);
  }

  if (password.length > 256) {
    console.error('Error: Password cannot exceed 256 characters.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : undefined,
    database: process.env.POSTGRES_DB,
  });

  try {
    await client.connect();
    const passwordHash = await hashPassword(password);
    const result = await provisionAdmin(client, email, passwordHash);

    if (result.created) {
      console.log(`Success: Admin user "${result.user.email}" (ID: ${result.user.user_id}) provisioned successfully.`);
    } else {
      console.log(`Success: Existing admin user "${result.user.email}" (ID: ${result.user.user_id}) updated successfully.`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

module.exports = {
  provisionAdmin,
  hashPassword,
};

if (require.main === module) {
  main();
}
