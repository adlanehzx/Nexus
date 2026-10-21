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

  get size(): number {
    return this.#states.size;
  }
}
