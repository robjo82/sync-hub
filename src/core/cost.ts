import type { Db } from './db.js';
import { DEFAULT_EUR_USD_RATE, ENGINE_PROVIDER_MAP, costFromPricing, estimateCostUsd, getProviderForModel, interpolatePricing, usdToEur } from './pricing.js';

/** How a figure was arrived at — measured from published rates, or interpolated between them. */
export type CostTier = 'measured' | 'interpolated';
import type { EngineType } from '../types.js';

export interface ModelCostBreakdown {
  model: string;
  provider: string;
  sourceEngine: string;
  costUsd: number;
  costEur: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cachedTokens: number;
  totalTokens: number;
  messageCount: number;
  percentage: number;
}

export interface EngineCostBreakdown {
  engine: EngineType | string;
  provider: string;
  label: string;
  color: string;
  costUsd: number;
  costEur: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  percentage: number;
}

export interface ProjectCostBreakdown {
  projectId: string;
  projectName: string;
  category: string | null;
  costUsd: number;
  costEur: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  engines: string[];
  percentage: number;
}

export interface DateCostPoint {
  date: string;
  costUsd: number;
  costEur: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  byEngine: Record<string, { costUsd: number; costEur: number; totalTokens: number }>;
  byModel: Record<string, { costUsd: number; costEur: number; totalTokens: number }>;
}

export interface CostScope {
  projectId?: string;
  threadId?: string;
  engine?: string;
  startDate?: string;
  endDate?: string;
  eurRate?: number;
}

export interface CostSummary {
  totalCostUsd: number;
  totalCostEur: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalMessages: number;
  unpricedMessageCount: number;
  /**
   * Split of the headline figure by how it was obtained. totalCostUsd is the sum; these say how
   * much of it is a published rate and how much is interpolated between two known neighbours, so
   * a reader can tell a measured euro from a deduced one.
   */
  measuredCostUsd: number;
  interpolatedCostUsd: number;
  interpolatedMessageCount: number;
  eurRate: number;
  byModel: ModelCostBreakdown[];
  byEngine: EngineCostBreakdown[];
  byProject: ProjectCostBreakdown[];
  byDate: DateCostPoint[];
  scope: CostScope;
}

/**
 * Aggregates real recorded token usage into an estimated USD and EUR cost — see pricing.ts for what
 * "estimated" means here (API-equivalent, not a reconciliation of an actual subscription bill).
 * Provides rich breakdowns by model, project, source engine (Anthropic, OpenAI, Google), and date timeline.
 */
