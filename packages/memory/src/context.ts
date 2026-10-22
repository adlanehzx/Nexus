import type { MemoryProvider } from "./provider.js";
import type { ShortTermContext } from "./short-term.js";
import type { ConversationHistoryPort, DeviceContextPort, TaskHistoryPort } from "./sources.js";
import { ConservativeTokenCounter, type TokenCounter } from "./tokens.js";

/**
 * Context assembly.
 *
 * This is where the six layers converge — and the core principle of this module is
 * that they converge **without mixing**. Each source retains its own section,
 * its budget, and its owner; none can starve the others.
 *
 * Per-section budgeting is the central design decision. A single global budget
 * seems simpler but behaves poorly: a long conversation consumes everything, and
 * user preferences — three lines that alter the response —
 * are dropped because they arrive last. Section partitioning guarantees that a
 * verbose history will not make NEXUS forget that the user prefers the train.
 *
 * The order is an order of **priority**, not reading sequence: sections served
 * first are those that alter the answer even when all else is missing.
 *
 *     1. preferences      what the user requested once and for all
 *     2. current context  what this session established
 *     3. memories         what NEXUS knows about the user
 *     4. devices          what can be done, and where
 *     5. recent tasks     what just happened
 *     6. history          the rest of the conversation
 *
 * **Budget is counted in characters, not tokens.** Counting tokens
 * would require the provider tokenizer, thus a model dependency in a
 * package that has none. Characters serve as a stable proxy, and this budget
 * is a fence — not an accounting ledger.
 */

export interface ContextBudget {
  preferences: number;
  shortTerm: number;
  longTerm: number;
  devices: number;
  tasks: number;
  conversation: number;
}

/**
 * Default budget: ~6,000 characters.
 *
 * Preferences have a smaller allocation because they require little space;
 * conversation has the largest because it is the only one growing without bound.
 */
export const DEFAULT_BUDGET: ContextBudget = {
  preferences: 600,
  shortTerm: 800,
  longTerm: 1_500,
  devices: 600,
  tasks: 800,
  conversation: 1_700,
};

export type ContextSectionName =
  "preferences" | "shortTerm" | "longTerm" | "devices" | "tasks" | "conversation";

export interface ContextSection {
  name: ContextSectionName;
  title: string;
  lines: string[];
  chars: number;
  tokens: number;
  /** Items discarded due to space limits. Not displayed, useful for diagnostics. */
  dropped: number;
}

export interface AssembledContext {
  sections: ContextSection[];
  /** Block ready to attach to system instructions. */
  text: string;
  chars: number;
  /** Local estimate or exact count if the adapter injects its tokenizer. */
  tokens: number;
}

export interface ContextAssemblerOptions {
  memory: MemoryProvider;
  shortTerm?: ShortTermContext;
  conversation?: ConversationHistoryPort;
  devices?: DeviceContextPort;
  tasks?: TaskHistoryPort;
  budget?: Partial<ContextBudget>;
  /** Second fence expressed in tokens, independent of character budget fence. */
  tokenBudget?: Partial<ContextBudget>;
  tokenCounter?: TokenCounter;
}

export interface AssembleInput {
  userId: string;
  conversationId: string;
  /** Current turn. Serves as query for memory retrieval. */
  query: string;
  model?: string;
}

const TITLES: Record<ContextSectionName, string> = {
  preferences: "User preferences",
  shortTerm: "Current session context",
  longTerm: "What you know about this user",
  devices: "Available devices",
  tasks: "Recent tasks",
  conversation: "Earlier in the conversation",
};

export class ContextAssembler {
  readonly #options: ContextAssemblerOptions;
  readonly #budget: ContextBudget;
  readonly #tokenBudget: ContextBudget;
  readonly #tokens: TokenCounter;

