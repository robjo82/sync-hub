/**
 * Signing in through Cloudflare Access.
 *
 * The hub already sits behind a Cloudflare tunnel, and Access already fronts the secret broker,
 * so the identity layer exists and is paid for. Access can authenticate by one-time e-mail code
 * with no identity provider at all — which means colleagues get a login without anyone creating
 * an OAuth client in Google Cloud.
 *
 * Access proves who the visitor is by injecting a signed JWT in `Cf-Access-Jwt-Assertion`. The
 * companion header `Cf-Access-Authenticated-User-Email` is convenient and must never be trusted
 * on its own: it is a plain header, so anyone able to reach the origin directly could set it and
 * become anyone. The signature is the only thing that makes the claim worth anything, and it is
 * what this module checks.
 */
import { createPublicKey, createVerify } from 'node:crypto';

export interface AccessConfig {
  /** e.g. "robinjoseph.cloudflareaccess.com" — the team domain that issued the token. */
  teamDomain: string;
  /** The Access application's AUD tag. A token minted for another application must not pass. */
  audience: string;
  /** Domains allowed to sign in. Empty is refused — see accessConfigFromEnv. */
  allowedDomains: string[];
}

export function accessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const teamDomain = env.SYNC_HUB_ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const audience = env.SYNC_HUB_ACCESS_AUD?.trim();
  const allowedDomains = (env.SYNC_HUB_ACCESS_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  if (!teamDomain || !audience) return null;
  // Same reasoning as the Google flow: an absent domain list disables the feature rather than
  // admitting everyone. Access policies should already restrict this, but a second lock costs
  // nothing and a forgotten variable should fail closed.
  if (allowedDomains.length === 0) return null;

  return { teamDomain, audience, allowedDomains };
}

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
}

/**
 * Access's signing keys, cached.
 *
 * They rotate, so a `kid` that is not in the cache forces one refetch — but no more than that,
 * or an unknown kid becomes a way to make the hub hammer Cloudflare on demand.
 */
export class AccessKeyStore {
  private keys = new Map<string, Jwk>();
  /** null until the first fetch — "never fetched" is not the same as "fetched at time zero". */
  private lastFetch: number | null = null;
  private static readonly MIN_REFETCH_MS = 60_000;

  constructor(
    private readonly teamDomain: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async keyFor(kid: string, now: number = Date.now()): Promise<Jwk | null> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    if (this.lastFetch !== null && now - this.lastFetch < AccessKeyStore.MIN_REFETCH_MS) return null;

    this.lastFetch = now;
    const res = await this.fetchImpl(`https://${this.teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: Jwk[] };
    this.keys = new Map((body.keys ?? []).filter((k) => k.kid).map((k) => [k.kid, k] as const));
    return this.keys.get(kid) ?? null;
  }
}

export interface AccessIdentity {
  email: string;
  /** Access's own subject id, stable per user. */
  subject: string;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
}

/**
 * Verifies an Access assertion and returns who it says the visitor is.
 *
 * Throws rather than returning null: every failure here is a refusal to authenticate, and the
 * reason is worth logging. Nothing is trusted before the signature checks out — in particular the
 * claims are only read after verification, so a forged token cannot influence the decision.
 */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  keys: AccessKeyStore,
  now: Date = new Date(),
): Promise<AccessIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('assertion Access malformée');

  const header = decodeSegment(parts[0]);
  if (header.alg !== 'RS256') throw new Error(`algorithme inattendu : ${String(header.alg)}`);
  const kid = String(header.kid ?? '');
  if (!kid) throw new Error('assertion sans identifiant de clé');

  const jwk = await keys.keyFor(kid, now.getTime());
  if (!jwk) throw new Error('clé de signature inconnue');

  const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'))) {
    throw new Error('signature invalide');
  }

  // Only now are the claims worth reading.
  const claims = decodeSegment(parts[1]);

  const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? '')];
  if (!audiences.includes(config.audience)) throw new Error('assertion émise pour une autre application');

  const issuer = String(claims.iss ?? '');
  if (issuer !== `https://${config.teamDomain}`) throw new Error('émetteur inattendu');

  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now.getTime()) throw new Error('assertion expirée');

  const email = String(claims.email ?? '').trim().toLowerCase();
  const domain = email.split('@')[1];
  if (!email || !domain) throw new Error('assertion sans adresse');
  if (!config.allowedDomains.includes(domain)) {
    throw new Error(`domaine non autorisé : ${domain}`);
  }

  return { email, subject: String(claims.sub ?? email) };
}
