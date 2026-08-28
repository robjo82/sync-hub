import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, generateSessionToken, hashSessionToken } from '../src/core/crypto.js';

describe('Crypto helpers', () => {
  it('hashes and verifies valid password', async () => {
    const password = 'SuperSecretPassword123!';
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);

    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it('rejects incorrect password', async () => {
    const password = 'SuperSecretPassword123!';
    const hash = await hashPassword(password);

    const isValid = await verifyPassword('WrongPassword', hash);
    expect(isValid).toBe(false);
  });

  it('handles invalid hash formats gracefully', async () => {
    expect(await verifyPassword('password', 'invalid-hash')).toBe(false);
    expect(await verifyPassword('password', 'scrypt$bad$numbers$salt$key')).toBe(false);
  });

  it('generates random session tokens and deterministic hashes', () => {
    const token1 = generateSessionToken();
    const token2 = generateSessionToken();
    expect(token1).toHaveLength(64);
    expect(token2).toHaveLength(64);
    expect(token1).not.toBe(token2);

    const hash1 = hashSessionToken(token1);
    const hash1Again = hashSessionToken(token1);
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash1Again);
  });
});
