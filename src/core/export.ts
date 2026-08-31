import type { Message, Project, Thread } from '../types.js';

const ENGINE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cowork: 'Cowork',
  claude: 'Claude.ai',
  chatgpt: 'ChatGPT',
};

export function sanitizeFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'conversation'
  );
}

export function formatThreadAsMarkdown(thread: Thread, project: Project | null, messages: Message[]): string {
  const lines: string[] = [];
  const projectName = project ? project.name : 'Non affecté';
  const engineLabel = ENGINE_LABELS[thread.originEngine] ?? thread.originEngine;
  const totalTokens = messages.reduce((acc, m) => acc + (m.estimatedTokens || 0), 0);

  lines.push(`# ${thread.title || 'Conversation sans titre'}`);
  lines.push('');
  lines.push(`- **Projet** : ${projectName}`);
  lines.push(`- **Moteur d'origine** : ${engineLabel}`);
  lines.push(`- **Créé le** : ${new Date(thread.createdAt).toLocaleString('fr-FR')}`);
  lines.push(`- **Dernière activité** : ${new Date(thread.updatedAt).toLocaleString('fr-FR')}`);
  lines.push(`- **Messages** : ${messages.length}`);
  if (totalTokens > 0) {
    lines.push(`- **Tokens estimés** : ~${totalTokens.toLocaleString('fr-FR')}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const m of messages) {
    const isUser = m.role === 'user';
    const dateStr = new Date(m.timestamp).toLocaleTimeString('fr-FR');
    const author = isUser ? '👤 Utilisateur' : `🤖 Assistant (${ENGINE_LABELS[m.sourceEngine] ?? m.sourceEngine})`;

    lines.push(`### ${author} — ${dateStr}`);
    lines.push('');

    if (m.thought) {
      lines.push('> **🧠 Raisonnement de l\'IA :**');
      for (const thoughtLine of m.thought.split('\n')) {
        lines.push(`> ${thoughtLine}`);
      }
      lines.push('');
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      lines.push(`*🔧 Appel d'outil (${m.toolCalls.map((c) => c.name).join(', ')})*`);
      lines.push('');
    }

    if (m.content && m.content.trim()) {
      lines.push(m.content.trim());
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  lines.push('*Exporté depuis [Sync Hub](https://github.com/robjo82/sync-hub)*');
  return lines.join('\n');
}

export function formatThreadAsJson(thread: Thread, project: Project | null, messages: Message[]): string {
  return JSON.stringify(
    {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      project: project ? { id: project.id, name: project.name, canonicalPath: project.canonicalPath } : null,
      thread: {
        id: thread.id,
        title: thread.title,
        originEngine: thread.originEngine,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: messages.length,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        sourceEngine: m.sourceEngine,
        timestamp: m.timestamp,
        content: m.content,
        thought: m.thought,
        toolCalls: m.toolCalls,
        toolResults: m.toolResults,
        model: m.model,
        usage: m.usage,
        estimatedTokens: m.estimatedTokens,
      })),
    },
    null,
    2
  );
}

export interface ThreadWithMessages {
  thread: Thread;
  messages: Message[];
}

export function formatProjectAsMarkdown(project: Project, threadsWithMessages: ThreadWithMessages[]): string {
  const lines: string[] = [];
  const totalMessages = threadsWithMessages.reduce((acc, t) => acc + t.messages.length, 0);
  const totalTokens = threadsWithMessages.reduce(
    (acc, t) => acc + t.messages.reduce((mAcc, m) => mAcc + (m.estimatedTokens || 0), 0),
    0
  );

  // Group stats by engine
  const engineCounts: Record<string, { threads: number; messages: number }> = {};
  for (const { thread, messages } of threadsWithMessages) {
    const engine = thread.originEngine;
    if (!engineCounts[engine]) {
      engineCounts[engine] = { threads: 0, messages: 0 };
    }
    engineCounts[engine].threads += 1;
    engineCounts[engine].messages += messages.length;
  }

  lines.push(`# Projet : ${project.name}`);
  lines.push('');
  if (project.canonicalPath) {
    lines.push(`- **Chemin canonique** : \`${project.canonicalPath}\``);
  }
  if (project.category) {
    lines.push(`- **Catégorie** : ${project.category}`);
  }
  lines.push(`- **Date de création** : ${new Date(project.createdAt).toLocaleString('fr-FR')}`);
  lines.push(`- **Dernière activité** : ${new Date(project.lastActiveAt).toLocaleString('fr-FR')}`);
  lines.push(`- **Total conversations** : ${threadsWithMessages.length}`);
  lines.push(`- **Total messages** : ${totalMessages}`);
  if (totalTokens > 0) {
    lines.push(`- **Tokens estimés** : ~${totalTokens.toLocaleString('fr-FR')}`);
  }

  lines.push('');
  lines.push('### Répartition par Moteur IA');
  lines.push('');
  for (const [engine, stats] of Object.entries(engineCounts)) {
    const label = ENGINE_LABELS[engine] ?? engine;
    lines.push(`- **${label}** : ${stats.threads} conversation(s), ${stats.messages} message(s)`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Sommaire des conversations');
  lines.push('');
  threadsWithMessages.forEach(({ thread, messages }, index) => {
    const threadTitle = thread.title || `Conversation ${index + 1}`;
    const engineLabel = ENGINE_LABELS[thread.originEngine] ?? thread.originEngine;
    const dateStr = new Date(thread.createdAt).toLocaleDateString('fr-FR');
    lines.push(`${index + 1}. [${threadTitle}](#thread-${thread.id}) *(${engineLabel} — ${messages.length} msgs — ${dateStr})*`);
  });

  lines.push('');
  lines.push('---');
  lines.push('');

  threadsWithMessages.forEach(({ thread, messages }, index) => {
    const threadTitle = thread.title || `Conversation ${index + 1}`;
    const engineLabel = ENGINE_LABELS[thread.originEngine] ?? thread.originEngine;
    const threadTokens = messages.reduce((acc, m) => acc + (m.estimatedTokens || 0), 0);

    lines.push(`<a id="thread-${thread.id}"></a>`);
    lines.push(`## ${index + 1}. ${threadTitle}`);
    lines.push('');
    lines.push(`- **Moteur** : ${engineLabel}`);
    lines.push(`- **Créé le** : ${new Date(thread.createdAt).toLocaleString('fr-FR')}`);
    lines.push(`- **Dernière mise à jour** : ${new Date(thread.updatedAt).toLocaleString('fr-FR')}`);
    lines.push(`- **Messages** : ${messages.length}`);
    if (threadTokens > 0) {
      lines.push(`- **Tokens estimés** : ~${threadTokens.toLocaleString('fr-FR')}`);
    }
    lines.push('');

    for (const m of messages) {
      const isUser = m.role === 'user';
      const dateStr = new Date(m.timestamp).toLocaleTimeString('fr-FR');
      const author = isUser ? '👤 Utilisateur' : `🤖 Assistant (${ENGINE_LABELS[m.sourceEngine] ?? m.sourceEngine})`;

      lines.push(`### ${author} — ${dateStr}`);
      lines.push('');

      if (m.thought) {
        lines.push('> **🧠 Raisonnement de l\'IA :**');
        for (const thoughtLine of m.thought.split('\n')) {
          lines.push(`> ${thoughtLine}`);
        }
        lines.push('');
      }

      if (m.toolCalls && m.toolCalls.length > 0) {
        lines.push(`*🔧 Appel d'outil (${m.toolCalls.map((c) => c.name).join(', ')})*`);
        lines.push('');
      }

      if (m.content && m.content.trim()) {
        lines.push(m.content.trim());
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    lines.push('');
  });

  lines.push('*Export de projet généré par [Sync Hub](https://github.com/robjo82/sync-hub)*');
  return lines.join('\n');
}

export function formatProjectAsJson(project: Project, threadsWithMessages: ThreadWithMessages[]): string {
  return JSON.stringify(
    {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        canonicalPath: project.canonicalPath,
        category: project.category,
        createdAt: project.createdAt,
        lastActiveAt: project.lastActiveAt,
      },
      stats: {
        totalThreads: threadsWithMessages.length,
        totalMessages: threadsWithMessages.reduce((acc, t) => acc + t.messages.length, 0),
        totalTokens: threadsWithMessages.reduce(
          (acc, t) => acc + t.messages.reduce((mAcc, m) => mAcc + (m.estimatedTokens || 0), 0),
          0
        ),
      },
      threads: threadsWithMessages.map(({ thread, messages }) => ({
        id: thread.id,
        title: thread.title,
        originEngine: thread.originEngine,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          sourceEngine: m.sourceEngine,
          timestamp: m.timestamp,
          content: m.content,
          thought: m.thought,
          toolCalls: m.toolCalls,
          toolResults: m.toolResults,
          model: m.model,
          usage: m.usage,
          estimatedTokens: m.estimatedTokens,
        })),
      })),
    },
    null,
    2
  );
}
