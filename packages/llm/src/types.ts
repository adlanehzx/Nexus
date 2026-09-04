/**
 * Format neutre des messages.
 *
 * Aucun type de ce fichier n'appartient à un fournisseur : c'est ce qui permet
 * à `@nexus/agent-core` de raisonner sans jamais importer de SDK (cf. ADR-004).
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  /** Identifiant émis par le fournisseur ; il rattache le résultat à l'appel. */
  id: string;
  name: string;
  /** Arguments bruts, non validés. Le schéma de l'outil fait foi. */
  arguments: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  /** Projection bornée pour le modèle, jamais la sortie complète de l'outil. */
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface LlmMessage {
  role: MessageRole;
  content: ContentBlock[];
  /**
   * Blocs opaques propres au fournisseur (blocs de raisonnement, signatures…),
   * rendus par l'adaptateur et rejoués tels quels au tour suivant.
   *
   * Le cœur agent ne les lit **jamais** ; il les transporte. Sans ce canal, un
   * modèle à raisonnement étendu perdrait ses blocs entre deux tours et le
   * fournisseur rejetterait la requête.
   */
  providerBlocks?: unknown;
}

/** Description d'un outil telle que le modèle la reçoit. */
export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema dérivé du schéma Zod de l'outil. */
  inputSchema: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason =
  "end_turn" | "tool_call" | "max_tokens" | "stop_sequence" | "refusal" | "aborted";

export interface GenerateRequest {
  messages: LlmMessage[];
  system?: string;
  tools?: LlmToolSpec[];
  maxTokens?: number;
  /** Options propres à un adaptateur. Jamais lues par le cœur agent. */
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GenerateResponse {
  content: ContentBlock[];
  providerBlocks?: unknown;
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
}

export type StreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCallBlock }
  | { type: "done"; response: GenerateResponse };

/** Extrait le texte concaténé d'une liste de blocs. */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Extrait les appels d'outil d'une liste de blocs. */
export function toolCallsOf(content: readonly ContentBlock[]): ToolCallBlock[] {
  return content.filter((block): block is ToolCallBlock => block.type === "tool_call");
}
