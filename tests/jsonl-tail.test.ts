import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonlFrom } from '../src/core/jsonl-tail.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-tail-'));
  file = join(dir, 'transcript.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readJsonlFrom', () => {
  it('resumes exactly where the previous read stopped when the file only grew', () => {
    writeFileSync(file, '{"a":1}\n');
    const offset = statSync(file).size;
    appendFileSync(file, '{"a":2}\n');

    expect(readJsonlFrom(file, offset)).toBe('{"a":2}\n');
  });

  it('treats the offset as bytes, not string indexes, on accented content', () => {
    // The bug this pins: statSync reports bytes, but slicing a decoded string uses character
    // indexes. "é" is two bytes and one character, so a string-sliced tail lands too far into
    // the file and silently drops whole lines. Measured on the real corpus before the fix: up to
    // 194 564 characters skipped on one 45MB session.
    const first = '{"texte":"éàüœ — accentué, mesuré, déjà"}\n';
    writeFileSync(file, first);
    const offset = statSync(file).size;
    expect(offset).toBeGreaterThan(first.length); // bytes really do exceed characters here

    appendFileSync(file, '{"texte":"la suite"}\n');
    expect(readJsonlFrom(file, offset)).toBe('{"texte":"la suite"}\n');
  });

  it('re-reads the whole file when it shrank, instead of returning nothing', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n');
    const offset = statSync(file).size;
    // Rewritten shorter — the recorded offset now points past the end.
    writeFileSync(file, '{"b":1}\n');

    expect(readJsonlFrom(file, offset)).toBe('{"b":1}\n');
  });

  it('returns the whole file when there is no offset yet', () => {
    writeFileSync(file, '{"a":1}\n');
    expect(readJsonlFrom(file)).toBe('{"a":1}\n');
    expect(readJsonlFrom(file, 0)).toBe('{"a":1}\n');
  });

  it('returns null for a file it cannot read, so callers can log it rather than crash', () => {
    expect(readJsonlFrom(join(dir, 'absent.jsonl'))).toBeNull();
  });
});
