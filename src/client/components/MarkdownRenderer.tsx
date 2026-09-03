import { Fragment, type ReactNode } from 'react';
import { FileText, Mail, MessageSquare, Settings2, Share2, Wrench } from 'lucide-react';

// ChatGPT's export serializes its rich-UI annotations (source citations, product/entity chips,
// map widgets, generative-UI blocks…) inline as private-use-area-delimited tokens —
// <type><payload> — verified across the real export (11,600+ occurrences, 20+
// distinct types). Outside ChatGPT's own UI these carry no readable information (an internal
// citation pointer like "turn5file0", a JSON product-card blob…) except the `url` type, which
// carries a real title + link worth keeping. This only cleans the *display*; the DB keeps the
// byte-exact original text.
const CHATGPT_ANNOTATION = /([a-zA-Z0-9_]*)([\s\S]*?)/g;

function cleanChatGptAnnotations(text: string): string {
  if (!text.includes('')) return text;
  return text.replace(CHATGPT_ANNOTATION, (_match, type: string, payload: string) => {
    if (type === 'url') {
      const [title, url] = payload.split('').map((s) => s.trim());
      if (title && url && /^https?:\/\//.test(url)) return `[${title}](${url})`;
    }
    return '';
  });
}

/** Splits a line of text on **bold**, *italic*, `code` spans and [text](url) links, returning safe React nodes (no HTML injection). */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded-xl bg-muted px-2 py-2 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a key={key} href={linkMatch[2]} target="_blank" rel="noreferrer" className="text-accent underline decoration-accent/40 hover:decoration-accent">
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * A small, dependency-free markdown renderer — enough for what AI responses actually use
 * (headers, bullet/numbered lists, blockquotes, fenced code blocks, tables, horizontal rules,
 * bold/italic/inline code/links). Not a complete implementation (no nested lists) — kept
 * intentionally simple rather than pulling in a full markdown dependency for a local
 * single-user dashboard.
 */
export function MarkdownRenderer({ text }: { text: string }) {
  const lines = cleanChatGptAnnotations(text).split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // [external_agent_tool_call: Name] ... [/external_agent_tool_call] and its matching
    // [external_agent_tool_result] or [external_agent_tool_result: error] ... [/external_agent_tool_result]
    // (the closing tag is always plain, even after an "error" opening tag — verified across real
    // Codex sessions) — a real, common pattern (verified: 31,410 plain + 330 "error" occurrences in
    // real Codex sessions) where a proxied tool call/result gets serialized as plain text instead of
    // a structured field. A contiguous run of these (often a dozen+ in a row on real data) collapses
    // into one "Exécuté N commandes" summary, matching the native tool-call grouping in ChatView.
    const isToolBlockTag = (l: string) => {
      const t = l.trim();
      return /^\[external_agent_tool_call:\s*[^\]]*\]$/.test(t) || /^\[external_agent_tool_result(?::\s*[^\]]*)?\]$/.test(t);
    };
    if (isToolBlockTag(line)) {
      const items: { label: string; isCall: boolean; isError: boolean; body: string }[] = [];
      while (i < lines.length && isToolBlockTag(lines[i])) {
        const trimmed = lines[i].trim();
        const callM = trimmed.match(/^\[external_agent_tool_call:\s*([^\]]*)\]$/);
        const resultM = trimmed.match(/^\[external_agent_tool_result(?::\s*([^\]]*))?\]$/);
        const closeTag = callM ? '[/external_agent_tool_call]' : '[/external_agent_tool_result]';
        i++;
        const bodyLines: string[] = [];
        while (i < lines.length && lines[i].trim() !== closeTag) {
          bodyLines.push(lines[i]);
          i++;
        }
        i++; // skip closing tag
        items.push({
          label: callM ? callM[1] || 'outil' : `Résultat${resultM?.[1] ? ' (erreur)' : ''}`,
          isCall: !!callM,
          isError: !!resultM?.[1],
          body: bodyLines.join('\n'),
        });
        // Blank lines between consecutive blocks don't break the run, so a whole call/result chain
        // still collapses into a single summary.
        while (i < lines.length && lines[i].trim() === '' && isToolBlockTag(lines[i + 1] ?? '')) i++;
      }
      const commandCount = items.filter((it) => it.isCall).length || items.length;
      const hasError = items.some((it) => it.isError);
      blocks.push(
        <details
          key={key++}
          className={`my-2 rounded-xl border px-4 py-2 text-sm ${hasError ? 'border-destructive/30 bg-destructive-muted/60' : 'border-border bg-muted/60'}`}
        >
          <summary className={`flex cursor-pointer select-none items-center gap-2 ${hasError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {commandCount > 1 ? <Settings2 size={13} className="shrink-0" /> : <Wrench size={13} className="shrink-0" />}
            {commandCount > 1 ? `Exécuté ${commandCount} commandes` : (items[0]?.label ?? 'Commande')}
          </summary>
          <div className="mt-2 space-y-2">
            {items.map((it, idx) => (
              <div key={idx}>
                <div className={`mb-2 font-medium ${it.isError ? 'text-destructive' : 'text-muted-foreground'}`}>{it.label}</div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground/90">{it.body}</pre>
              </div>
            ))}
          </div>
        </details>,
      );
      continue;
    }

    // :::writing{variant="email"|"chat_message"|"social_post"|"document"|"standard" id="..." ...} ... :::
    // — a real, documented Codex fence for a self-contained written artifact (an email draft, a
    // message to send, a social post…), verified against real output (a full email draft under
    // variant="chat_message"). Rendered as its own labeled card, not folded — unlike the tool/
    // thought blocks, the point here is exactly to make this stand out as a distinct piece of
    // writing, not to hide it. Attributes appear in no fixed order and Codex adds others (seen:
    // `subject` on email variants) — parse them as a generic key="value" bag rather than matching
    // a fixed "variant then id" shape, which silently failed to render real messages where id came
    // first or an extra attribute was present.
    const writingOpenMatch = line.trim().match(/^:::writing\{([^}]*)\}$/);
    if (writingOpenMatch) {
      const attrs: Record<string, string> = {};
      for (const m of writingOpenMatch[1].matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      const variant = attrs.variant ?? 'standard';
      i++;
      const innerLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== ':::') {
        innerLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const VARIANT_LABEL: Record<string, string> = { email: 'Email', chat_message: 'Message', social_post: 'Publication', document: 'Document' };
      const VARIANT_ICON: Record<string, typeof Mail> = { email: Mail, chat_message: MessageSquare, social_post: Share2, document: FileText };
      const Icon = VARIANT_ICON[variant] ?? FileText;
      blocks.push(
        <div key={key++} className="my-2 overflow-hidden rounded-xl border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2 text-sm font-medium text-muted-foreground">
            <Icon size={13} />
            {VARIANT_LABEL[variant] ?? 'Document'}
            {attrs.subject && <span className="font-normal text-muted-foreground/80">· {attrs.subject}</span>}
          </div>
          <div className="px-4 py-2">
            <MarkdownRenderer text={innerLines.join('\n')} />
          </div>
        </div>,
      );
      continue;
    }

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre key={key++} className="my-2 overflow-x-auto rounded-xl bg-muted p-4 text-sm">
          {lang && <div className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">{lang}</div>}
          <code className="font-mono whitespace-pre">{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const sizeClass = level === 1 ? 'text-xl font-semibold' : level === 2 ? 'text-base font-semibold' : 'text-sm font-semibold';
      blocks.push(
        <div key={key++} className={`mt-4 mb-2 ${sizeClass}`}>
          {renderInline(headerMatch[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // Horizontal rule (verified: a very common section divider in real ChatGPT/Codex output —
    // 3900+ occurrences in a 15-shard sample of the real export)
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-4 border-border" />);
      i++;
      continue;
    }

    // Table: a `| ... |` header row followed by a `|---|---|` separator row (GitHub-flavored
    // markdown — verified against real tables in the ChatGPT export).
    const nextLine = lines[i + 1];
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      nextLine !== undefined &&
      /^\s*\|?[\s:-]+\|[\s:|-]*\s*$/.test(nextLine) &&
      nextLine.includes('-')
    ) {
      const splitRow = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headerCells = splitRow(line);
      const align = splitRow(nextLine).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? ('center' as const) : c.endsWith(':') ? ('right' as const) : c.startsWith(':') ? ('left' as const) : undefined,
      );
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {headerCells.map((c, ci) => (
                  <th key={ci} style={{ textAlign: align[ci] }} className="border border-border bg-muted px-2 py-2 text-left font-medium">
                    {renderInline(c, `th${key}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci} style={{ textAlign: align[ci] }} className="border border-border px-2 py-2 align-top">
                      {renderInline(c, `td${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        quoteLines.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="my-2 border-l-2 border-border pl-4 text-muted-foreground italic">
          {quoteLines.join(' ')}
        </blockquote>,
      );
      continue;
    }

    // Bullet or numbered list
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: ReactNode[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        items.push(<li key={key++}>{renderInline(itemText, `li${key}`)}</li>);
        i++;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag key={key++} className={`my-2 ml-6 space-y-2 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items}
        </ListTag>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: consume consecutive non-blank, non-special lines as one block (soft-wrapped)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !lines[i].trimStart().startsWith('>') &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?[\s:-]+\|[\s:|-]*\s*$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-'))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-2">
        {paraLines.map((l, idx) => (
          <Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(l, `p${key}-${idx}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="text-sm leading-relaxed">{blocks}</div>;
}
