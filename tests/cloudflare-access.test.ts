import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  AccessKeyStore,
  accessConfigFromEnv,
  verifyAccessToken,
  type AccessConfig,
} from '../src/core/cloudflare-access.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
// publicKey is already a KeyObject here, so it exports to JWK directly.
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256' };

const CONFIG: AccessConfig = {
  teamDomain: 'robinjoseph.cloudflareaccess.com',
  audience: 'aud-tag-de-lapplication',
  allowedDomains: ['ekonum.fr'],
};

const NOW = new Date('2026-09-04T12:00:00Z');

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Mints a token the way Access would, so the test exercises real RS256 verification. */
function mint(claims: Record<string, unknown>, header: Record<string, unknown> = {}, key = privateKey): string {
  const h = b64({ alg: 'RS256', kid: 'k1', ...header });
  const p = b64(claims);
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  signer.end();
  return `${h}.${p}.${signer.sign(key).toString('base64url')}`;
}

const validClaims = {
  aud: [CONFIG.audience],
  iss: `https://${CONFIG.teamDomain}`,
  exp: Math.floor(NOW.getTime() / 1000) + 3600,
  email: 'Robin@Ekonum.fr',
  sub: 'sub-123',
};

/** A key store answering from a fixed JWKS, without touching the network. */
const store = (keys: unknown[] = [jwk]) =>
  new AccessKeyStore(CONFIG.teamDomain, (async () => ({
    ok: true,
    json: async () => ({ keys }),
  })) as unknown as typeof fetch);

describe('accessConfigFromEnv', () => {
  const base = {
    SYNC_HUB_ACCESS_TEAM_DOMAIN: 'robinjoseph.cloudflareaccess.com',
    SYNC_HUB_ACCESS_AUD: 'aud',
    SYNC_HUB_ACCESS_ALLOWED_DOMAINS: 'ekonum.fr',
  } as NodeJS.ProcessEnv;

  it('reads a complete configuration', () => {
    expect(accessConfigFromEnv(base)?.allowedDomains).toEqual(['ekonum.fr']);
  });

  it('tolerates a team domain given as a URL', () => {
    expect(accessConfigFromEnv({ ...base, SYNC_HUB_ACCESS_TEAM_DOMAIN: 'https://robinjoseph.cloudflareaccess.com/' })?.teamDomain)
      .toBe('robinjoseph.cloudflareaccess.com');
  });

  it('fails closed when the domain list is missing', () => {
    expect(accessConfigFromEnv({ ...base, SYNC_HUB_ACCESS_ALLOWED_DOMAINS: '' })).toBeNull();
  });

  it('is not configured without an audience', () => {
    expect(accessConfigFromEnv({ ...base, SYNC_HUB_ACCESS_AUD: undefined })).toBeNull();
  });
});

describe('verifyAccessToken', () => {
  it('accepts a genuine assertion and returns the identity', async () => {
    const identity = await verifyAccessToken(mint(validClaims), CONFIG, store(), NOW);
    expect(identity.email).toBe('robin@ekonum.fr'); // lowercased
    expect(identity.subject).toBe('sub-123');
  });

  it('refuses a token signed by someone else', async () => {
    // The whole point of verifying: the header alone would have said "robin@ekonum.fr".
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(verifyAccessToken(mint(validClaims, {}, other), CONFIG, store(), NOW)).rejects.toThrow(/signature/);
  });

  it('refuses an unsigned token claiming "none"', async () => {
    const h = b64({ alg: 'none', kid: 'k1' });
    const token = `${h}.${b64(validClaims)}.`;
    await expect(verifyAccessToken(token, CONFIG, store(), NOW)).rejects.toThrow(/algorithme/);
  });

  it('refuses a token minted for another Access application', async () => {
    await expect(verifyAccessToken(mint({ ...validClaims, aud: ['autre-app'] }), CONFIG, store(), NOW))
      .rejects.toThrow(/autre application/);
  });

  it('refuses another team domain as issuer', async () => {
    await expect(verifyAccessToken(mint({ ...validClaims, iss: 'https://evil.cloudflareaccess.com' }), CONFIG, store(), NOW))
      .rejects.toThrow(/émetteur/);
  });

  it('refuses an expired assertion', async () => {
    const expired = { ...validClaims, exp: Math.floor(NOW.getTime() / 1000) - 1 };
    await expect(verifyAccessToken(mint(expired), CONFIG, store(), NOW)).rejects.toThrow(/expirée/);
  });

  it('refuses an address outside the allowed domains', async () => {
    await expect(verifyAccessToken(mint({ ...validClaims, email: 'someone@gmail.com' }), CONFIG, store(), NOW))
      .rejects.toThrow(/domaine non autorisé/);
    // And a lookalike must not slip through.
    await expect(verifyAccessToken(mint({ ...validClaims, email: 'x@ekonum.fr.evil.com' }), CONFIG, store(), NOW))
      .rejects.toThrow(/domaine non autorisé/);
  });

  it('refuses when the signing key is unknown', async () => {
    await expect(verifyAccessToken(mint(validClaims), CONFIG, store([]), NOW)).rejects.toThrow(/clé de signature/);
  });

  it('refuses a malformed assertion', async () => {
    await expect(verifyAccessToken('pas-un-jwt', CONFIG, store(), NOW)).rejects.toThrow(/malformée/);
  });
});

describe('AccessKeyStore', () => {
  it('does not refetch on every unknown kid', async () => {
    // Otherwise an unknown kid is a way to make the hub hammer Cloudflare on demand.
    let calls = 0;
    const s = new AccessKeyStore(CONFIG.teamDomain, (async () => {
      calls++;
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }) as unknown as typeof fetch);

    expect(await s.keyFor('inconnu', 1_000)).toBeNull();
    expect(await s.keyFor('inconnu', 2_000)).toBeNull();
    expect(calls).toBe(1);
  });

  it('serves a cached key without going back to the network', async () => {
    let calls = 0;
    const s = new AccessKeyStore(CONFIG.teamDomain, (async () => {
      calls++;
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }) as unknown as typeof fetch);

    expect(await s.keyFor('k1', 1_000)).not.toBeNull();
    expect(await s.keyFor('k1', 5_000_000)).not.toBeNull();
    expect(calls).toBe(1);
  });
});
