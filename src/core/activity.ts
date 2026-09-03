/**
 * How much human time a conversation represents.
 *
 * The point of this is billing: hours spent on a client's work, recoverable from the transcript
 * months later. So the numbers have to be defensible, and the obvious formula is not.
 *
 * Counting characters and dividing by a typing rate gives, on this corpus, 46.4M characters of
 * user text — 805 days of continuous typing at 40 keystrokes a minute. Wrong by orders of
 * magnitude, because most of those characters were pasted: the median user message is 170
 * characters and the longest is 363,510.
 *
 * Two anchors keep the estimate honest:
 *
 *  1. **Only plausibly-typed text counts.** Fenced code, quoted email, and tool-injected wrappers
 *     are removed before counting — nobody types a 4,000-line log.
 *  2. **You cannot have typed for longer than you had.** Each message's typing time is capped by
 *     the wall-clock gap since the previous message in the thread. This is the strong one: it
 *     bounds a guess with something actually observed, and it is what stops a pasted block from
 *     inflating a day into a week.
 *
 * Everything here is an estimate and is labelled as one wherever it surfaces. Thinking time, by
 * contrast, is measured: it is the interval between a message and the reply to it.
 */

/** Keystrokes per minute. Deliberately low — a slow, realistic pace under-bills rather than over-bills. */
export const DEFAULT_KEYSTROKES_PER_MINUTE = 40;

/**
 * Ceiling for a message with no predecessor to measure against (the first of a thread).
 * Five minutes: long enough for a considered opening prompt, short enough that a pasted brief
 * cannot become an hour.
 */
const FIRST_MESSAGE_CAP_MS = 5 * 60_000;

/**
 * Beyond this, a gap is someone having left rather than thinking. Applies to both directions:
 * an assistant reply 6 hours later is a resumed session, not 6 hours of computation.
 */
const ABANDONED_GAP_MS = 30 * 60_000;

/** Text a person plausibly typed, with what they clearly did not removed. */
export function typedCharacters(content: string): number {
  if (!content) return 0;

  const withoutBlocks = content
    // Tool wrappers: never typed by anyone.
    .replace(/<(system-reminder|recommended_plugins|environment_context|uploaded_files|command-name|command-message|command-args|local-command-stdout|ide_selection)\b[\s\S]*?<\/\1>/gi, '')
    // Fenced code and pasted output.
    .replace(/```[\s\S]*?```/g, '')
    // Quoted email or quoted reply — forwarded, not composed.
    .replace(/^>.*$/gm, '')
    // An indented block of four spaces or more is pasted code in markdown.
    .replace(/^(?: {4}|\t).*$/gm, '');

  return withoutBlocks.trim().length;
}

export interface MessageForActivity {
  role: string;
  content: string;
  timestamp: string;
  /** Milliseconds since the previous message in the same thread, or null for the first one. */
  gapMs: number | null;
}

export interface ActivityDurations {
  /** Estimated time spent composing user messages. */
  typingMs: number;
  /** Measured interval between a user message and the reply to it. */
  thinkingMs: number;
}

/**
 * Typing and thinking time for one message.
 *
 * `gapMs` is what the caller observed between this message and the previous one in its thread;
 * it both caps typing (for a user turn) and *is* thinking time (for an assistant turn).
 */
export function durationsForMessage(message: MessageForActivity, keystrokesPerMinute: number): ActivityDurations {
  const rate = keystrokesPerMinute > 0 ? keystrokesPerMinute : DEFAULT_KEYSTROKES_PER_MINUTE;

  if (message.role === 'user') {
    const chars = typedCharacters(message.content);
    const naive = (chars / rate) * 60_000;
    // The cap is the whole point: an estimate that exceeds the time that actually passed is not
    // an estimate, it is arithmetic detached from what happened.
    const available = message.gapMs === null ? FIRST_MESSAGE_CAP_MS : Math.min(message.gapMs, ABANDONED_GAP_MS);
    return { typingMs: Math.min(naive, available), thinkingMs: 0 };
  }

  if (message.role === 'assistant') {
    const gap = message.gapMs ?? 0;
    return { typingMs: 0, thinkingMs: gap > ABANDONED_GAP_MS ? 0 : gap };
  }

  // System and tool turns are neither typed nor thought about.
  return { typingMs: 0, thinkingMs: 0 };
}

/** Which slice of the corpus to measure. Every field is optional; nothing set means everything. */
export interface ActivityScope {
  threadId?: string;
  projectId?: string;
  category?: string;
  startDate?: string;
  endDate?: string;
  /** The person's own typing pace; defaults to DEFAULT_KEYSTROKES_PER_MINUTE. */
  keystrokesPerMinute?: number;
}

interface ActivityBucket {
  typingMs: number;
  thinkingMs: number;
  messages: number;
}

export interface ActivitySummary {
  /** Estimated, and capped by elapsed time — see this module's opening note. */
  totalTypingMs: number;
  /** Measured, not estimated. */
  totalThinkingMs: number;
  messageCount: number;
  /**
   * How many user messages had their estimate cut down by the elapsed-time cap. High is expected
   * and is the point: it says how much of the figure rests on observation rather than on the rate.
   */
  cappedMessageCount: number;
  keystrokesPerMinute: number;
  byDate: Array<ActivityBucket & { date: string }>;
  byHour: Array<ActivityBucket & { hour: number }>;
  byProject: Array<ActivityBucket & { projectId: string; name: string }>;
}

/** Human-readable duration, e.g. "2 h 14 min", "38 min", "45 s". */
export function formatActivityDuration(ms: number): string {
  if (ms < 1000) return '0 s';
  // Test the raw value, not the rounded one: rounding first turned 45 s into "1 min".
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
