import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const usageFactSchema = z.strictObject({
  id: z.string(),
  at: z.string().datetime(),
  providerId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(128),
  source: z.enum(["OFFICIAL", "API_EQUIVALENT_ESTIMATE"]),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  quotaRemaining: z.number().nonnegative().nullable(),
});
export type UsageFact = z.infer<typeof usageFactSchema>;

const runFactSchema = z.strictObject({
  runId: z.string().min(1),
  at: z.string().datetime(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
  durationMs: z.number().int().nonnegative(),
  score: z.number().min(0).max(1).nullable(),
  determinism: z.enum(["DETERMINISTIC", "SEEDED", "NONDETERMINISTIC"]),
  seed: z.number().int().nullable(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type RunFact = z.infer<typeof runFactSchema>;

const evaluationSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128),
  nextRunAt: z.string().datetime(),
  lastRunAt: z.string().datetime().nullable(),
  lastScore: z.number().min(0).max(1).nullable(),
  enabled: z.boolean(),
});
export type ScheduledEvaluation = z.infer<typeof evaluationSchema>;

const alertSchema = z.object({
  fingerprint: z.string().min(1),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  occurrences: z.number().int().positive(),
  level: z.enum(["INFO", "WARNING", "CRITICAL"]),
});

const messageEdgeSchema = z.object({
  at: z.string().datetime(),
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  kind: z.enum(["REQUEST", "RESPONSE", "REVIEW", "ARBITRATION"]),
  bytes: z.number().int().nonnegative(),
});

const dagSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["RUNNING", "PAUSED", "COMPLETED"]),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      dependencies: z.array(z.string()),
      status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]),
    }),
  ),
});
export type DebugDag = z.infer<typeof dagSchema>;

const stateSchema = z.object({
  usage: z.array(usageFactSchema),
  runs: z.array(runFactSchema),
  evaluations: z.array(evaluationSchema),
  alerts: z.array(alertSchema),
  messages: z.array(messageEdgeSchema),
  dags: z.array(dagSchema),
});
type ObservabilityState = z.infer<typeof stateSchema>;

const emptyState = (): ObservabilityState => ({
  usage: [],
  runs: [],
  evaluations: [],
  alerts: [],
  messages: [],
  dags: [],
});

/** Atomic fact store. Its strict schema intentionally has no prompt, transcript, reasoning, or secret field. */
export class ObservabilityFactStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<ObservabilityState> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async update(mutator: (state: ObservabilityState) => void): Promise<ObservabilityState> {
    const state = await this.read();
    mutator(state);
    const validated = stateSchema.parse(state);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(validated), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#path);
    return validated;
  }
}

export interface ConsumptionForecast {
  state: "known" | "unknown";
  exhaustedAt: string | null;
  confidence: number | null;
  reason: string | null;
}

export class AdvancedObservability {
  readonly #store: ObservabilityFactStore;
  readonly #now: () => Date;

  constructor(options: { store: ObservabilityFactStore; now?: () => Date }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  async recordUsage(input: Omit<UsageFact, "id" | "at">): Promise<UsageFact> {
    const fact = usageFactSchema.parse({
      ...input,
      id: randomUUID(),
      at: this.#now().toISOString(),
    });
    await this.#store.update((state) => void state.usage.push(fact));
    return fact;
  }

  async forecast(providerId: string): Promise<ConsumptionForecast> {
    const facts = (await this.#store.read()).usage
      .filter((fact) => fact.providerId === providerId && fact.source === "OFFICIAL")
      .sort((left, right) => left.at.localeCompare(right.at));
    if (facts.some((fact) => fact.quotaRemaining === null) || facts.length < 2) {
      return {
        state: "unknown",
        exhaustedAt: null,
        confidence: null,
        reason: "insufficient official quota observations",
      };
    }
    const first = facts[0]!;
    const last = facts.at(-1)!;
    const elapsedMs = new Date(last.at).getTime() - new Date(first.at).getTime();
    const consumed = first.quotaRemaining! - last.quotaRemaining!;
    if (elapsedMs <= 0 || consumed <= 0) {
      return {
        state: "unknown",
        exhaustedAt: null,
        confidence: null,
        reason: "no measurable consumption rate",
      };
    }
    const exhaustedAt = new Date(
      new Date(last.at).getTime() + (last.quotaRemaining! / consumed) * elapsedMs,
    );
    return {
      state: "known",
      exhaustedAt: exhaustedAt.toISOString(),
      confidence: Math.min(0.95, 0.5 + facts.length / 20),
      reason: null,
    };
  }

  async emitAlert(
    fingerprint: string,
    windowMs = 300_000,
  ): Promise<{ emitted: boolean; level: "INFO" | "WARNING" | "CRITICAL" }> {
    let emitted = true;
    let level: "INFO" | "WARNING" | "CRITICAL" = "INFO";
    await this.#store.update((state) => {
      const existing = state.alerts.find((alert) => alert.fingerprint === fingerprint);
      const now = this.#now();
      if (existing === undefined) {
        state.alerts.push({
          fingerprint,
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          occurrences: 1,
          level,
        });
        return;
      }
      existing.occurrences += 1;
      emitted = now.getTime() - new Date(existing.lastSeenAt).getTime() >= windowMs;
      existing.lastSeenAt = now.toISOString();
      existing.level =
        existing.occurrences >= 5 ? "CRITICAL" : existing.occurrences >= 3 ? "WARNING" : "INFO";
      level = existing.level;
      if (existing.level !== "INFO") emitted = true;
    });
    return { emitted, level };
  }

