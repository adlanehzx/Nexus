import { describe, expect, it } from "vitest";
import { NexusTelemetry } from "../src/services/domain-telemetry.js";
import type { AgentRunView } from "../src/services/observability.js";

function run(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: "run-1",
    userId: "user-1",
    conversationId: "conversation-1",
    correlationId: "correlation-1",
    missionExternalKey: "mission-1",
    replayOfRunId: null,
    status: "completed",
    stopReason: "final_answer",
    startedAt: "2026-10-21T10:00:00.000Z",
    endedAt: "2026-10-21T10:00:02.000Z",
    durationMs: 2_000,
    iterations: 1,
    response: "Terminé.",
    tools: [],
    errors: [],
    metrics: {
      model: "model-a",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      fallbackCount: 0,
    },
    ...overrides,
  };
}

describe("NexusTelemetry", () => {
  it("agrège coûts configurés, latence p95, erreurs et fallbacks explicites", () => {
    const telemetry = new NexusTelemetry({
      pricing: {
        "model-a": {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 2,
          cacheReadPerMillionUsd: 0,
          cacheWritePerMillionUsd: 0,
        },
      },
    });

    const summary = telemetry.summarize([
      run(),
      run({
        runId: "run-2",
        status: "failed",
        durationMs: 6_000,
        metrics: {
          ...run().metrics,
          toolCalls: 2,
          failedToolCalls: 1,
          fallbackCount: 1,
        },
      }),
    ]);

    expect(summary.totals).toMatchObject({
      runs: 2,
      failedRuns: 1,
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      estimatedApiEquivalentCostUsd: 4,
    });
    expect(summary.rates).toEqual({ fallback: 0.5, toolError: 0.5, runError: 0.5 });
    expect(summary.agents[0]).toMatchObject({ averageLatencyMs: 4_000, p95LatencyMs: 6_000 });
    expect(summary.missions[0]).toMatchObject({ mission: "mission-1", runs: 2 });
  });

  it("n'invente aucun coût lorsqu'aucun tarif n'est configuré", () => {
    const summary = new NexusTelemetry().summarize([run()]);

    expect(summary.totals.estimatedApiEquivalentCostUsd).toBeNull();
    expect(summary.agents[0]?.estimatedApiEquivalentCostUsd).toBeNull();
  });

  it("ne confond pas plusieurs tours de modèle avec un fallback", () => {
    const summary = new NexusTelemetry().summarize([run({ iterations: 4 })]);

    expect(summary.rates.fallback).toBe(0);
  });
});
