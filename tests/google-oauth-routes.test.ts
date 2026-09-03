import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';
import type { GoogleConfig } from '../src/core/google-oauth.js';

const CONFIG: GoogleConfig = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret',
  allowedDomains: ['ekonum.fr'],
  redirectUri: 'https://sync-hub.test/api/auth/google/callback',
};

const fakeWatch = { isActive: () => true, ready: () => Promise.resolve(), close: async () => {} };

describe('Google sign-in routes', () => {
  let dir: string;
  let db: Db;
  let app: ReturnType<typeof createApp>;

  const build = (googleConfig: GoogleConfig | null) =>
    createApp({
      db,
      registry: new ProjectRegistry(db),
      watchHandle: fakeWatch,
      rescan: () => {},
      archiveRoots: { syncHubArchiveRoot: join(dir, 'a') },
      importsDir: join(dir, 'i'),
      googleConfig,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-google-'));
    db = new Db(join(dir, 'hub.sqlite'));
  });

  afterEach(async () => {
    await app?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('offers the button only when the flow is configured', async () => {
    app = build(CONFIG);
    const on = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(on.json().googleAvailable).toBe(true);
    expect(on.json().googleDomains).toEqual(['ekonum.fr']);

    await app.close();
    app = build(null);
    const off = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(off.json().googleAvailable).toBe(false);
  });

  it('sends an unconfigured instance nowhere at all', async () => {
    app = build(null);
    expect((await app.inject({ method: 'GET', url: '/api/auth/google' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=x' })).statusCode).toBe(404);
  });

  it('starts the flow with a state, and redirects to Google', async () => {
    app = build(CONFIG);
    const res = await app.inject({ method: 'GET', url: '/api/auth/google' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.host).toBe('accounts.google.com');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('refuses a callback whose state it never issued', async () => {
    // Without this, anyone could hand a signed-in colleague a crafted callback URL.
    app = build(CONFIG);
    const res = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc&state=jamais-emis' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('auth_error');
    expect(decodeURIComponent(res.headers.location as string)).toMatch(/rejou|expir/i);
  });

  it('refuses a callback with no code, and reports a refusal in readable terms', async () => {
    app = build(CONFIG);
    const start = await app.inject({ method: 'GET', url: '/api/auth/google' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;

    const res = await app.inject({ method: 'GET', url: `/api/auth/google/callback?error=access_denied&state=${state}` });
    expect(res.headers.location).toContain('auth_error');
    expect(decodeURIComponent(res.headers.location as string)).toContain('refus');
  });

  it('never signs anyone in without reaching Google', async () => {
    // The callback must not create a session from query parameters alone.
    app = build(CONFIG);
    const start = await app.inject({ method: 'GET', url: '/api/auth/google' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;

    const res = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=faux-code&state=${state}` });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.countUsers()).toBe(0);
  });

  it('leaves the password login working alongside it', async () => {
    app = build(CONFIG);
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.z', password: 'zzz' } });
    // Wrong credentials, but the route still answers on its own terms rather than being shadowed.
    expect(res.statusCode).toBe(401);
  });
});
