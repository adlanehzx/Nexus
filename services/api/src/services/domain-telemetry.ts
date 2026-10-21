import { metrics } from "@opentelemetry/api";
import type { AgentState, AgentRunStore } from "@nexus/agent-core";
import type { AgentRunView } from "./observability.js";

export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number;
  cacheWritePerMillionUsd: number;
}

export interface ObservabilitySummary {
  generatedAt: string;
  totals: {
    runs: number;
    failedRuns: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    failedToolCalls: number;
    estimatedApiEquivalentCostUsd: number | null;
  };
  rates: { fallback: number; toolError: number; runError: number };
  agents: {
    agent: string;
    runs: number;
    failures: number;
    averageLatencyMs: number;
    p95LatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedApiEquivalentCostUsd: number | null;
  }[];
  missions: {
    mission: string;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedApiEquivalentCostUsd: number | null;
  }[];
}

const meter = metrics.getMeter("nexus.domain");
const runsCounter = meter.createCounter("nexus_agent_runs", { description: "Runs agent terminés" });
const tokensCounter = meter.createCounter("nexus_agent_tokens", {
  description: "Jetons par agent",
});
const costCounter = meter.createCounter("nexus_agent_api_equivalent_cost_usd", {
  description: "Coût API équivalent configuré ; ce n'est pas une facture fournisseur",
  unit: "USD",
});
const runLatency = meter.createHistogram("nexus_agent_run_duration_seconds", { unit: "s" });
const toolsCounter = meter.createCounter("nexus_tool_calls", { description: "Appels d'outils" });
const fallbackCounter = meter.createCounter("nexus_agent_fallbacks", {
  description: "Runs ayant nécessité plus d'une tentative",
});

export class NexusTelemetry {
  readonly #pricing: Readonly<Record<string, ModelPricing>>;
  readonly #observed = new Set<string>();

  constructor(options: { pricing?: Readonly<Record<string, ModelPricing>> } = {}) {
    this.#pricing = options.pricing ?? {};
  }

