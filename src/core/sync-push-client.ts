import type { Db } from './db.js';
import type { PushBatch, PushResult } from '../types.js';

export interface PushClientOptions {
  remoteUrl: string;
  remoteToken: string;
  /** Messages per POST — kept well under the server's raised bodyLimit (see app.ts) since verbatim
   * message content (tool outputs, diffs) varies wildly in size. 50 rather than something larger
   * because the remote indexes every message into FTS as it applies the batch: on a small VPS a
   * 200-message batch took long enough to blow Node's default fetch headers timeout, which stalls
   * the whole sync. Smaller batches mean more round trips but ones that actually finish. */
  batchSize?: number;
  /** Bounds a single POST. Without it a slow remote hangs on undici's default headers timeout and
   * the failure surfaces as an opaque UND_ERR_HEADERS_TIMEOUT minutes later. */
  requestTimeoutMs?: number;
}

/**
 * Pushes every message this instance hasn't pushed to `opts.remoteUrl` yet, in ascending
 * ingest_seq order, batched. The local watermark (Db.getRemoteSyncState/setRemoteSyncState) only
 * advances after a batch is confirmed applied — a network error or a non-2xx response leaves it
 * untouched, so the next cycle retries from the same point; re-pushing an already-applied batch is
 * always safe (the remote's own hash-based dedup, the same mechanism this store uses for its own
 * local ingestion, makes a duplicate push a no-op rather than a duplicate row).
 *
 * Push-only for now (see the brick-1 plan): this never reads anything back from the remote.
 */
export async function runPushCycle(db: Db, opts: PushClientOptions): Promise<void> {
  const batchSize = opts.batchSize ?? 50;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  let cursor = db.getRemoteSyncState(opts.remoteUrl).lastPushedSeq;

  while (true) {
    const { messages, maxSeq } = db.getMessagesAfterSeq(cursor, batchSize);
    if (messages.length === 0) break;

    // Projects are sent in full each batch (small, and upsertProject is a cheap idempotent
    // upsert) rather than tracked incrementally — simpler, and avoids a second watermark to keep
    // in sync with the message one. Threads are scoped to exactly what this batch's messages
    // reference, not sent in full (a real store can have thousands).
    const threadIds = [...new Set(messages.map((m) => m.threadId))];
    const batch: PushBatch = { projects: db.getProjects(), threads: db.getThreadsByIds(threadIds), messages };

    let response: Response;
    try {
      response = await fetch(`${opts.remoteUrl}/api/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.remoteToken}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      console.error(
        `sync-push: batch of ${messages.length} after seq ${cursor} failed to reach the remote, will retry next cycle:`,
        err,
      );
      return;
    }
    if (!response.ok) {
      console.error(`sync-push: remote rejected batch (HTTP ${response.status}), will retry next cycle`);
      return;
    }

    const result = (await response.json()) as PushResult;
    if (result.skipped.projects.length || result.skipped.threads.length || result.skipped.messages.length) {
      console.error('sync-push: remote skipped some rows in this batch:', result.skipped);
    }
    cursor = maxSeq;
    db.setRemoteSyncState(opts.remoteUrl, cursor, new Date().toISOString());
  }
}
