import { NotFoundError } from "@nexus/shared";
import type { AgentState } from "./state.js";

/**
 * Agent run persistence port.
 */
export interface AgentRunStore {
  save(state: AgentState): Promise<void>;
  load(runId: string): Promise<AgentState | undefined>;
  require(runId: string): Promise<AgentState>;
  listByStatus(status: AgentState["record"]["status"]): Promise<AgentState[]>;
}

/** One day and model of a user's observed token counters. Null means never reported. */
export interface RunUsageBucket {
  day: string;
  model: string;
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export class InMemoryAgentRunStore implements AgentRunStore {
  readonly #states = new Map<string, AgentState>();

  save(state: AgentState): Promise<void> {
    this.#states.set(state.record.runId, structuredClone(state));
    return Promise.resolve();
  }

  load(runId: string): Promise<AgentState | undefined> {
    const state = this.#states.get(runId);
    return Promise.resolve(state === undefined ? undefined : structuredClone(state));
  }

  async require(runId: string): Promise<AgentState> {
    const state = await this.load(runId);
    if (state === undefined) {
      throw new NotFoundError({
        message: `Run not found: ${runId}`,
        userMessage: "This task no longer exists.",
        context: { runId },
      });
    }
    return state;
  }

  listByStatus(status: AgentState["record"]["status"]): Promise<AgentState[]> {
    return Promise.resolve(
      [...this.#states.values()]
        .filter((state) => state.record.status === status)
        .map((state) => structuredClone(state)),
    );
  }

  /**
   * Lists all stored runs (used for diagnostics and supervision).
   */
  listAll(): Promise<AgentState[]> {
    return Promise.resolve([...this.#states.values()].map((state) => structuredClone(state)));
  }

  async listForUser(
    userId: string,
    since: Date,
    offset: number,
    limit: number,
  ): Promise<AgentState[]> {
    return (await this.listAll())
      .filter(
        ({ record }) => record.userId === userId && Date.parse(record.startTime) >= since.getTime(),
      )
      .sort(
        (a, b) =>
          b.record.startTime.localeCompare(a.record.startTime) ||
          b.record.runId.localeCompare(a.record.runId),
      )
      .slice(offset, offset + limit);
  }

  async summarizeForUser(userId: string, since: Date): Promise<RunUsageBucket[]> {
    const buckets = new Map<string, RunUsageBucket>();
    for (const { record } of await this.listAll()) {
      if (record.userId !== userId || Date.parse(record.startTime) < since.getTime()) continue;
      const day = record.startTime.slice(0, 10);
      const key = `${day}\u0000${record.model}`;
      const bucket = buckets.get(key) ?? {
        day,
        model: record.model,
        runs: 0,
        failedRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      };
      bucket.runs += 1;
      if (record.status === "failed") bucket.failedRuns += 1;
      bucket.inputTokens += record.usage.inputTokens;
      bucket.outputTokens += record.usage.outputTokens;
      const { cacheReadTokens: read, cacheWriteTokens: write } = record.usage;
      if (read !== undefined) bucket.cacheReadTokens = (bucket.cacheReadTokens ?? 0) + read;
      if (write !== undefined) bucket.cacheWriteTokens = (bucket.cacheWriteTokens ?? 0) + write;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort(
      (a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model),
    );
  }

  get size(): number {
    return this.#states.size;
  }
}
