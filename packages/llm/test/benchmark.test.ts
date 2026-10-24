import { describe, expect, it } from "vitest";
import { runBenchmark } from "../src/benchmark.js";
import { ScriptedLLMProvider } from "../src/testing/scripted.js";

describe("reproducible engine benchmark", () => {
  it("produces identical quality and latency evidence with a fixed clock", async () => {
    const provider = new ScriptedLLMProvider(
      [
        { kind: "final", text: "one" },
        { kind: "final", text: "two" },
      ],
      { model: "fixture-model" },
    );
    const ticks = [10, 15, 20, 27];
    const result = await runBenchmark(
      provider,
      [
        { id: "one", prompt: "one", expected: "one" },
        { id: "two", prompt: "two", expected: "two" },
      ],
      () => ticks.shift() ?? 0,
    );

    expect(result).toEqual({
      providerId: "scripted",
      model: "fixture-model",
      cases: [
        { id: "one", passed: true, latencyMs: 5 },
        { id: "two", passed: true, latencyMs: 7 },
      ],
      passRate: 1,
      totalLatencyMs: 12,
    });
  });
});
