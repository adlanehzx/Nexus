import type { LLMProvider } from "./provider.js";
import { textOf } from "./types.js";

export interface BenchmarkCase {
  id: string;
  prompt: string;
  expected: string;
}

export interface BenchmarkResult {
  providerId: string;
  model: string;
  cases: { id: string; passed: boolean; latencyMs: number }[];
  passRate: number;
  totalLatencyMs: number;
}

/** Runs exact, fixed benchmark cases. An injectable monotonic clock makes fixtures reproducible. */
export async function runBenchmark(
  provider: LLMProvider,
  cases: readonly BenchmarkCase[],
  now: () => number = () => performance.now(),
): Promise<BenchmarkResult> {
  if (cases.length === 0) throw new Error("At least one benchmark case is required");
  const results: BenchmarkResult["cases"] = [];
  for (const benchmark of cases) {
    const started = now();
    const response = await provider.generate({
      messages: [{ role: "user", content: [{ type: "text", text: benchmark.prompt }] }],
    });
    const latencyMs = Math.max(0, now() - started);
    results.push({
      id: benchmark.id,
      passed: textOf(response.content).trim() === benchmark.expected,
      latencyMs,
    });
  }
  return {
    providerId: provider.id,
    model: provider.model,
    cases: results,
    passRate: results.filter((result) => result.passed).length / results.length,
    totalLatencyMs: results.reduce((total, result) => total + result.latencyMs, 0),
  };
}
