import { describe, expect, it } from 'vitest';
import { deriveThreadTitle } from '../src/core/thread-title.js';

const ID = 'a1b2c3d4-5678-90ab-cdef-1234567890ab';

describe('deriveThreadTitle', () => {
  it('uses the opening sentence when the thread opens on one', () => {
    expect(deriveThreadTitle('Migration de la TVA sur la base Acritec', ID)).toBe(
      'Migration de la TVA sur la base Acritec',
    );
  });

  it('skips a pasted stack trace to reach the actual question', () => {
    const content = [
      'Traceback (most recent call last):',
      '  File "run.py", line 42, in <module>',
      '    main()',
      'ValueError: invalid literal',
      '',
      "Peux-tu m'expliquer d'où vient cette erreur ?",
    ].join('\n');
    expect(deriveThreadTitle(content, ID)).toBe("Peux-tu m'expliquer d'où vient cette erreur ?");
  });

  it('skips an injected preamble rather than naming the thread after it', () => {
    const content = [
      'Caveat: The messages below were generated while running a command.',
      '<command-name>/ekonum-mission-odoo</command-name>',
      '',
      'Reprends le chantier de reprise des contrats Acritec',
    ].join('\n');
    expect(deriveThreadTitle(content, ID)).toBe('Reprends le chantier de reprise des contrats Acritec');
  });

  it('does not name a thread after the code someone pasted', () => {
    const content = ['```ts', 'const x = { a: 1, b: [2, 3] };', '```', '', 'Ce bout de code me pose problème en production'].join('\n');
    expect(deriveThreadTitle(content, ID)).toBe('Ce bout de code me pose problème en production');
  });

  it('ignores a leading file path or URL', () => {
    const content = ['/Users/robin/Projets/sync-hub/src/core/db.ts', '', 'Revois la gestion des transactions ici'].join('\n');
    expect(deriveThreadTitle(content, ID)).toBe('Revois la gestion des transactions ici');
  });

  it('strips markdown so the title is not "## **Contexte**"', () => {
    expect(deriveThreadTitle('## **Contexte du chantier** de reprise', ID)).toBe('Contexte du chantier de reprise');
  });

  it('truncates a long opening rather than filling the sidebar', () => {
    const long = `Analyse ${'très '.repeat(40)}longue`;
    const title = deriveThreadTitle(long, ID);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to the raw opening rather than to nothing', () => {
    // Nothing prose-like anywhere: a mangled prefix still identifies the thread better than
    // "Session a1b2c3d4", and it can be renamed by hand.
    const content = '{"tool":"bash","cmd":"ls -la"}';
    expect(deriveThreadTitle(content, ID)).toBe('{"tool":"bash","cmd":"ls -la"}');
  });

  it('names an empty thread after its session, having nothing else', () => {
    expect(deriveThreadTitle(undefined, ID)).toBe('Session a1b2c3d4');
    expect(deriveThreadTitle('   \n  ', ID)).toBe('Session a1b2c3d4');
  });

  it('does not mistake a short greeting for prose', () => {
    // Under three words: not a title anyone would recognise, so the raw fallback applies.
    expect(deriveThreadTitle('Salut', ID)).toBe('Salut');
  });

  it('only looks at the opening, not at prose buried in a long log', () => {
    const content = [...Array(60).fill('  at Object.<anonymous> (/app/x.js:1:1)'), 'Voici enfin ma vraie question'].join('\n');
    // The sentence sits past the window on purpose: a title should reflect how the thread opens.
    expect(deriveThreadTitle(content, ID)).not.toBe('Voici enfin ma vraie question');
  });
});

describe('a hand-chosen title outlives re-ingestion', () => {
  it('is not overwritten when the session file is ingested again', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Db } = await import('../src/core/db.js');

    const dir = mkdtempSync(join(tmpdir(), 'sync-hub-title-'));
    const db = new Db(join(dir, 'hub.sqlite'));
    const now = '2026-09-03T10:00:00.000Z';
    db.upsertProject({ id: 'p1', name: 'P', canonicalPath: join(dir, 'p'), aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now });
    const thread = {
      id: 't1', projectId: 'p1', originEngine: 'codex' as const, engineIds: {}, messageCount: 0,
      createdAt: now, updatedAt: now, status: 'active' as const, title: 'Traceback (most recent call last)',
    };
    db.upsertThread(thread);

    try {
      db.renameThread('t1', 'Reprise des contrats Acritec');
      // Codex derives the title afresh on every ingest and upserts it; without the custom flag
      // this second write would silently restore the derived name.
      db.upsertThread({ ...thread, title: 'Traceback (most recent call last)' });
      expect(db.getThread('t1')?.title).toBe('Reprise des contrats Acritec');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still refreshes a derived title when nobody has renamed it', async () => {
    // The flag must not freeze every title — only the ones a person chose. A thread that was
    // never renamed should still pick up a better derivation on the next ingest.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Db } = await import('../src/core/db.js');

    const dir = mkdtempSync(join(tmpdir(), 'sync-hub-title2-'));
    const db = new Db(join(dir, 'hub.sqlite'));
    const now = '2026-09-03T10:00:00.000Z';
    db.upsertProject({ id: 'p1', name: 'P', canonicalPath: join(dir, 'p'), aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now });
    const thread = {
      id: 't1', projectId: 'p1', originEngine: 'codex' as const, engineIds: {}, messageCount: 0,
      createdAt: now, updatedAt: now, status: 'active' as const, title: 'Session 019fc39b',
    };
    db.upsertThread(thread);

    try {
      db.upsertThread({ ...thread, title: 'Reprise des contrats Acritec' });
      expect(db.getThread('t1')?.title).toBe('Reprise des contrats Acritec');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
