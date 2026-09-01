import { describe, expect, it } from 'vitest';
import { scanText, redactText, maskSecret } from '../src/core/secret-scan.js';

describe('scanText — vendor-prefixed credentials', () => {
  it('finds the shapes that actually leaked into this corpus', () => {
    const cases: Array<[string, string]> = [
      ['sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', 'Clé OpenAI'],
      ['sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234', 'Clé Anthropic'],
      ['ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd', 'Jeton GitHub'],
      ['glpat-aBcDeFgHiJkLmNoPqRsT', 'Jeton GitLab'],
      ['ptr_cm3Snu3JnLUTOfOkv8m9aBKXDg5pkmBtc50lgTYiE=', 'Jeton Portainer'],
      ['AKIAIOSFODNN7EXAMPLE', 'Clé AWS'],
      ['xoxb-1234567890-abcdefghij', 'Jeton Slack'],
    ];
    for (const [secret, kind] of cases) {
      const found = scanText(`voici la valeur ${secret} à ne pas laisser traîner`);
      expect(found, kind).toHaveLength(1);
      expect(found[0].kind).toBe(kind);
      expect(found[0].confidence).toBe('certain');
      expect(found[0].value).toBe(secret);
    }
  });

  it('finds a private key block whole, not line by line', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const found = scanText(`la clé :\n${key}\nfin`);
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(key);
  });

  it('reports each occurrence, so a secret repeated in a transcript is fully removable', () => {
    const secret = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd';
    expect(scanText(`${secret} ... plus loin ... ${secret}`)).toHaveLength(2);
  });
});

describe('scanText — shape-based detection', () => {
  it('flags a named secret assignment as probable, not certain', () => {
    const found = scanText('SYNC_HUB_REMOTE_TOKEN=J3s0VrRmLeaSww6ts2Ry3GPl43r14a8TDELwMMyFPq3D');
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe('probable');
    expect(found[0].value).toBe('J3s0VrRmLeaSww6ts2Ry3GPl43r14a8TDELwMMyFPq3D');
  });

  it('captures the value only, leaving the variable name in place once redacted', () => {
    const found = scanText('api_key: "aBcDeFgHiJkLmNoPqRsTuV"');
    expect(redactText('api_key: "aBcDeFgHiJkLmNoPqRsTuV"', found)).toContain('api_key');
    expect(redactText('api_key: "aBcDeFgHiJkLmNoPqRsTuV"', found)).not.toContain('aBcDeFgHiJkLmNoPqRsTuV');
  });

  it('reports one finding per secret when both a prefix and an assignment match it', () => {
    const found = scanText('OPENAI_API_KEY=sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(found).toHaveLength(1);
    // The vendor pattern wins: it names the thing precisely for whoever reviews it.
    expect(found[0].confidence).toBe('certain');
    expect(found[0].kind).toBe('Clé OpenAI');
  });
});

describe('scanText — what must NOT be flagged', () => {
  it('ignores placeholders, which is what keeps a review list worth reading', () => {
    const noise = [
      'OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx',
      'password: <votre-mot-de-passe>',
      'api_key = "your-api-key-here"',
      'SECRET=${SYNC_HUB_REMOTE_TOKEN}',
      'token: "REDACTED-REDACTED-REDACTED"',
      'password = "xxxxxxxxxxxxxxxxxx"',
    ];
    for (const line of noise) {
      expect(scanText(line), line).toHaveLength(0);
    }
  });

  it('leaves ordinary prose and code alone', () => {
    const prose = [
      "Le mot de passe doit contenir au moins 8 caractères, c'est la règle.",
      'const apiKey = process.env.OPENAI_API_KEY;',
      'git commit -m "corrige la gestion du token expiré"',
      'https://github.com/robjo82/sync-hub/blob/main/src/core/db.ts',
    ];
    for (const line of prose) {
      expect(scanText(line), line).toHaveLength(0);
    }
  });

  it('returns nothing for empty input rather than throwing', () => {
    expect(scanText('')).toEqual([]);
  });
});

describe('redactText', () => {
  it('removes every secret while keeping the surrounding conversation intact', () => {
    const text = 'Voici ma clé sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 et voilà, à toi de jouer.';
    const redacted = redactText(text, scanText(text));
    expect(redacted).not.toContain('sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(redacted).toContain('Voici ma clé');
    expect(redacted).toContain('et voilà, à toi de jouer.');
    expect(redacted).toContain('[secret retiré — Clé OpenAI]');
  });

  it('handles several secrets in one message without shifting the later offsets', () => {
    const a = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd';
    const b = 'sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    const text = `premier ${a} milieu ${b} fin`;
    const redacted = redactText(text, scanText(text));
    expect(redacted).not.toContain(a);
    expect(redacted).not.toContain(b);
    expect(redacted).toContain('premier');
    expect(redacted).toContain('milieu');
    expect(redacted).toContain('fin');
  });
});

describe('maskSecret', () => {
  it('shows enough to recognise a secret without reprinting it', () => {
    const masked = maskSecret('sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(masked).toBe('sk-pro…6789');
    expect(masked).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ');
  });
});
