import { describe, expect, it } from 'vitest';
import { computeMessageHash } from '../src/core/hash.js';

describe('computeMessageHash', () => {
  it('is deterministic for identical input', () => {
    expect(computeMessageHash('user', 'bonjour')).toBe(computeMessageHash('user', 'bonjour'));
  });

  it('differs when content differs', () => {
    expect(computeMessageHash('user', 'a')).not.toBe(computeMessageHash('user', 'b'));
  });

  it('differs when only `thought` differs, even with identical (empty) role+content — the exact bug this session found in Codex/ChatGPT reasoning-only turns', () => {
    const h1 = computeMessageHash('assistant', '', 'première réflexion');
    const h2 = computeMessageHash('assistant', '', 'deuxième réflexion, complètement différente');
    expect(h1).not.toBe(h2);
  });

  it('a thought-only message never collides with a genuinely empty message', () => {
    const withThought = computeMessageHash('assistant', '', 'je réfléchis');
    const empty = computeMessageHash('assistant', '', undefined);
    expect(withThought).not.toBe(empty);
  });
});
