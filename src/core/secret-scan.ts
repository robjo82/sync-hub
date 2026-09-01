/**
 * Finds credentials sitting in the verbatim corpus.
 *
 * sync-hub stores conversations exactly as they happened, which is the whole point — and which
 * means a secret pasted into a prompt, echoed by a tool, or printed by a script is now archived,
 * indexed for search, and pushed to the hub. This happened here for real: a sync token ended up
 * in an Antigravity transcript and rode into the very hub it protected.
 *
 * Detection is deliberately split by confidence. Vendor prefixes are near-certain. The generic
 * "secret = value" shape is not: a corpus full of code and documentation is full of assignments
 * that merely look like one. Nothing is ever removed on a match alone — findings go to a human,
 * because deleting a false positive destroys real conversation, and that is worse than the leak.
 */

export type SecretConfidence = 'certain' | 'probable';

export interface SecretFinding {
  /** What matched, so a reviewer can tell an OpenAI key from a stray base64 blob. */
  kind: string;
  confidence: SecretConfidence;
  /** Byte-free offsets into the scanned string, for an exact replacement. */
  start: number;
  end: number;
  /** The literal match — never sent to a client; used to redact and to compute the mask. */
  value: string;
}

interface Pattern {
  kind: string;
  confidence: SecretConfidence;
  regex: RegExp;
  /** Which capture group holds the secret itself, when the match includes surrounding syntax. */
  group?: number;
}

const PATTERNS: Pattern[] = [
  // Vendor-prefixed: the prefix alone makes these unambiguous.
  // (?!ant-) : sans cela ce motif avale aussi les clés Anthropic, qui partagent le préfixe sk-.
  { kind: 'Clé OpenAI', confidence: 'certain', regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'Clé Anthropic', confidence: 'certain', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'Jeton GitHub', confidence: 'certain', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { kind: 'Jeton GitHub (fine-grained)', confidence: 'certain', regex: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { kind: 'Jeton GitLab', confidence: 'certain', regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'Jeton Portainer', confidence: 'certain', regex: /\bptr_[A-Za-z0-9+/=]{30,}/g },
  { kind: 'Jeton Slack', confidence: 'certain', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Clé AWS', confidence: 'certain', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Jeton Cloudflare', confidence: 'certain', regex: /\bcfut_[A-Za-z0-9_-]{30,}/g },
  { kind: 'Clé privée', confidence: 'certain', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'Jeton JWT', confidence: 'certain', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },

  // Shape-based: real often enough to surface, wrong often enough to never act on alone.
  {
    kind: 'Secret nommé',
    confidence: 'probable',
    // The keyword may be the tail of a longer identifier — SYNC_HUB_REMOTE_TOKEN is the exact
    // shape that leaked here, and `_` being a word character means \b never fires before TOKEN.
    regex: /(?:[A-Za-z0-9]*[_-])?(?:password|passwd|secret|api[_-]?key|apikey|token|client[_-]?secret)["'\s]*[:=]\s*["']?([A-Za-z0-9_\-./+]{16,})["']?/gi,
    group: 1,
  },
  {
    kind: 'En-tête Authorization',
    confidence: 'probable',
    regex: /\bBearer\s+([A-Za-z0-9_\-.=+/]{24,})/g,
    group: 1,
  },
];

/**
 * Values that match a pattern but carry no secret. Placeholders dominate documentation and
 * example configuration, and flagging them trains a reviewer to click through without looking —
 * which is exactly how a real one gets approved by accident.
 */
const PLACEHOLDER = /^(?:x{4,}|\*{4,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|(?:your|my|the)[_-]?|example|placeholder|redacted|changeme|test|dummy|sample|xxx|abc123|password|secret|token)/i;

/**
 * Values that name a secret rather than being one. A corpus full of code is full of these, and
 * every one of them in the review list is a reason to stop reading it.
 */
const CODE_REFERENCE = /(?:process\.env|os\.environ|ENV\[|getenv|\$\{|<%=)/;

function isPlaceholder(value: string, confidence: SecretConfidence): boolean {
  if (PLACEHOLDER.test(value)) return true;
  // A single repeated character is never a credential.
  if (/^(.)\1+$/.test(value)) return true;
  // A filled-in placeholder keeps its prefix: sk-xxxxxxxxxxxx is documentation, not a key.
  if (/(?:x{6,}|\*{6,}|\.{6,})/i.test(value)) return true;

  // The rest only applies to shape-based matches. A vendor prefix already identifies the thing,
  // and second-guessing it loses real keys — AWS keys are all-caps by design, which the
  // identifier heuristic below would otherwise discard.
  if (confidence === 'certain') return false;

  // `apiKey = process.env.OPENAI_API_KEY` reads the secret, it does not contain it.
  if (CODE_REFERENCE.test(value)) return true;
  // An all-caps underscored identifier is a variable name, not its value.
  if (/^[A-Z][A-Z0-9_]{8,}$/.test(value)) return true;
  // A dotted identifier path — `cloud_api_key: settings.cloudApiKey`. Overwhelmingly the shape of
  // a false positive here: on this corpus it accounted for essentially every probable match
  // sampled, all of them code reading a credential rather than stating one.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return true;
  // Credentials are random; identifiers and prose are not. Measured on the real corpus, this is
  // what separates `J3s0VrRm…` from `enableSummarization`.
  if (shannonEntropy(value) < 3.2) return true;
  return false;
}

/** Bits of entropy per character — a cheap stand-in for "does this look generated". */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Finds every credential-looking span in one string, ordered by position, without overlaps. */
export function scanText(text: string): SecretFinding[] {
  if (!text) return [];
  const found: SecretFinding[] = [];

  for (const pattern of PATTERNS) {
    // Fresh regex per call: a shared /g regex carries lastIndex between calls and silently skips.
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = pattern.group ? match[pattern.group] : match[0];
      if (!value || isPlaceholder(value, pattern.confidence)) continue;
      const offset = pattern.group ? match[0].lastIndexOf(value) : 0;
      const start = match.index + (offset < 0 ? 0 : offset);
      found.push({ kind: pattern.kind, confidence: pattern.confidence, start, end: start + value.length, value });
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  // A vendor-prefixed key inside an `api_key = ...` assignment matches both patterns. Keeping the
  // outer span only would be enough to redact, but reporting one finding per secret is what makes
  // the review list mean anything.
  const deduped: SecretFinding[] = [];
  for (const finding of found) {
    const previous = deduped[deduped.length - 1];
    if (previous && finding.start < previous.end) {
      if (finding.confidence === 'certain' && previous.confidence === 'probable') deduped[deduped.length - 1] = finding;
      continue;
    }
    deduped.push(finding);
  }
  return deduped;
}

/** `sk-ab…9f21` — enough for a human to recognise a secret without the page reprinting it. */
export function maskSecret(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Replaces every finding in a string with a marker, right to left so earlier offsets hold. */
export function redactText(text: string, findings: SecretFinding[]): string {
  let out = text;
  for (const finding of [...findings].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, finding.start) + `[secret retiré — ${finding.kind}]` + out.slice(finding.end);
  }
  return out;
}
