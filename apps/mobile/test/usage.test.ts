import { describe, expect, it } from "vitest";
import type { LlmEngineConfig, UsageRun } from "../lib/api-types.js";
import { formatTokens, formatUsd, summarizeUsage } from "../lib/usage.js";
import {
  formatDuration,
  formatRelative,
  missionProgress,
  readableJson,
  statusTone,
} from "../lib/format.js";

const usageRun = (over: Partial<UsageRun>): UsageRun => ({
  runId: "r",
  model: "m1",
  startedAt: "2026-11-05T10:00:00.000Z",
  status: "succeeded",
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  ...over,
});

const engine = (model: string, input: number | null, output: number | null) =>
  ({
    id: model,
    label: model,
    kind: "paid-api",
    enabled: true,
    priority: 1,
    model,
    maxContextTokens: 1,
    inputCostPerMillion: input,
    outputCostPerMillion: output,
  }) as LlmEngineConfig;

describe("summarizeUsage", () => {
  it("adds up what was recorded, per model, largest first", () => {
    const summary = summarizeUsage([
      usageRun({ model: "small", inputTokens: 1, outputTokens: 1 }),
      usageRun({ model: "big", cacheReadTokens: 5, cacheWriteTokens: 2 }),
      usageRun({ model: "big", status: "failed" }),
    ]);
    expect(summary.runs).toBe(3);
    expect(summary.byModel.map((model) => model.model)).toEqual(["big", "small"]);
    expect(summary.byModel[0]).toMatchObject({ runs: 2, failedRuns: 1, cacheTokens: 7 });
  });

  it("gives no cost estimate without a declared price", () => {
    const summary = summarizeUsage([usageRun({})], [engine("m1", null, null)]);
    expect(summary.estimatedCostUsd).toBeNull();
    expect(summary.byModel[0]?.estimatedCostUsd).toBeNull();
    expect(summary.unpricedModels).toBe(1);
  });

  it("estimates from declared prices and reports what it excluded", () => {
    const summary = summarizeUsage(
      [usageRun({}), usageRun({ model: "unpriced" })],
      [engine("m1", 3, 15)],
    );
    expect(summary.estimatedCostUsd).toBeCloseTo(3 + 7.5);
    expect(summary.unpricedModels).toBe(1);
  });

  it("is empty, not zero-cost, when nothing ran", () => {
    expect(summarizeUsage([]).estimatedCostUsd).toBeNull();
  });
});

describe("format", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");

  it("formats tokens and dollars", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("formats relative times in both directions", () => {
    expect(formatRelative(null, now)).toBe("never");
    expect(formatRelative("nonsense", now)).toBe("unknown");
    expect(formatRelative("2026-11-05T11:59:50.000Z", now)).toBe("just now");
    expect(formatRelative("2026-11-05T11:00:00.000Z", now)).toBe("1h ago");
    expect(formatRelative("2026-11-05T12:30:00.000Z", now)).toBe("in 30m");
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(2_500)).toBe("2.5 s");
  });

  it("maps core statuses onto badge tones", () => {
    expect(statusTone("ONLINE")).toBe("ok");
    expect(statusTone("running")).toBe("live");
    expect(statusTone("waiting_for_confirmation")).toBe("warn");
    expect(statusTone("quota_exhausted")).toBe("bad");
    expect(statusTone("something-new")).toBe("muted");
  });

  it("derives mission progress from task states", () => {
    expect(missionProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
    expect(
      missionProgress([
        { state: "SUCCEEDED" },
        { state: "running" },
        { state: "failed" },
        { state: "queued" },
      ]),
    ).toEqual({ done: 2, total: 4, percent: 50 });
  });

  it("reads result JSON without ever throwing", () => {
    expect(readableJson(null)).toBeNull();
    expect(readableJson("not json")).toBe("not json");
    expect(readableJson('"plain"')).toBe("plain");
    expect(readableJson('{"response":"Done"}')).toBe("Done");
    expect(readableJson('{"a":1}')).toContain('"a": 1');
  });
});
