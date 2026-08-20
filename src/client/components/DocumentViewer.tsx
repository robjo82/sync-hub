import { Copy } from 'lucide-react';
import type { Artifact, Memory } from '../../types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

export function DocumentViewer({ document }: { document: { kind: 'memory'; item: Memory } | { kind: 'artifact'; item: Artifact } }) {
  const item = document.item;
  const title = document.kind === 'memory' ? document.item.filePath.split('/').pop() : document.item.title;

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{item.filePath}</p>
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(item.content)}
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          <Copy size={12} />
          Copier
        </button>
      </div>
      <div className="rounded-lg border border-border bg-muted/60 p-4 text-foreground">
        <MarkdownRenderer text={item.content} />
      </div>
    </div>
  );
}
