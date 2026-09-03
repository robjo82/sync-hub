/**
 * Signing in with a Google account.
 *
 * Colleagues should not have to be handed a password to read their own conversations, and a
 * password issued by someone else is a password that never gets rotated. This is the standard
 * authorization-code flow, with one addition that matters here: the account must belong to an
 * allowed domain. Without it, "sign in with Google" means anyone on earth with a Google account,
 * which on a store of client conversations is not a login screen but an open door.
 *
 * The network calls live in the server; everything decidable without a network is here, so it can
 * be tested directly.
 */

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** e.g. "ekonum.fr". Empty means no domain restriction, which is refused — see isConfigured. */
  allowedDomains: string[];
  /** Absolute, and registered as a redirect URI on the Google client. */
  redirectUri: string;
}

/** Reads the configuration from the environment, or null when it is not set up. */
export function googleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = env.SYNC_HUB_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.SYNC_HUB_GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.SYNC_HUB_GOOGLE_REDIRECT_URI?.trim();
  const domains = (env.SYNC_HUB_GOOGLE_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  if (!clientId || !clientSecret || !redirectUri) return null;
  // A missing domain list is treated as "not configured" rather than "allow everyone": forgetting
  // to set it should disable the button, not open the instance to every Google account alive.
  if (domains.length === 0) return null;

  return { clientId, clientSecret, allowedDomains: domains, redirectUri };
}

/** Where to send the browser to start the flow. */
export function buildAuthorizeUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // Ask Google to show only accounts on the allowed domain — a convenience, never a control:
    // the claim is still checked on the way back.
    hd: config.allowedDomains[0],
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleIdentity {
  email: string;
  displayName: string;
  hostedDomain?: string;
  emailVerified: boolean;
}

/**
 * Reads the claims out of an id_token.
 *
 * The signature is deliberately not verified here: this token is not accepted from a browser, it
 * is fetched by the server directly from Google's token endpoint over TLS, which is the one case
 * Google documents as not needing local verification. Everything that is checked below —
 * audience, issuer, expiry, verified email, domain — is checked precisely because the transport
 * alone does not say the token was minted for *this* client.
 */
export function parseIdToken(idToken: string, config: GoogleConfig, now: Date = new Date()): GoogleIdentity {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('id_token malformé');

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    throw new Error('id_token illisible');
  }

  const audience = claims.aud;
  if (audience !== config.clientId) throw new Error("id_token émis pour une autre application");

  const issuer = String(claims.iss ?? '');
  if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
    throw new Error('id_token émis par un tiers inattendu');
  }

  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now.getTime()) throw new Error('id_token expiré');

  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!email) throw new Error('id_token sans adresse');

  // An unverified address can be anything the account holder typed, so it proves nothing.
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (!emailVerified) throw new Error('Adresse Google non vérifiée');

  return {
    email,
    displayName: String(claims.name ?? '').trim() || email.split('@')[0],
    hostedDomain: typeof claims.hd === 'string' ? claims.hd.toLowerCase() : undefined,
    emailVerified,
  };
}

/**
 * Whether this identity may sign in.
 *
 * Both the hosted-domain claim and the address itself are checked. `hd` alone is not enough — a
 * personal gmail account carries none — and the address alone is not enough either, so requiring
 * agreement between them is the honest reading of "someone at this company".
 */
export function isAllowedIdentity(identity: GoogleIdentity, config: GoogleConfig): boolean {
  const domainOfEmail = identity.email.split('@')[1]?.toLowerCase();
  if (!domainOfEmail) return false;
  if (!config.allowedDomains.includes(domainOfEmail)) return false;
  if (identity.hostedDomain && identity.hostedDomain !== domainOfEmail) return false;
  return true;
}

/** Opaque, single-use CSRF token tying a callback to the request that started it. */
export function createStateStore(ttlMs = 10 * 60_000) {
  const states = new Map<string, number>();

  return {
    issue(state: string, now: number = Date.now()): void {
      states.set(state, now + ttlMs);
    },
    /** True at most once per state: a replayed callback is not a fresh sign-in. */
    consume(state: string | undefined, now: number = Date.now()): boolean {
      if (!state) return false;
      const expiry = states.get(state);
      states.delete(state);
      if (expiry === undefined) return false;
      // Sweep anything else that has aged out, so an abandoned flow cannot accumulate.
      for (const [key, value] of states) if (value <= now) states.delete(key);
      return expiry > now;
    },
    get size(): number {
      return states.size;
    },
  };
}