  constructor(options: ContextAssemblerOptions) {
    this.#options = options;
    this.#budget = { ...DEFAULT_BUDGET, ...options.budget };
    this.#tokenBudget = {
      preferences: 180,
      shortTerm: 240,
      longTerm: 450,
      devices: 180,
      tasks: 240,
      conversation: 520,
      ...options.tokenBudget,
    };
    this.#tokens = options.tokenCounter ?? new ConservativeTokenCounter();
  }

  async assemble(input: AssembleInput): Promise<AssembledContext> {
    // All six reads are initiated concurrently: they do not depend on each
    // other, and serializing them would unnecessarily compound latency.
    const [preferences, longTerm, conversation, devices, tasks] = await Promise.all([
      this.#preferences(input),
      this.#longTerm(input),
      this.#conversation(input),
      this.#devices(input),
      this.#tasks(input),
    ]);

    const sections = [
      preferences,
      this.#shortTerm(input),
      longTerm,
      devices,
      tasks,
      conversation,
    ].filter((section): section is ContextSection => section !== undefined);

    const text = sections
      .filter((section) => section.lines.length > 0)
      .map((section) => `## ${section.title}\n${section.lines.join("\n")}`)
      .join("\n\n");

    return { sections, text, chars: text.length, tokens: this.#tokens.count(text, input.model) };
  }

  // ── 4. Preferences ───────────────────────────────────────────────────────

  async #preferences(input: AssembleInput): Promise<ContextSection> {
    // Empty query retrieves **all** preferences, not just those matching the
    // message. A permanent instruction applies regardless of today's topic —
    // e.g. "always answer in English" must not disappear when discussing Docker.
    const hits = await this.#options.memory.search({
      userId: input.userId,
      query: "",
      layers: ["PREFERENCE"],
      limit: 20,
    });

    return fit(
      "preferences",
      hits.map((hit) => `- ${hit.record.content}`),
      this.#budget.preferences,
      this.#tokenBudget.preferences,
      this.#tokens,
      input.model,
    );
  }

  // ── 2. Short-term context ───────────────────────────────────────────────

  #shortTerm(input: AssembleInput): ContextSection {
    const notes = this.#options.shortTerm?.list(input.conversationId) ?? [];

    return fit(
      "shortTerm",
      notes.map((note) => `- ${note.key} : ${note.value}`),
      this.#budget.shortTerm,
      this.#tokenBudget.shortTerm,
      this.#tokens,
      input.model,
    );
  }

  // ── 3. Long-term memory ─────────────────────────────────────────────────

  async #longTerm(input: AssembleInput): Promise<ContextSection> {
    const hits = await this.#options.memory.search({
      userId: input.userId,
      query: input.query,
      layers: ["LONG_TERM"],
      limit: 12,
    });

    return fit(
      "longTerm",
      // Origin accompanies the fact. "User stated" vs "inferred from conversation"
      // hold different authority, allowing the model to nuance statements rather than
      // asserting an inference as absolute certainty.
      hits.map(
        (hit) => `- ${hit.record.content}${hit.record.origin === "AGENT" ? " (inferred)" : ""}`,
      ),
      this.#budget.longTerm,
      this.#tokenBudget.longTerm,
      this.#tokens,
      input.model,
    );
  }

  // ── 5. Devices ──────────────────────────────────────────────────────────

  async #devices(input: AssembleInput): Promise<ContextSection> {
    const devices = (await this.#options.devices?.devicesFor(input.userId)) ?? [];

    return fit(
      "devices",
      devices.map(
        (device) =>
          `- ${device.name} (${device.role}, ${device.status})` +
          (device.capabilities.length === 0 ? "" : ` : ${device.capabilities.join(", ")}`),
      ),
      this.#budget.devices,
      this.#tokenBudget.devices,
      this.#tokens,
      input.model,
    );
  }

  // ── 6. Task history ─────────────────────────────────────────────────────

  async #tasks(input: AssembleInput): Promise<ContextSection> {
    const tasks =
      (await this.#options.tasks?.recentTasks({ userId: input.userId, limit: 10 })) ?? [];

    return fit(
      "tasks",
      tasks.map(
        (task) =>
          `- ${task.title} — ${task.status}` +
          (task.deviceName === null ? "" : ` on ${task.deviceName}`),
      ),
      this.#budget.tasks,
      this.#tokenBudget.tasks,
      this.#tokens,
      input.model,
    );
  }

  // ── 1. Conversation history ─────────────────────────────────────────────

  async #conversation(input: AssembleInput): Promise<ContextSection> {
    const turns =
      (await this.#options.conversation?.recentTurns({
        userId: input.userId,
        conversationId: input.conversationId,
        limit: 20,
      })) ?? [];

    // Most recent turns take precedence as the current prompt directly extends them.
    // Build the list backwards, then restore chronological order once budget is met.
    const lines = [...turns].reverse().map((turn) => `- ${turn.role} : ${collapse(turn.content)}`);

    const section = fit(
      "conversation",
      lines,
      this.#budget.conversation,
      this.#tokenBudget.conversation,
      this.#tokens,
      input.model,
    );
    return { ...section, lines: [...section.lines].reverse() };
  }
}

/**
 * Fills a section up to its allocated budget.
 *
 * Cuts occur strictly between lines, never mid-sentence: a preference truncated
 * mid-phrase can invert meaning, and a model cannot deduce missing text.
 */
function fit(
  name: ContextSectionName,
  lines: string[],
  budget: number,
  tokenBudget: number,
  tokenCounter: TokenCounter,
  model?: string,
): ContextSection {
  const kept: string[] = [];
  let chars = 0;
  let tokens = 0;

  for (const line of lines) {
    const lineTokens = tokenCounter.count(line, model);
    if (chars + line.length + 1 > budget || tokens + lineTokens > tokenBudget) break;
    kept.push(line);
    chars += line.length + 1;
    tokens += lineTokens;
  }

  return {
    name,
    title: TITLES[name],
    lines: kept,
    chars,
    tokens,
    dropped: lines.length - kept.length,
  };
}

/** Formats a conversation turn into a single bounded line. */
function collapse(content: string): string {
  const single = content.replace(/\s+/g, " ").trim();
  return single.length <= 200 ? single : `${single.slice(0, 200)}…`;
}
