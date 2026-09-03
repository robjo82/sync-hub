import { describe, expect, it } from 'vitest';
import { decodeTextEscapes } from '../src/client/components/MarkdownRenderer.js';

describe('decodeTextEscapes — what real transcripts arrive carrying', () => {
  it('decodes the numeric entities an exporter leaves behind', () => {
    // Straight from a real thread: "…les deux nouveaux échanges :&#x20;"
    expect(decodeTextEscapes('échanges :&#x20;')).toBe('échanges : ');
    expect(decodeTextEscapes('&#65;&#66;')).toBe('AB');
  });

  it('unescapes an address that never needed escaping', () => {
    expect(decodeTextEscapes('David JAUCH \\<d.jauch\\@acritec.fr>')).toBe('David JAUCH <d.jauch@acritec.fr>');
  });

  it('resolves named entities, decoding &amp; last so it cannot double-decode', () => {
    expect(decodeTextEscapes('Tom &amp; Jerry')).toBe('Tom & Jerry');
    // Must stay the literal text "&lt;" — decoding &amp; first would turn this into "<".
    expect(decodeTextEscapes('&amp;lt;')).toBe('&lt;');
  });

  it('turns a non-breaking space into one, not into the word', () => {
    expect(decodeTextEscapes('a&nbsp;b')).toBe('a\u00a0b');
  });

  it('survives a malformed entity instead of throwing', () => {
    expect(() => decodeTextEscapes('&#99999999999; et &#xZZ;')).not.toThrow();
    expect(decodeTextEscapes('&#xZZ;')).toBe('&#xZZ;');
  });

  it('leaves text with nothing to decode exactly as it was', () => {
    const plain = 'Bonjour David, je pense qu’il était ok pour le point le 4 à 9h.';
    expect(decodeTextEscapes(plain)).toBe(plain);
  });

  it('does not invent characters from a lone backslash', () => {
    // A backslash before a letter is not an escape and must survive untouched.
    expect(decodeTextEscapes('C:\\temp\\notes')).toBe('C:\\temp\\notes');
  });
});