  async recordRun(fact: RunFact): Promise<void> {
    const validated = runFactSchema.parse(fact);
    if (validated.determinism === "SEEDED" && validated.seed === null)
      throw new Error("Seeded runs require a seed");
    await this.#store.update((state) => void state.runs.push(validated));
  }

  async compareRuns(leftId: string, rightId: string) {
    const runs = (await this.#store.read()).runs;
    const left = runs.find((run) => run.runId === leftId);
    const right = runs.find((run) => run.runId === rightId);
    if (left === undefined || right === undefined) throw new Error("Run facts are unavailable");
    return {
      left,
      right,
      durationDeltaMs: right.durationMs - left.durationMs,
      scoreDelta: left.score === null || right.score === null ? null : right.score - left.score,
      outputChanged: left.outputHash !== right.outputHash,
      exactlyReplayable:
        left.determinism !== "NONDETERMINISTIC" && right.determinism !== "NONDETERMINISTIC",
    };
  }

  async detectRegression(baselineId: string, candidateId: string, threshold = 0.05) {
    const comparison = await this.compareRuns(baselineId, candidateId);
    return {
      regression: comparison.scoreDelta !== null && comparison.scoreDelta < -threshold,
      ...comparison,
    };
  }

  async scheduleNightly(name: string, firstRunAt: Date): Promise<ScheduledEvaluation> {
    const evaluation = evaluationSchema.parse({
      id: randomUUID(),
      name,
      nextRunAt: firstRunAt.toISOString(),
      lastRunAt: null,
      lastScore: null,
      enabled: true,
    });
    await this.#store.update((state) => void state.evaluations.push(evaluation));
    return evaluation;
  }

  async runDueEvaluations(
    evaluate: (evaluation: ScheduledEvaluation) => Promise<number>,
  ): Promise<ScheduledEvaluation[]> {
    const state = await this.#store.read();
    const due = state.evaluations.filter(
      (item) => item.enabled && new Date(item.nextRunAt) <= this.#now(),
    );
    const completed: ScheduledEvaluation[] = [];
    for (const item of due) {
      const score = await evaluate(item);
      await this.#store.update((latest) => {
        const stored = latest.evaluations.find((candidate) => candidate.id === item.id)!;
        stored.lastRunAt = this.#now().toISOString();
        stored.lastScore = score;
        stored.nextRunAt = new Date(this.#now().getTime() + 86_400_000).toISOString();
        completed.push({ ...stored });
      });
    }
    return completed;
  }

  async recordAgentMessage(edge: z.input<typeof messageEdgeSchema>): Promise<void> {
    const validated = messageEdgeSchema.parse(edge);
    await this.#store.update((state) => void state.messages.push(validated));
  }

  async registerDag(dag: DebugDag): Promise<void> {
    const validated = dagSchema.parse(dag);
    const ids = new Set(validated.nodes.map((node) => node.id));
    if (
      validated.nodes.some((node) => node.dependencies.some((dependency) => !ids.has(dependency)))
    )
      throw new Error("DAG dependency is unavailable");
    await this.#store.update((state) => void state.dags.push(validated));
  }

  async setDagPaused(runId: string, paused: boolean): Promise<DebugDag> {
    let result: DebugDag | undefined;
    await this.#store.update((state) => {
      const dag = state.dags.find((item) => item.runId === runId);
      if (dag === undefined || dag.status === "COMPLETED")
        throw new Error("Running DAG is unavailable");
      dag.status = paused ? "PAUSED" : "RUNNING";
      result = structuredClone(dag);
    });
    return result!;
  }

  async dashboardSnapshot() {
    const state = await this.#store.read();
    return {
      usage: state.usage,
      runs: state.runs,
      evaluations: state.evaluations,
      alerts: state.alerts,
      communicationGraph: {
        nodes: [...new Set(state.messages.flatMap((edge) => [edge.fromAgentId, edge.toAgentId]))],
        edges: state.messages,
      },
      dags: state.dags,
    };
  }
}
