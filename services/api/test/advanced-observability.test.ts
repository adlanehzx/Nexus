import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AdvancedObservability,
  ObservabilityFactStore,
  type RunFact,
} from "../src/services/advanced-observability.js";

let clock: Date;
let path: string;
let service: AdvancedObservability;

beforeEach(async () => {
  clock = new Date("2026-10-25T01:00:00Z");
  path = join(await mkdtemp(join(tmpdir(), "nexus-observability-")), "facts.json");
  service = new AdvancedObservability({
    store: new ObservabilityFactStore(path),
    now: () => clock,
  });
});

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const run = (
  runId: string,
  score: number,
  determinism: RunFact["determinism"] = "DETERMINISTIC",
): RunFact => ({
  runId,
  at: clock.toISOString(),
  providerId: "local",
  modelId: "model-a",
  status: "SUCCEEDED",
  durationMs: runId === "baseline" ? 100 : 140,
  score,
  determinism,
  seed: null,
  inputHash: hash("input"),
  outputHash: hash(runId),
});

describe("advanced observability", () => {
  it("separates official usage from estimates and keeps missing quota unknown", async () => {
    await service.recordUsage({
      providerId: "provider",
      modelId: "a",
      source: "API_EQUIVALENT_ESTIMATE",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01,
      quotaRemaining: 99,
    });
    await service.recordUsage({
      providerId: "provider",
      modelId: "a",
      source: "OFFICIAL",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: null,
      quotaRemaining: null,
    });
    expect(await service.forecast("provider")).toEqual({
      state: "unknown",
      exhaustedAt: null,
      confidence: null,
      reason: "insufficient official quota observations",
    });
    const snapshot = await service.dashboardSnapshot();
    expect(snapshot.usage.map((fact) => fact.source)).toEqual([
      "API_EQUIVALENT_ESTIMATE",
      "OFFICIAL",
    ]);
  });

  it("forecasts exhaustion only from official persisted observations", async () => {
    await service.recordUsage({
      providerId: "provider",
      modelId: "a",
      source: "OFFICIAL",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01,
      quotaRemaining: 100,
    });
    clock = new Date("2026-10-25T02:00:00Z");
    await service.recordUsage({
      providerId: "provider",
      modelId: "a",
      source: "OFFICIAL",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01,
      quotaRemaining: 80,
    });
    expect(await service.forecast("provider")).toMatchObject({
      state: "known",
      exhaustedAt: "2026-10-25T06:00:00.000Z",
      confidence: 0.6,
    });
  });

  it("suppresses duplicate alerts then escalates recurring incidents", async () => {
    expect(await service.emitAlert("provider-down")).toEqual({ emitted: true, level: "INFO" });
    expect(await service.emitAlert("provider-down")).toEqual({ emitted: false, level: "INFO" });
    expect(await service.emitAlert("provider-down")).toEqual({ emitted: true, level: "WARNING" });
    await service.emitAlert("provider-down");
    expect(await service.emitAlert("provider-down")).toEqual({ emitted: true, level: "CRITICAL" });
  });

  it("compares runs, marks nondeterminism and detects regressions", async () => {
    await service.recordRun(run("baseline", 0.9));
    await service.recordRun(run("candidate", 0.7, "NONDETERMINISTIC"));
    const regression = await service.detectRegression("baseline", "candidate");
    expect(regression).toMatchObject({
      regression: true,
      durationDeltaMs: 40,
      outputChanged: true,
      exactlyReplayable: false,
    });
    expect(regression.scoreDelta).toBeCloseTo(-0.2);
  });

  it("runs persisted nightly evaluations after restart", async () => {
    const evaluation = await service.scheduleNightly("safety", clock);
    const restarted = new AdvancedObservability({
      store: new ObservabilityFactStore(path),
      now: () => clock,
    });
    const completed = await restarted.runDueEvaluations(() => Promise.resolve(0.95));
    expect(completed[0]).toMatchObject({
      id: evaluation.id,
      lastScore: 0.95,
      nextRunAt: "2026-10-26T01:00:00.000Z",
    });
  });

  it("persists a content-free agent graph and safely pauses, inspects and resumes a DAG", async () => {
    await service.recordAgentMessage({
      at: clock.toISOString(),
      fromAgentId: "planner",
      toAgentId: "reviewer",
      kind: "REVIEW",
      bytes: 81,
    });
    await service.registerDag({
      runId: "run-1",
      status: "RUNNING",
      nodes: [
        { id: "plan", dependencies: [], status: "SUCCEEDED" },
        { id: "review", dependencies: ["plan"], status: "RUNNING" },
      ],
    });
    expect((await service.setDagPaused("run-1", true)).status).toBe("PAUSED");
    const restarted = new AdvancedObservability({
      store: new ObservabilityFactStore(path),
      now: () => clock,
    });
    expect((await restarted.dashboardSnapshot()).communicationGraph.nodes).toEqual([
      "planner",
      "reviewer",
    ]);
    expect((await restarted.setDagPaused("run-1", false)).status).toBe("RUNNING");
  });

  it("has no schema path for prompts, transcripts, reasoning or credentials", async () => {
    await service.recordRun(run("baseline", 0.9));
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toMatch(/prompt|transcript|reasoning|credential|secret/i);
    await expect(
      service.recordRun({ ...run("invalid", 0.9), prompt: "private" } as RunFact),
    ).rejects.toThrow();
  });
});
