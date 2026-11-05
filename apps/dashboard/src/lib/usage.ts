import type { UsageBucketDto } from "./api.js";

export type UsageGranularity = "day" | "week" | "month";

export interface UsageTotals {
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Null as soon as one counted model has no known price: a partial sum would mislead. */
  estimatedApiCostUsd: number | null;
}

const EMPTY: UsageTotals = {
  runs: 0,
  failedRuns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  estimatedApiCostUsd: 0,
};

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : a + b;
}

function add(total: UsageTotals, bucket: UsageBucketDto): UsageTotals {
  return {
    runs: total.runs + bucket.runs,
    failedRuns: total.failedRuns + bucket.failedRuns,
    inputTokens: total.inputTokens + bucket.inputTokens,
    outputTokens: total.outputTokens + bucket.outputTokens,
    cacheReadTokens: addNullable(total.cacheReadTokens, bucket.cacheReadTokens),
    cacheWriteTokens: addNullable(total.cacheWriteTokens, bucket.cacheWriteTokens),
    estimatedApiCostUsd:
      total.estimatedApiCostUsd === null || bucket.estimatedApiCostUsd === null
        ? null
        : total.estimatedApiCostUsd + bucket.estimatedApiCostUsd,
  };
}

export function usageTotals(buckets: readonly UsageBucketDto[]): UsageTotals {
  return buckets.reduce(add, EMPTY);
}

/** Period containing a UTC day: itself, its ISO week's Monday, or its month. */
export function usagePeriod(day: string, granularity: UsageGranularity): string {
  if (granularity === "day") return day;
  if (granularity === "month") return day.slice(0, 7);
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function groupUsage(
  buckets: readonly UsageBucketDto[],
  keyOf: (bucket: UsageBucketDto) => string,
): { key: string; totals: UsageTotals }[] {
  const groups = new Map<string, UsageTotals>();
  for (const bucket of buckets) {
    const key = keyOf(bucket);
    groups.set(key, add(groups.get(key) ?? EMPTY, bucket));
  }
  return [...groups].map(([key, totals]) => ({ key, totals }));
}

/** Neutralizes spreadsheet formulas: a model name is external text. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  const safe = typeof value === "string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function usageCsv(buckets: readonly UsageBucketDto[]): string {
  const columns = [
    "day",
    "model",
    "runs",
    "failedRuns",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "estimatedApiCostUsd",
  ] as const;
  const rows = buckets.map((bucket) => columns.map((column) => csvCell(bucket[column])).join(","));
  return [columns.join(","), ...rows].join("\r\n");
}
