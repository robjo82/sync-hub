/**
 * Which model a conversation most likely ran on, when the transcript never said.
 *
 * The Claude.ai and ChatGPT web archives carry no model field and no token counts — an export is
 * just the text. For those, the only signals left are the application the conversation came from
 * and the date it happened, so this maps (provider, date) to the flagship model of that moment.
 *
 * This is a deliberate over-estimate and is reported as an upper bound, never folded into the
 * measured total. Real usage was a mix: short exchanges went to whatever was fastest, and the
 * flagship rate is the most expensive tier on offer. "At most this much" is a defensible thing to
 * say; a centred estimate is not, because nothing in an export distinguishes the two.
 *
 * The gpt-5.x dates are the dated model ids published by OpenAI and carried in gpt-tokenizer's own
 * model list (gpt-5-2025-08-07, gpt-5.1-2025-11-13, gpt-5.2-2025-12-11, gpt-5.4-2026-03-05,
 * gpt-5.5-2026-04-23). The earlier entries are general-release dates.
 */
export interface EraEntry {
  /** Inclusive start of the period, ISO date. */
  from: string;
  /** Model id, matching a key in MODEL_PRICING. */
  model: string;
}

const OPENAI_ERAS: EraEntry[] = [
  { from: '2022-11-30', model: 'gpt-3.5-turbo' },
  { from: '2023-03-14', model: 'gpt-4' },
  { from: '2023-11-06', model: 'gpt-4-turbo' },
  { from: '2024-05-13', model: 'gpt-4o' },
  { from: '2025-04-14', model: 'gpt-4.1' },
  { from: '2025-08-07', model: 'gpt-5' },
  { from: '2025-11-13', model: 'gpt-5.1' },
  { from: '2025-12-11', model: 'gpt-5.2' },
  { from: '2026-03-05', model: 'gpt-5.4' },
  { from: '2026-04-23', model: 'gpt-5.5' },
];

const ANTHROPIC_ERAS: EraEntry[] = [
  { from: '2024-03-04', model: 'claude-3-opus' },
  { from: '2024-06-20', model: 'claude-3-5-sonnet' },
  { from: '2025-05-22', model: 'claude-opus-4' },
  { from: '2025-08-05', model: 'claude-opus-4-1' },
  { from: '2025-11-24', model: 'claude-opus-4-5' },
  { from: '2026-05-14', model: 'claude-opus-5' },
];

/**
 * The flagship model in service for `provider` on `timestamp`, or null before that provider's
 * first entry — a conversation predating everything priced stays uncounted rather than being
 * attributed to a model that did not exist yet.
 */
export function modelForEra(provider: 'openai' | 'anthropic', timestamp: string): string | null {
  const eras = provider === 'openai' ? OPENAI_ERAS : ANTHROPIC_ERAS;
  const date = timestamp.slice(0, 10);
  let found: string | null = null;
  for (const era of eras) {
    if (era.from <= date) found = era.model;
    else break;
  }
  return found;
}

/** Which provider an archived thread came from, by the id the importer gave it. */
export function providerForThread(threadId: string): 'openai' | 'anthropic' | null {
  if (threadId.startsWith('chatgpt-export')) return 'openai';
  if (threadId.startsWith('claude-export')) return 'anthropic';
  return null;
}
