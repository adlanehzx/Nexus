import { z } from "zod";
import type { LlmMessage, ToolCallBlock, TokenUsage } from "@nexus/llm";
import { type riskLevelSchema } from "@nexus/tools";

/**
 * Execution run statuses.
 *
 * `waiting_for_confirmation` represents a first-class paused state.
 * `incomplete` indicates termination due to budget constraints with partial output.
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

/** Tool execution record for audit traces. */
export interface ToolUsageRecord {
  toolCallId: string;
  name: string;
  riskLevel: z.infer<typeof riskLevelSchema>;
  status: "success" | "failed" | "denied" | "rejected" | "skipped";
  durationMs: number;
  attempts: number;
  /** Redacted arguments — secrets must never leak into trace records. */
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
 * Observability record of an agent run.
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
  /** Final response delivered to user, including partial output on limits. */
  response: string | null;
  /** Associated mission external key or null for user-initiated conversations. */
  missionExternalKey: string | null;
  /** Source run ID when this run is an analysis replay without tools. */
  replayOfRunId?: string | null;
  /** Explicit fallback count to alternative agents or retry configurations. */
  fallbackCount?: number;
  /** Bounded context accounting. It intentionally excludes raw context text. */
  contextUsage?: {
    chars: number;
    tokens: number;
    tokenBudget: number;
    compacted: boolean;
    sections: { name: string; chars: number; tokens: number; dropped: number }[];
  };
}

export interface AgentContextSnapshot {
  /** Governed run context, retained only with the durable run state. */
  text: string;
  chars: number;
  tokens: number;
  tokenBudget: number;
  sections: { name: string; chars: number; tokens: number; dropped: number }[];
}

/**
 * Complete serializable state of an agent execution run.
 */
export interface AgentState {
  record: AgentRunRecord;
  /** Current conversation transcript presented to the model. */
  messages: LlmMessage[];
  /** Exact bounded background required to resume deterministically. */
  contextSnapshot?: AgentContextSnapshot | null;
  /** Pending tool call awaiting human authorization. */
  pendingConfirmation: {
    confirmationId: string;
    call: ToolCallBlock;
    /** Remaining tool calls in the current turn to execute upon authorization. */
    remainingCalls: ToolCallBlock[];
  } | null;
  consecutiveToolFailures: number;
  toolCallCount: number;
  /** Set of seen `name:hash(arguments)` call signatures for loop detection. */
  callSignatures: string[];
  /** Absolute epoch deadline in milliseconds. */
  deadlineAt: number;
  /** Timestamp when execution suspended waiting for human confirmation. */
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
