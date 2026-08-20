import type { Artifact, Memory } from '../../types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

export function DocumentViewer({ document }: { document: { kind: 'memory'; item: Memory } | { kind: 'artifact'; item: Artifact } }) {
  const item = document.item;
  const title = document.kind === 'memory' ? document.item.filePath.split('/').pop() : document.item.title;

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          <p className="text-xs text-slate-500">{item.filePath}</p>
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(item.content)}
          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-900"
        >
          Copier
        </button>
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
        <MarkdownRenderer text={item.content} />
      </div>
    </div>
  );
}