  observeRun(state: AgentState): void {
    const record = state.record;
    if (record.endTime === null || this.#observed.has(record.runId)) return;
    this.#observed.add(record.runId);

    const common = { agent: record.model, status: record.status };
    runsCounter.add(1, common);
    tokensCounter.add(record.usage.inputTokens, { ...common, direction: "input" });
    tokensCounter.add(record.usage.outputTokens, { ...common, direction: "output" });
    const duration = new Date(record.endTime).getTime() - new Date(record.startTime).getTime();
    runLatency.record(Math.max(0, duration) / 1_000, common);
    for (const tool of record.toolsUsed) {
      toolsCounter.add(1, {
        tool: tool.name,
        status: tool.status,
        agent: record.model,
      });
    }
    if ((record.fallbackCount ?? 0) > 0) {
      fallbackCounter.add(record.fallbackCount ?? 0, common);
    }
    const cost = this.estimate(record.model, record.usage);
    if (cost !== null) costCounter.add(cost, { agent: record.model });
  }

  estimate(
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  ): number | null {
    const price = this.#pricing[model];
    if (price === undefined) return null;
    return roundUsd(
      (usage.inputTokens * price.inputPerMillionUsd +
        usage.outputTokens * price.outputPerMillionUsd +
        (usage.cacheReadTokens ?? 0) * price.cacheReadPerMillionUsd +
        (usage.cacheWriteTokens ?? 0) * price.cacheWritePerMillionUsd) /
        1_000_000,
    );
  }

  summarize(runs: readonly AgentRunView[]): ObservabilitySummary {
    const byAgent = new Map<string, AgentRunView[]>();
    const byMission = new Map<string, AgentRunView[]>();
    for (const run of runs) {
      const agentRuns = byAgent.get(run.metrics.model) ?? [];
      agentRuns.push(run);
      byAgent.set(run.metrics.model, agentRuns);
      if (run.missionExternalKey !== null) {
        const missionRuns = byMission.get(run.missionExternalKey) ?? [];
        missionRuns.push(run);
        byMission.set(run.missionExternalKey, missionRuns);
      }
    }

    const totalTools = sum(runs, (run) => run.metrics.toolCalls);
    const failedTools = sum(runs, (run) => run.metrics.failedToolCalls);
    const totalCost = aggregateKnownCosts(runs, (run) => this.#costOfView(run));
    const runsWithFallback = runs.filter((run) => run.metrics.fallbackCount > 0).length;

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        runs: runs.length,
        failedRuns: runs.filter((run) => run.status === "failed").length,
        inputTokens: sum(runs, (run) => run.metrics.inputTokens),
        outputTokens: sum(runs, (run) => run.metrics.outputTokens),
        toolCalls: totalTools,
        failedToolCalls: failedTools,
        estimatedApiEquivalentCostUsd: totalCost,
      },
      rates: {
        fallback: ratio(runsWithFallback, runs.length),
        toolError: ratio(failedTools, totalTools),
        runError: ratio(runs.filter((run) => run.status === "failed").length, runs.length),
      },
      agents: [...byAgent.entries()]
        .map(([agent, values]) => {
          const latencies = values
            .map((run) => run.durationMs)
            .filter((value): value is number => value !== null)
            .sort((a, b) => a - b);
          return {
            agent,
            runs: values.length,
            failures: values.filter((run) => run.status === "failed").length,
            averageLatencyMs:
              latencies.length === 0
                ? 0
                : Math.round(
                    latencies.reduce((total, value) => total + value, 0) / latencies.length,
                  ),
            p95LatencyMs: percentile(latencies, 0.95),
            inputTokens: sum(values, (run) => run.metrics.inputTokens),
            outputTokens: sum(values, (run) => run.metrics.outputTokens),
            estimatedApiEquivalentCostUsd: aggregateKnownCosts(values, (run) =>
              this.#costOfView(run),
            ),
          };
        })
        .sort((left, right) => right.runs - left.runs),
      missions: [...byMission.entries()]
        .map(([mission, values]) => ({
          mission,
          runs: values.length,
          inputTokens: sum(values, (run) => run.metrics.inputTokens),
          outputTokens: sum(values, (run) => run.metrics.outputTokens),
          estimatedApiEquivalentCostUsd: aggregateKnownCosts(values, (run) =>
            this.#costOfView(run),
          ),
        }))
        .sort((left, right) => right.runs - left.runs),
    };
  }

  #costOfView(run: AgentRunView): number | null {
    return this.estimate(run.metrics.model, run.metrics);
  }
}

interface ListableAgentRunStore extends AgentRunStore {
  listAll(): Promise<AgentState[]>;
}

export class ObservableAgentRunStore implements ListableAgentRunStore {
  readonly #delegate: ListableAgentRunStore;
  readonly #telemetry: NexusTelemetry;

  constructor(delegate: ListableAgentRunStore, telemetry: NexusTelemetry) {
    this.#delegate = delegate;
    this.#telemetry = telemetry;
  }

  async save(state: AgentState): Promise<void> {
    await this.#delegate.save(state);
    this.#telemetry.observeRun(state);
  }

  load(runId: string): Promise<AgentState | undefined> {
    return this.#delegate.load(runId);
  }

  require(runId: string): Promise<AgentState> {
    return this.#delegate.require(runId);
  }

  listByStatus(status: AgentState["record"]["status"]): Promise<AgentState[]> {
    return this.#delegate.listByStatus(status);
  }

  listAll(): Promise<AgentState[]> {
    return this.#delegate.listAll();
  }
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 10_000) / 10_000;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function aggregateKnownCosts<T>(
  values: readonly T[],
  cost: (value: T) => number | null,
): number | null {
  let total = 0;
  let known = false;
  for (const value of values) {
    const amount = cost(value);
    if (amount === null) continue;
    total += amount;
    known = true;
  }
  return known ? roundUsd(total) : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
