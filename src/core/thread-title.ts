/**
 * Naming a thread after its first message.
 *
 * The obvious rule — take the first 80 characters — produces a good title surprisingly often and
 * a useless one the rest of the time, because a conversation frequently opens on something that
 * is not a sentence: a pasted stack trace, a system-injected preamble, a file dump, a diff, a
 * `<command-name>` wrapper, a bare path. The thread then carries that as its name for good, and
 * it is what the user sees in the sidebar and in search results.
 *
 * So: walk the opening lines and use the first one that reads like a person writing to someone.
 * Everything here is a display convenience over text that is stored byte-exact either way, and it
 * only ever picks between lines that are actually present — it never composes or summarises.
 *
 * When nothing qualifies, it falls back to the old behaviour rather than inventing a title: a
 * mangled prefix is still more identifying than "Session a1b2c3d4", and the user can rename the
 * thread by hand (manage_thread's `rename`).
 */

/** Openings that are structure or machinery rather than something someone typed. */
const TECHNICAL_LINE = [
  /^```/, // fenced code
  /^(?:<\/?[a-z][\w-]*(?:\s|>|\/)|<!)/i, // an XML/HTML tag: <system-reminder>, <command-name>, <!DOCTYPE
  /^[[{]/, // JSON / array dump
  /^#!/, // shebang
  /^(?:[a-z]:[\\/]|\/[\w.-]+\/)/i, // C:\… or /usr/local/…
  /^https?:\/\//i,
  /^(?:[+-]{3}\s|@@\s)/, // diff headers
  /^\s*at\s+\S+\s*\(/, // stack frame: "at Object.<anonymous> (…)"
  // Python's frame line reads almost like a sentence — enough words, mostly letters — so it needs
  // naming outright, or a traceback's second line becomes the thread's title.
  /^File\s+"[^"]*",\s*line\s+\d+/i,
  /,\s*line\s+\d+,\s*in\s+/i,
  /^(?:Traceback \(most recent call last\)|[A-Za-z.]*(?:Error|Exception):)/,
  /^(?:\$|>|#)\s/, // shell prompt or quoted line
  /^[|+\-=_*#~]{3,}$/, // a rule or table border
  /^\s*[\w./-]+\.(?:ts|tsx|js|jsx|py|json|ya?ml|sql|sh|md|txt|csv|log):\d+/, // file:line
];

/**
 * Preambles that tools inject ahead of the user's own words.
 *
 * These are the hard case, and the reason a ratio-and-word-count rule is not enough on its own:
 * they are grammatical English sentences, so every generic "does this read like prose" test says
 * yes. Each entry below was taken from a title that actually went wrong in the stored corpus,
 * not imagined — "Here is a list of plugins that are available but not installed." was standing
 * as the name of several threads.
 */
const INJECTED_PREFIX = [
  /^Caveat:/i,
  /^This session is being continued/i,
  /^This is (?:an )?untrusted/i,
  /^<system-reminder>/i,
  /^\[Request interrupted/i,
  /^Analysis:/i,
  /^Here is a list of plugins/i,
  /^Files mentioned by the user/i,
  /^Referenced ChatGPT conversation/i,
  /^The user (?:sent|opened|attached)/i,
  /^Contents of /i,
];

/**
 * Whether a line reads as prose: enough words, and mostly letters rather than punctuation and
 * symbols. The ratio is what separates "Migration de la TVA sur Acritec" from
 * "const x = {a:1, b:[2,3]};" without needing to know any particular language.
 */
function looksLikeProse(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 12) return false;
  if (TECHNICAL_LINE.some((re) => re.test(trimmed))) return false;
  if (INJECTED_PREFIX.some((re) => re.test(trimmed))) return false;

  // A catalogue entry reads as prose by every generic measure — "Atlassian Rovo
  // (atlassian-rovo@openai-curated-remote)" has words and letters — but it is a machine
  // identifier, and it was being chosen as the title of several real threads. An address, a URL
  // or a slug-with-@ is never what someone typed to open a conversation.
  if (/\S+@\S+|:\/\/|plugin:\/\//.test(trimmed)) return false;

  const words = trimmed.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length < 3) return false;

  const letters = (trimmed.match(/[\p{L}\p{M}\s'’,.;:!?()-]/gu) ?? []).length;
  return letters / trimmed.length >= 0.75;
}

/** Strips markdown emphasis and list bullets so a title is not "## **Contexte**". */
function tidy(line: string): string {
  return line
    .replace(/^[#>\s]*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wrappers a tool puts around the user's message, and everything they contain.
 *
 * Skipping these line by line is not enough: in the real corpus they arrive as a single very long
 * line, so the user's actual first sentence sits inside it rather than after it. Threads whose
 * whole opening was `<recommended_plugins>…` or `<environment_context>…` had nothing else to be
 * named from and kept a title made of machine context.
 */
const WRAPPER_BLOCKS =
  /<(recommended_plugins|environment_context|system-reminder|uploaded_files|command-name|command-message|command-args|local-command-stdout|ide_selection|user-memory-input)\b[\s\S]*?<\/\1>/gi;

function stripWrapperBlocks(text: string): string {
  // Twice: these nest in practice (a reminder inside an environment block).
  return text.replace(WRAPPER_BLOCKS, '\n').replace(WRAPPER_BLOCKS, '\n');
}

const MAX_LENGTH = 80;

function truncate(text: string): string {
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}

/**
 * The best available title for a thread opening on `firstUserContent`.
 *
 * `fallbackId` names the thread when the content offers nothing at all (an empty first message,
 * or a session that opens straight into tool output).
 */
export function deriveThreadTitle(firstUserContent: string | undefined, fallbackId: string): string {
  const fallback = `Session ${fallbackId.slice(0, 8)}`;
  if (!firstUserContent?.trim()) return fallback;

  const content = stripWrapperBlocks(firstUserContent);

  // Only the opening matters: a title should come from how the conversation starts, not from a
  // sentence buried 200 lines into a pasted log.
  const lines = content.split('\n').slice(0, 40);

  let insideFence = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    const candidate = tidy(line);
    if (looksLikeProse(candidate)) return truncate(candidate);
  }

  // Nothing prose-like: keep the historical behaviour rather than returning something emptier
  // than what the user had before.
  const oneLine = firstUserContent.replace(/\s+/g, ' ').trim();
  return oneLine ? truncate(oneLine) : fallback;
}
