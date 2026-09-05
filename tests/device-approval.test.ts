import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';

const fakeWatch = { isActive: () => true, ready: () => Promise.resolve(), close: async () => {} };

/** What the colleague's machine does: mint locally, publish only the digest. */
function mintOnDevice(): { token: string; fingerprint: string } {
  const token = randomBytes(32).toString('hex');
  return { token, fingerprint: createHash('sha256').update(token).digest('hex') };
}

describe('approving a device by its fingerprint', () => {
  let dir: string;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-approve-'));
    db = new Db(join(dir, 'hub.sqlite'));
    app = createApp({
      db,
      registry: new ProjectRegistry(db),
      watchHandle: fakeWatch,
      rescan: () => {},
      archiveRoots: { syncHubArchiveRoot: join(dir, 'a') },
      importsDir: join(dir, 'i'),
    });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'robin@ekonum.fr', displayName: 'Robin', password: 'un-mot-de-passe-solide' },
    });
    cookie = String(setup.headers['set-cookie']).split(';')[0];
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const approve = (fingerprint: string, name = 'MacBook du bureau') =>
    app.inject({ method: 'POST', url: '/api/tokens/approve', headers: { cookie }, payload: { fingerprint, name } });

  it('lets a machine sync with a token the hub never saw', async () => {
    // The whole point: the secret is minted on the device and never travels.
    const { token, fingerprint } = mintOnDevice();
    expect((await approve(fingerprint)).statusCode).toBe(200);

    const pull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?afterSeq=0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pull.statusCode).toBe(200);
  });

  it('never returns the token, because it does not have it', async () => {
    const { fingerprint } = mintOnDevice();
    const body = (await approve(fingerprint)).json();
    expect(JSON.stringify(body)).not.toContain('token');
    expect(body.name).toBe('MacBook du bureau');
  });

  it('refuses anything that is not a fingerprint', async () => {
    for (const bad of ['', 'trop-court', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect((await approve(bad)).statusCode).toBe(400);
    }
  });

  it('accepts an uppercase fingerprint, since people paste what they are given', async () => {
    const { token, fingerprint } = mintOnDevice();
    expect((await approve(fingerprint.toUpperCase())).statusCode).toBe(200);
    const pull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?afterSeq=0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pull.statusCode).toBe(200);
  });

  it('refuses to approve the same device twice', async () => {
    // Two rows resolving to one machine would make revocation only half work.
    const { fingerprint } = mintOnDevice();
    expect((await approve(fingerprint)).statusCode).toBe(200);
    expect((await approve(fingerprint, 'Autre nom')).statusCode).toBe(409);
  });

  it('requires a name, so a device list stays readable', async () => {
    const { fingerprint } = mintOnDevice();
    const res = await app.inject({
      method: 'POST', url: '/api/tokens/approve', headers: { cookie },
      payload: { fingerprint, name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an unauthenticated approval', async () => {
    const { fingerprint } = mintOnDevice();
    const res = await app.inject({ method: 'POST', url: '/api/tokens/approve', payload: { fingerprint, name: 'X' } });
    expect(res.statusCode).toBe(401);
  });

  it('stops working once revoked', async () => {
    const { token, fingerprint } = mintOnDevice();
    const created = (await approve(fingerprint)).json();
    await app.inject({ method: 'POST', url: `/api/tokens/${created.id}/revoke`, headers: { cookie } });

    const pull = await app.inject({
      method: 'GET', url: '/api/sync/pull?afterSeq=0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pull.statusCode).toBe(401);
  });

  it('leaves the hub-minted route working alongside it', async () => {
    // Both paths coexist: machines already enrolled the old way must keep syncing.
    const res = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'Ancienne voie' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });
});