export function computeCostSummary(db: Db, scope: CostScope = {}): CostSummary {
  const eurRate = scope.eurRate && scope.eurRate > 0 ? scope.eurRate : DEFAULT_EUR_USD_RATE;
  const records = db.getUsageRecords(scope);

  const byModelMap = new Map<string, {
    model: string;
    provider: string;
    sourceEngine: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    cachedTokens: number;
    messageCount: number;
  }>();

  const byEngineMap = new Map<string, {
    engine: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    messageCount: number;
  }>();

  const byProjectMap = new Map<string, {
    projectId: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    messageCount: number;
    engines: Set<string>;
  }>();

  const byDateMap = new Map<string, {
    date: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    messageCount: number;
    byEngine: Record<string, { costUsd: number; costEur: number; totalTokens: number }>;
    byModel: Record<string, { costUsd: number; costEur: number; totalTokens: number }>;
  }>();

  let unpriced = 0;
  let interpolatedMessages = 0;
  let interpolatedCostUsd = 0;
  let measuredCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalMessages = 0;

  for (const r of records) {
    const { model, usage, sourceEngine, projectId, timestamp } = r;
    // No model means "don't know which one" (never guessed — see UsageRecord/getUsageRecords) —
    // unpriced by construction, same as estimateCostUsd would say, but narrows `model` to string
    // for the rest of this iteration.
    if (!model) {
      unpriced++;
      continue;
    }
    // Three tiers, kept apart on purpose. A measured cost and a guessed one must never be summed
    // into a single number the reader takes for fact — that is the whole rule this feature had to
    // respect to exist at all.
    let cost = estimateCostUsd(model, usage);
    let tier: CostTier = 'measured';
    if (cost === null) {
      const interpolated = interpolatePricing(model);
      if (interpolated && usage) {
        cost = costFromPricing(interpolated, usage);
        tier = 'interpolated';
        interpolatedMessages++;
      }
    }
    if (cost === null) {
      unpriced++;
      continue;
    }
    if (tier === 'interpolated') interpolatedCostUsd += cost;
    else measuredCostUsd += cost;

    const inputToks = usage.inputTokens || 0;
    const outputToks = usage.outputTokens || 0;
    const cacheWrite5m = usage.cacheCreation5mInputTokens || 0;
    const cacheWrite1h = usage.cacheCreation1hInputTokens || 0;
    const cacheWrite = cacheWrite5m + cacheWrite1h;
    const cacheRead = usage.cacheReadInputTokens || 0;
    const cached = usage.cachedInputTokens || 0;

    totalInputTokens += inputToks;
    totalOutputTokens += outputToks;
    totalCachedTokens += (cacheWrite + cacheRead + cached);
    totalMessages += 1;

    // 1. By Model
    const modelEntry = byModelMap.get(model) ?? {
      model,
      provider: getProviderForModel(model, sourceEngine),
      sourceEngine,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      cachedTokens: 0,
      messageCount: 0,
    };
    modelEntry.costUsd += cost;
    modelEntry.inputTokens += inputToks;
    modelEntry.outputTokens += outputToks;
    modelEntry.cacheWriteTokens += cacheWrite;
    modelEntry.cacheReadTokens += cacheRead;
    modelEntry.cachedTokens += cached;
    modelEntry.messageCount += 1;
    byModelMap.set(model, modelEntry);

    // 2. By Engine
    const engineEntry = byEngineMap.get(sourceEngine) ?? {
      engine: sourceEngine,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
    };
    engineEntry.costUsd += cost;
    engineEntry.inputTokens += inputToks;
    engineEntry.outputTokens += outputToks;
    engineEntry.messageCount += 1;
    byEngineMap.set(sourceEngine, engineEntry);

    // 3. By Project
    const projEntry = byProjectMap.get(projectId) ?? {
      projectId,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
      engines: new Set<string>(),
    };
    projEntry.costUsd += cost;
    projEntry.inputTokens += inputToks;
    projEntry.outputTokens += outputToks;
    projEntry.messageCount += 1;
    projEntry.engines.add(sourceEngine);
    byProjectMap.set(projectId, projEntry);

    // 4. By Date (YYYY-MM-DD)
    const dateStr = timestamp ? timestamp.slice(0, 10) : 'Inconnu';
    const dateEntry = byDateMap.get(dateStr) ?? {
      date: dateStr,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
      byEngine: {},
      byModel: {},
    };
    dateEntry.costUsd += cost;
    dateEntry.inputTokens += inputToks;
    dateEntry.outputTokens += outputToks;
    dateEntry.messageCount += 1;

    const engRec = dateEntry.byEngine[sourceEngine] ?? { costUsd: 0, costEur: 0, totalTokens: 0 };
    engRec.costUsd += cost;
    engRec.costEur += usdToEur(cost, eurRate);
    engRec.totalTokens += (inputToks + outputToks + cacheWrite + cacheRead + cached);
    dateEntry.byEngine[sourceEngine] = engRec;

    const modRec = dateEntry.byModel[model] ?? { costUsd: 0, costEur: 0, totalTokens: 0 };
    modRec.costUsd += cost;
    modRec.costEur += usdToEur(cost, eurRate);
    modRec.totalTokens += (inputToks + outputToks + cacheWrite + cacheRead + cached);
    dateEntry.byModel[model] = modRec;

    byDateMap.set(dateStr, dateEntry);
  }

  const totalCostUsd = [...byModelMap.values()].reduce((sum, m) => sum + m.costUsd, 0);
  const totalCostEur = usdToEur(totalCostUsd, eurRate);
  const totalTokens = totalInputTokens + totalOutputTokens + totalCachedTokens;

  // Build byModel array
  const byModel: ModelCostBreakdown[] = [...byModelMap.values()]
    .map((m) => {
      const totToks = m.inputTokens + m.outputTokens + m.cacheWriteTokens + m.cacheReadTokens + m.cachedTokens;
      return {
        ...m,
        costEur: usdToEur(m.costUsd, eurRate),
        totalTokens: totToks,
        percentage: totalCostUsd > 0 ? (m.costUsd / totalCostUsd) * 100 : 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  // Build byEngine array
  const byEngine: EngineCostBreakdown[] = [...byEngineMap.values()]
    .map((e) => {
      const meta = ENGINE_PROVIDER_MAP[e.engine] ?? { provider: 'Autre', label: e.engine, color: '#94a3b8' };
      const totToks = e.inputTokens + e.outputTokens;
      return {
        engine: e.engine,
        provider: meta.provider,
        label: meta.label,
        color: meta.color,
        costUsd: e.costUsd,
        costEur: usdToEur(e.costUsd, eurRate),
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        totalTokens: totToks,
        messageCount: e.messageCount,
        percentage: totalCostUsd > 0 ? (e.costUsd / totalCostUsd) * 100 : 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  // Build byProject array
  const byProject: ProjectCostBreakdown[] = [...byProjectMap.values()]
    .map((p) => {
      const proj = db.getProject(p.projectId);
      const name = proj?.name ?? (p.projectId === 'unassigned' ? 'Non affecté' : p.projectId);
      const category = proj?.category ?? null;
      const totToks = p.inputTokens + p.outputTokens;
      return {
        projectId: p.projectId,
        projectName: name,
        category,
        costUsd: p.costUsd,
        costEur: usdToEur(p.costUsd, eurRate),
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        totalTokens: totToks,
        messageCount: p.messageCount,
        engines: Array.from(p.engines),
        percentage: totalCostUsd > 0 ? (p.costUsd / totalCostUsd) * 100 : 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  // Build byDate array (sorted chronologically)
  const byDate: DateCostPoint[] = [...byDateMap.values()]
    .filter((d) => d.date !== 'Inconnu')
    .map((d) => ({
      date: d.date,
      costUsd: d.costUsd,
      costEur: usdToEur(d.costUsd, eurRate),
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      totalTokens: d.inputTokens + d.outputTokens,
      messageCount: d.messageCount,
      byEngine: d.byEngine,
      byModel: d.byModel,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalCostUsd,
    totalCostEur,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCachedTokens,
    totalMessages,
    unpricedMessageCount: unpriced,
    measuredCostUsd,
    interpolatedCostUsd,
    interpolatedMessageCount: interpolatedMessages,
    eurRate,
    byModel,
    byEngine,
    byProject,
    byDate,
    scope,
  };
}
