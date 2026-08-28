import type { Db } from './db.js';
import type { PullBatch, PullResult } from '../types.js';

export interface PullClientOptions {
  remoteUrl: string;
  remoteToken: string;
  batchSize?: number;
  requestTimeoutMs?: number;
}

/**
 * Pulls every message the remote hub has that this instance hasn't pulled yet, in ascending
 * ingest_seq order, batched. The local watermark (Db.getRemoteSyncState/setRemoteSyncPullState)
 * only advances after a batch is confirmed applied locally.
 */
export async function runPullCycle(db: Db, opts: PullClientOptions): Promise<PullResult> {
  const batchSize = opts.batchSize ?? 50;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  let cursor = db.getRemoteSyncState(opts.remoteUrl).lastPulledSeq;

  let totalAppliedProjects = 0;
  let totalAppliedThreads = 0;
  let totalAppliedMessages = 0;
  const skipped = { projects: [] as string[], threads: [] as string[], messages: [] as string[] };

  while (true) {
    let response: Response;
    try {
      const url = new URL(`${opts.remoteUrl.replace(/\/$/, '')}/api/sync/pull`);
      url.searchParams.set('afterSeq', String(cursor));
      url.searchParams.set('limit', String(batchSize));

      response = await fetch(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.remoteToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      console.error(`sync-pull: failed to reach remote at ${opts.remoteUrl}, will retry next cycle:`, err);
      break;
    }

    if (!response.ok) {
      console.error(`sync-pull: remote returned HTTP ${response.status}, will retry next cycle`);
      break;
    }

    const batch = (await response.json()) as PullBatch;
    if (!batch || !Array.isArray(batch.messages)) break;

    if (batch.messages.length > 0) {
      const applied = db.applyRemoteBatch({
        projects: batch.projects,
        threads: batch.threads,
        messages: batch.messages,
      });

      totalAppliedProjects += applied.appliedProjects;
      totalAppliedThreads += applied.appliedThreads;
      totalAppliedMessages += applied.appliedMessages;
      skipped.projects.push(...applied.skipped.projects);
      skipped.threads.push(...applied.skipped.threads);
      skipped.messages.push(...applied.skipped.messages);

      cursor = batch.maxSeq;
      db.setRemoteSyncPullState(opts.remoteUrl, cursor, new Date().toISOString());
    }

    if (!batch.hasMore || batch.messages.length === 0) {
      break;
    }
  }

  return {
    ok: true,
    appliedProjects: totalAppliedProjects,
    appliedThreads: totalAppliedThreads,
    appliedMessages: totalAppliedMessages,
    skipped,
    newWatermark: cursor,
  };
}
