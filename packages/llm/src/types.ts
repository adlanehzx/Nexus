/**
 * Neutral message format.
 *
 * No type in this file belongs to any provider: this allows
 * `@nexus/agent-core` to reason without importing any SDK (cf. ADR-004).
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  /** Identifier emitted by the provider, linking result to invocation. */
  id: string;
  name: string;
  /** Raw arguments, unvalidated. The tool schema is authoritative. */
  arguments: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  /** Bounded projection for the model, never the raw tool output. */
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface LlmMessage {
  role: MessageRole;
  content: ContentBlock[];
  /**
   * Opaque provider-specific blocks (reasoning blocks, signatures, etc.),
   * returned by the adapter and replayed verbatim on subsequent turns.
   *
   * The agent core NEVER inspects them; it only transports them. Without this
   * channel, extended-thinking models would lose blocks between turns and the
   * provider would reject the conversation.
   */
  providerBlocks?: unknown;
}

/** Description of a tool as presented to the model. */
export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema derived from the tool's Zod schema. */
  inputSchema: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason =
  | "end_turn" | "tool_call" | "max_tokens" | "stop_sequence" | "refusal" | "aborted";

export interface GenerateRequest {
  messages: LlmMessage[];
  system?: string;
  tools?: LlmToolSpec[];
  maxTokens?: number;
  /** Adapter-specific options. Never inspected by the agent core. */
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GenerateResponse {
  content: ContentBlock[];
  providerBlocks?: unknown;
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
  /** Number of fallback providers skipped before obtaining this response. */
  fallbackCount?: number;
}

export type StreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCallBlock }
  | { type: "done"; response: GenerateResponse };

/** Extracts concatenated text from a list of blocks. */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Extracts tool calls from a list of blocks. */
export function toolCallsOf(content: readonly ContentBlock[]): ToolCallBlock[] {
  return content.filter((block): block is ToolCallBlock => block.type === "tool_call");
}
