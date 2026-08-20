import type { Db } from './db.js';
import { estimateCostUsd } from './pricing.js';

export interface ModelCostBreakdown {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

export interface CostSummary {
  totalCostUsd: number;
  /** Messages with a real recorded model + usage but no entry in the pricing table — never folded into totalCostUsd as if they were free. */
  unpricedMessageCount: number;
  byModel: ModelCostBreakdown[];
}

/**
 * Aggregates real recorded token usage into an estimated USD cost — see pricing.ts for what
 * "estimated" means here (API-equivalent, not a reconciliation of an actual subscription bill).
 * Pass a project or thread id to scope the aggregation; omit both for the whole store.
 */
export function computeCostSummary(db: Db, scope: { projectId?: string; threadId?: string } = {}): CostSummary {
  const records = db.getUsageRecords(scope);
  const byModel = new Map<string, ModelCostBreakdown>();
  let unpriced = 0;

  for (const { model, usage } of records) {
    const cost = estimateCostUsd(model, usage);
    if (cost === null) {
      unpriced++;
      continue;
    }
    const entry = byModel.get(model) ?? { model, costUsd: 0, inputTokens: 0, outputTokens: 0, messageCount: 0 };
    entry.costUsd += cost;
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    entry.messageCount += 1;
    byModel.set(model, entry);
  }

  const breakdown = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
  return {
    totalCostUsd: breakdown.reduce((sum, b) => sum + b.costUsd, 0),
    unpricedMessageCount: unpriced,
    byModel: breakdown,
  };
}
