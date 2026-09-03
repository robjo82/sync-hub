import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createStateStore,
  googleConfigFromEnv,
  isAllowedIdentity,
  parseIdToken,
  type GoogleConfig,
} from '../src/core/google-oauth.js';

const CONFIG: GoogleConfig = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret',
  allowedDomains: ['ekonum.fr'],
  redirectUri: 'https://sync-hub.robin-joseph.fr/api/auth/google/callback',
};

const NOW = new Date('2026-09-03T12:00:00Z');

function idToken(claims: Record<string, unknown>): string {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature-non-verifiee-ici`;
}

const validClaims = {
  aud: CONFIG.clientId,
  iss: 'https://accounts.google.com',
  exp: Math.floor(NOW.getTime() / 1000) + 3600,
  email: 'Robin@Ekonum.fr',
  email_verified: true,
  name: 'Robin Joseph',
  hd: 'ekonum.fr',
};

describe('googleConfigFromEnv', () => {
  const base = {
    SYNC_HUB_GOOGLE_CLIENT_ID: 'id',
    SYNC_HUB_GOOGLE_CLIENT_SECRET: 'secret',
    SYNC_HUB_GOOGLE_REDIRECT_URI: 'https://example.test/cb',
    SYNC_HUB_GOOGLE_ALLOWED_DOMAINS: 'ekonum.fr',
  } as NodeJS.ProcessEnv;

  it('reads a complete configuration', () => {
    expect(googleConfigFromEnv(base)?.allowedDomains).toEqual(['ekonum.fr']);
  });

  it('treats a missing domain list as not configured, never as "allow everyone"', () => {
    // Forgetting this variable must disable the button, not open a store of client conversations
    // to every Google account in existence.
    expect(googleConfigFromEnv({ ...base, SYNC_HUB_GOOGLE_ALLOWED_DOMAINS: '' })).toBeNull();
    expect(googleConfigFromEnv({ ...base, SYNC_HUB_GOOGLE_ALLOWED_DOMAINS: undefined })).toBeNull();
  });

  it('is not configured when any credential is missing', () => {
    expect(googleConfigFromEnv({ ...base, SYNC_HUB_GOOGLE_CLIENT_SECRET: undefined })).toBeNull();
    expect(googleConfigFromEnv({ ...base, SYNC_HUB_GOOGLE_REDIRECT_URI: undefined })).toBeNull();
  });

  it('accepts several domains', () => {
    expect(googleConfigFromEnv({ ...base, SYNC_HUB_GOOGLE_ALLOWED_DOMAINS: 'ekonum.fr, autre.fr' })?.allowedDomains)
      .toEqual(['ekonum.fr', 'autre.fr']);
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks for the code flow, with the state and the redirect it will be checked against', () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, 'state-abc'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });
});

describe('parseIdToken', () => {
  it('reads the identity out of a well-formed token', () => {
    const identity = parseIdToken(idToken(validClaims), CONFIG, NOW);
    expect(identity.email).toBe('robin@ekonum.fr'); // lowercased
    expect(identity.displayName).toBe('Robin Joseph');
    expect(identity.hostedDomain).toBe('ekonum.fr');
  });

  it('refuses a token minted for another application', () => {
    // The whole reason to check anything: TLS says it came from Google, not that it was for us.
    expect(() => parseIdToken(idToken({ ...validClaims, aud: 'autre-client' }), CONFIG, NOW)).toThrow(/autre application/);
  });

  it('refuses a token from an unexpected issuer', () => {
    expect(() => parseIdToken(idToken({ ...validClaims, iss: 'https://evil.example' }), CONFIG, NOW)).toThrow(/tiers/);
  });

  it('refuses an expired token', () => {
    const expired = { ...validClaims, exp: Math.floor(NOW.getTime() / 1000) - 1 };
    expect(() => parseIdToken(idToken(expired), CONFIG, NOW)).toThrow(/expiré/);
  });

  it('refuses an unverified address, which proves nothing', () => {
    expect(() => parseIdToken(idToken({ ...validClaims, email_verified: false }), CONFIG, NOW)).toThrow(/non vérifiée/);
  });

  it('refuses a malformed token rather than trusting part of it', () => {
    expect(() => parseIdToken('pas-un-jwt', CONFIG, NOW)).toThrow(/malformé/);
    expect(() => parseIdToken('a.!!!.c', CONFIG, NOW)).toThrow();
  });

  it('falls back to the local part when Google sends no name', () => {
    expect(parseIdToken(idToken({ ...validClaims, name: undefined }), CONFIG, NOW).displayName).toBe('robin');
  });
});

describe('isAllowedIdentity', () => {
  const identity = (over: Partial<{ email: string; hostedDomain?: string }>) => ({
    email: 'robin@ekonum.fr',
    displayName: 'Robin',
    emailVerified: true,
    ...over,
  });

  it('lets through an address on an allowed domain', () => {
    expect(isAllowedIdentity(identity({}), CONFIG)).toBe(true);
  });

  it('keeps out a personal account', () => {
    expect(isAllowedIdentity(identity({ email: 'quelquun@gmail.com', hostedDomain: undefined }), CONFIG)).toBe(false);
  });

  it('keeps out an address whose domain disagrees with the hosted-domain claim', () => {
    // Agreement between the two is what "someone at this company" actually means.
    expect(isAllowedIdentity(identity({ email: 'robin@ekonum.fr', hostedDomain: 'autre.fr' }), CONFIG)).toBe(false);
  });

  it('is not fooled by a lookalike domain', () => {
    expect(isAllowedIdentity(identity({ email: 'robin@notekonum.fr', hostedDomain: undefined }), CONFIG)).toBe(false);
    expect(isAllowedIdentity(identity({ email: 'robin@ekonum.fr.evil.com', hostedDomain: undefined }), CONFIG)).toBe(false);
  });
});

describe('state store', () => {
  it('accepts a state exactly once', () => {
    const store = createStateStore();
    store.issue('s1');
    expect(store.consume('s1')).toBe(true);
    // A replayed callback is not a fresh sign-in.
    expect(store.consume('s1')).toBe(false);
  });

  it('rejects a state it never issued, or none at all', () => {
    const store = createStateStore();
    expect(store.consume('jamais-emis')).toBe(false);
    expect(store.consume(undefined)).toBe(false);
  });

  it('rejects a state that has aged out, and does not hoard them', () => {
    const store = createStateStore(1000);
    store.issue('s1', 0);
    store.issue('s2', 0);
    expect(store.consume('s1', 5000)).toBe(false);
    expect(store.size).toBe(0); // s2 swept as well
  });
});
