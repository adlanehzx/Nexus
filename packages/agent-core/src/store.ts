import { NotFoundError } from "@nexus/shared";
import type { AgentState } from "./state.js";

/**
 * Port de persistance des runs.
 *
 * `@nexus/agent-core` ne dépend pas de la base : il reçoit ce port. C'est ce qui
 * rend la boucle testable sans PostgreSQL et rejouable sur un état en mémoire
 * (cf. ADR-003 et les règles de dépendance du monorepo).
 *
 * L'implémentation Prisma arrivera avec `services/agent`, sans toucher à la
 * boucle.
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
    // Copie défensive : un appelant qui muterait son objet après coup
    // corromprait silencieusement l'état persisté.
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
        message: `Run inconnu : ${runId}`,
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
   * Tous les runs retenus.
   *
   * Hors du port `AgentRunStore` : la boucle n'en a pas besoin, elle travaille
   * sur un run a la fois. C'est la supervision qui s'en sert, et une methode
   * imposee a toute implementation future du port pour un seul appelant serait
   * une contrainte mal placee.
   */
  listAll(): Promise<AgentState[]> {
    return Promise.resolve([...this.#states.values()].map((state) => structuredClone(state)));
  }

  get size(): number {
    return this.#states.size;
  }
}
