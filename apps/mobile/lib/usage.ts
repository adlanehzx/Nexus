import type { LlmEngineConfig, UsageRun } from "./api-types.js";

/**
 * Usage aggregation.
 *
 * Counts only what the core recorded. The one derived figure is the estimated
 * cost, and it is computed strictly from prices the administrator declared on
 * an engine: a model with no declared price stays unpriced instead of being
 * guessed, and the total says how much of the volume it covers.
 */

export interface ModelUsage {
  model: string;
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  /** `null` when no engine declares a price for this model. */
  estimatedCostUsd: number | null;
}

export interface UsageSummary {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  byModel: ModelUsage[];
  /** Sum over priced models; `null` when none is priced. */
  estimatedCostUsd: number | null;
  /** Number of models excluded from the estimate for lack of a declared price. */
  unpricedModels: number;
}

const FAILED_STATUSES = new Set(["failed", "error", "FAILED"]);

export function summarizeUsage(
  runs: readonly UsageRun[],
  engines: readonly LlmEngineConfig[] = [],
): UsageSummary {
  const byModel = new Map<string, ModelUsage>();

  for (const run of runs) {
    const entry = byModel.get(run.model) ?? {
      model: run.model,
      runs: 0,
      failedRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      estimatedCostUsd: null,
    };
    entry.runs += 1;
    if (FAILED_STATUSES.has(run.status)) entry.failedRuns += 1;
    entry.inputTokens += run.inputTokens;
    entry.outputTokens += run.outputTokens;
    entry.cacheTokens += (run.cacheReadTokens ?? 0) + (run.cacheWriteTokens ?? 0);
    byModel.set(run.model, entry);
  }

  const models = [...byModel.values()]
    .map((entry) => ({ ...entry, estimatedCostUsd: estimateCost(entry, engines) }))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  const priced = models.filter((entry) => entry.estimatedCostUsd !== null);

  return {
    runs: runs.length,
    inputTokens: sum(models, (entry) => entry.inputTokens),
    outputTokens: sum(models, (entry) => entry.outputTokens),
    cacheTokens: sum(models, (entry) => entry.cacheTokens),
    byModel: models,
    estimatedCostUsd:
      priced.length === 0 ? null : sum(priced, (entry) => entry.estimatedCostUsd ?? 0),
    unpricedModels: models.length - priced.length,
  };
}

function estimateCost(entry: ModelUsage, engines: readonly LlmEngineConfig[]): number | null {
  const engine = engines.find(
    (candidate) =>
      candidate.model === entry.model &&
      typeof candidate.inputCostPerMillion === "number" &&
      typeof candidate.outputCostPerMillion === "number",
  );
  if (engine === undefined) return null;
  return (
    (entry.inputTokens * (engine.inputCostPerMillion ?? 0) +
      entry.outputTokens * (engine.outputCostPerMillion ?? 0)) /
    1_000_000
  );
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatUsd(amount: number): string {
  return `$${amount < 1 ? amount.toFixed(4) : amount.toFixed(2)}`;
}
