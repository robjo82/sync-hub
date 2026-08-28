import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function deriveKey(password: string, salt: Buffer, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Hashes a plaintext password using Node's native scrypt with a random 16-byte salt.
 * Formatted as: `scrypt$N$r$p$saltHex$hashHex`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plaintext password against a stored scrypt combined hash using constant-time comparison.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false;
    }

    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'hex');
    const expectedKey = Buffer.from(parts[5], 'hex');

    if (isNaN(n) || isNaN(r) || isNaN(p) || salt.length === 0 || expectedKey.length !== KEY_LEN) {
      return false;
    }

    const derivedKey = await deriveKey(password, salt, n, r, p);
    return timingSafeEqual(expectedKey, derivedKey);
  } catch {
    return false;
  }
}

/**
 * Generates a cryptographically secure random session token.
 */
export function generateSessionToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

/**
 * Computes the SHA-256 hash of a session token for secure database storage and indexing.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
