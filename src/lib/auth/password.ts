import crypto from 'crypto';

/**
 * Scrypt password hashing parameters:
 * N = 16384 (CPU/memory cost parameter)
 * r = 8 (block size)
 * p = 1 (parallelization parameter)
 * keylen = 64 (derived key length in bytes)
 *
 * These parameters use Node.js defaults, representing a balanced trade-off between
 * cryptographic security and execution performance for this project. Cost parameters
 * can be raised in the future because each hash stores its own configuration.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

// Precomputed constant dummy hash used to neutralize timing attacks when a user does not exist
const DUMMY_HASH =
  'scrypt$N=16384,r=8,p=1$0123456789abcdef0123456789abcdef$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Hashes a plain-text password using scrypt with a unique cryptographically secure salt.
 * Returns a self-describing serialized string:
 * `scrypt$N=16384,r=8,p=1$<salt_hex>$<hash_hex>`
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      }
    );
  });

  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt}$${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plain-text password against a self-describing stored scrypt hash using timingSafeEqual.
 * Safely handles malformed strings by returning false without leaking internal exceptions.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    if (!storedHash || typeof storedHash !== 'string') {
      return false;
    }

    const parts = storedHash.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') {
      return false;
    }

    const paramStr = parts[1];
    const salt = parts[2];
    const originalHashHex = parts[3];

    // Parse parameters: N=16384,r=8,p=1
    const params = new Map<string, number>();
    for (const pair of paramStr.split(',')) {
      const [k, v] = pair.split('=');
      params.set(k, parseInt(v, 10));
    }

    const n = params.get('N');
    const r = params.get('r');
    const p = params.get('p');

    if (!n || !r || !p || !salt || !originalHashHex) {
      return false;
    }

    // Enforce parameter safety bounds:
    // N must be a power of two between 2^10 (1024) and 2^20 (1048576)
    // r between 1 and 16
    // p between 1 and 4
    const isPowerOfTwo = (val: number) => val > 0 && (val & (val - 1)) === 0;
    if (n < 1024 || n > 1048576 || !isPowerOfTwo(n) || r < 1 || r > 16 || p < 1 || p > 4) {
      return false;
    }

    const originalHash = Buffer.from(originalHashHex, 'hex');
    const candidateHash = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        password,
        salt,
        originalHash.length,
        { N: n, r, p },
        (err, key) => {
          if (err) reject(err);
          else resolve(key);
        }
      );
    });

    if (candidateHash.length !== originalHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateHash, originalHash);
  } catch {
    return false;
  }
}

/**
 * Executes a dummy scrypt verification against a precomputed dummy hash to guarantee
 * consistent constant-time response behavior when non-existent usernames/emails are queried.
 */
export async function verifyDummyPassword(password: string): Promise<boolean> {
  await verifyPassword(password, DUMMY_HASH);
  return false;
}
