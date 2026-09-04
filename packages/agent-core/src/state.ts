import { z } from "zod";
import type { LlmMessage, ToolCallBlock, TokenUsage } from "@nexus/llm";
import { type riskLevelSchema } from "@nexus/tools";

/**
 * États d'un run.
 *
 * `waiting_for_confirmation` est un état de première classe, pas un drapeau :
 * un run peut y rester dix minutes sans immobiliser de processus, et la reprise
 * repart exactement de là (cf. ADR-003).
 *
 * `incomplete` l'est tout autant. Quand un budget s'épuise, l'agent DOIT rendre
 * ce qu'il a appris et ce qui reste à faire — un agent qui s'arrête sans rien
 * dire est un défaut produit, pas un cas limite.
 */
export const agentStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_for_confirmation",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const stopReasonSchema = z.enum([
  "final_answer",
  "max_iterations",
  "max_tool_calls",
  "global_timeout",
  "tool_failure_limit",
  "cancelled",
  "confirmation_rejected",
  "confirmation_expired",
  "provider_error",
  "internal_error",
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

/** Une exécution d'outil, telle qu'elle apparaît dans la trace du run. */
export interface ToolUsageRecord {
  toolCallId: string;
  name: string;
  riskLevel: z.infer<typeof riskLevelSchema>;
  status: "success" | "failed" | "denied" | "rejected" | "skipped";
  durationMs: number;
  attempts: number;
  /** Arguments **rédigés** — jamais de secret dans la trace. */
  input: unknown;
  errorCode?: string;
}

export interface RecordedError {
  at: string;
  code: string;
  message: string;
  iteration: number;
}

/**
 * Enregistrement d'observabilité d'un run.
 *
 * C'est le contrat de traçabilité demandé : qui, quoi, quand, combien
 * d'itérations, quels outils, quelles erreurs, quels jetons.
 */
export interface AgentRunRecord {
  runId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
  startTime: string;
  endTime: string | null;
  status: AgentStatus;
  stopReason: StopReason | null;
  iterations: number;
  toolsUsed: ToolUsageRecord[];
  errors: RecordedError[];
  usage: TokenUsage;
  model: string;
  /** Réponse finale rendue à l'utilisateur, y compris en cas de résultat partiel. */
  response: string | null;
}

/**
 * État complet et **sérialisable** d'un run.
 *
 * Tout ce qui est nécessaire pour reprendre après une suspension figure ici. La
 * boucle est une fonction de cet état ; l'implémentation en mémoire d'aujourd'hui
 * et l'implémentation PostgreSQL de demain manipulent le même objet.
 */
export interface AgentState {
  record: AgentRunRecord;
  /** Transcript courant envoyé au modèle. */
  messages: LlmMessage[];
  /** Appel en attente d'un accord humain, le cas échéant. */
  pendingConfirmation: {
    confirmationId: string;
    call: ToolCallBlock;
    /** Autres appels du même tour, à traiter une fois celui-ci résolu. */
    remainingCalls: ToolCallBlock[];
  } | null;
  consecutiveToolFailures: number;
  toolCallCount: number;
  /** Signatures `nom:hash(arguments)` déjà vues — détection de boucle. */
  callSignatures: string[];
  /** Échéance absolue du délai global, en millisecondes epoch. */
  deadlineAt: number;
  /**
   * Instant de mise en attente d'une confirmation.
   *
   * Le temps passé à attendre un humain est rendu à l'échéance lors de la
   * reprise : le délai global mesure le travail de l'agent, pas la réflexion de
   * l'utilisateur.
   */
  suspendedAt: number | null;
}

export function isTerminal(status: AgentStatus): boolean {
  return (
    status === "completed" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "cancelled"
  );
}
