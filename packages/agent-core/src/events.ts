import type { ConfirmationRequest, RiskLevel } from "@nexus/tools";
import type { TokenUsage } from "@nexus/llm";
import type { AgentStatus, StopReason } from "./state.js";

/**
 * Événements de trace.
 *
 * Ils décrivent ce que l'agent fait pendant qu'il le fait. En phase 1 ils
 * alimenteront le WebSocket ; ici ils servent déjà à la journalisation et aux
 * assertions de test.
 *
 * Tout ce qui traverse un événement est **déjà rédigé** : un événement est
 * destiné à être journalisé et transmis, il ne doit jamais porter de secret.
 */
export type AgentEvent =
  | { type: "run.started"; runId: string; conversationId: string; at: string }
  | { type: "iteration.started"; runId: string; iteration: number; at: string }
  | { type: "llm.completed"; runId: string; iteration: number; usage: TokenUsage; at: string }
  | { type: "agent.message"; runId: string; text: string; at: string }
  | {
      type: "tool.started";
      runId: string;
      toolCallId: string;
      name: string;
      riskLevel: RiskLevel;
      input: unknown;
      at: string;
    }
  | {
      type: "tool.progress";
      runId: string;
      toolCallId: string;
      name: string;
      pct: number | undefined;
      label: string | undefined;
      at: string;
    }
  | {
      type: "tool.completed";
      runId: string;
      toolCallId: string;
      name: string;
      ok: boolean;
      durationMs: number;
      attempts: number;
      summary: string;
      at: string;
    }
  | {
      type: "tool.denied";
      runId: string;
      toolCallId: string;
      name: string;
      reason: string;
      at: string;
    }
  | { type: "confirmation.requested"; runId: string; request: ConfirmationRequest; at: string }
  | {
      type: "confirmation.resolved";
      runId: string;
      confirmationId: string;
      decision: "approved" | "rejected" | "expired";
      at: string;
    }
  | {
      type: "run.finished";
      runId: string;
      status: AgentStatus;
      stopReason: StopReason;
      at: string;
    };

export type AgentEventHandler = (event: AgentEvent) => void;

/**
 * Émetteur d'événements.
 *
 * Un abonné qui lève une exception ne doit pas faire échouer le run : la trace
 * est un service rendu au run, jamais une dépendance dont il dépend.
 */
export class AgentEventEmitter {
  readonly #handlers = new Set<AgentEventHandler>();

  on(handler: AgentEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  emit(event: AgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch {
        // Volontairement ignoré : voir la note ci-dessus.
      }
    }
  }
}
