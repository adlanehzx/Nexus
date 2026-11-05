import type {
  ApiClient,
  ApiMessage,
  MessageView,
  RealtimeClient,
  SessionManager,
} from "@nexus/client-core";
import type { MobileApi } from "./api.js";
import type { AgentRunResult, OrchestratedMission } from "./api-types.js";
import { LOCAL_MESSAGE_PREFIX, type MobileAction, type SendMode } from "./chat-state.js";
import { describeFailure, failureMessage } from "./errors.js";

/**
 * The conversation workflow, free of React and of any native module.
 *
 * Three routes can answer a message and none of them streams today, so the
 * honest states are "waiting" and "answered". When the core starts emitting
 * `message.delta`, the shared reducer renders it with no change here.

 */

export interface RunConfirmation {
  runId: string;
  id: string;
  toolName: string;
  riskLevel: string;
  expiresAt: string;
}

export interface ChatState {
  conversationId: string | null;
  loadingHistory: boolean;
  /** History was longer than what a phone loads at once. */
  historyTruncated: boolean;
  /** An agent run is in progress for this conversation. */
  running: boolean;
  /** Identified once the core lists the run: only then can it be interrupted. */
  activeRunId: string | null;
  /** The run stopped and awaits a decision. Answering resumes it. */
  pendingConfirmation: RunConfirmation | null;
  /** Model of the last answer, as reported by the core. */
  lastModel: string | null;
  /** Missions started from this conversation. */
  missions: OrchestratedMission[];
}

export const initialChatState: ChatState = {
  conversationId: null,
  loadingHistory: false,
  historyTruncated: false,
  running: false,
  activeRunId: null,
  pendingConfirmation: null,
  lastModel: null,
  missions: [],
};

export interface ChatControllerOptions {
  mobile: Pick<
    MobileApi,
    | "createConversation"
    | "listAllMessages"
    | "runAgent"
    | "answerRunConfirmation"
    | "cancelRun"
    | "listRuns"
    | "submitMission"
  >;
  api: Pick<ApiClient, "instruct">;
  realtime: Pick<RealtimeClient, "sendMessage">;
  session: Pick<SessionManager, "deviceId">;
  dispatch: (action: MobileAction) => void;
  onChange: (state: ChatState) => void;
  /** An answer was received: the voice pipeline may read it. */
  onReply?: (text: string) => void;
  now?: () => Date;
  timezone?: () => string;
  pollIntervalMs?: number;
}

const ACTIVE_RUN_POLL_MS = 3_000;

export class ChatController {
  readonly #options: ChatControllerOptions;
  #state: ChatState = initialChatState;
  #sequence = 0;
  /** Guards against a slow history response overwriting a newer conversation. */
  #generation = 0;

  constructor(options: ChatControllerOptions) {
    this.#options = options;
  }

  get state(): ChatState {
    return this.#state;
  }

  newConversation(): void {
    this.#generation += 1;
    this.#options.dispatch({ kind: "clearMessages" });
    this.#set({ ...initialChatState });
  }

  async openConversation(conversationId: string): Promise<void> {
    this.#generation += 1;
    this.#options.dispatch({ kind: "clearMessages" });
    this.#set({ ...initialChatState, conversationId, loadingHistory: true });
    await this.refresh();
  }

  /**
   * Re-reads the open conversation.
   *
   * Called on reconnection and when the app returns to the foreground: an
   * answer produced while the phone was away reaches the screen this way, since
   * the realtime channel replays nothing.
   */
  async refresh(): Promise<void> {
    const conversationId = this.#state.conversationId;
    if (conversationId === null) return;

    const generation = this.#generation;
    try {
      const { items, truncated } =
        await this.#options.mobile.listAllMessages<ApiMessage>(conversationId);
      if (generation !== this.#generation) return;
      this.#options.dispatch({ kind: "hydrateMessages", messages: toMessageViews(items) });
      this.#set({ ...this.#state, loadingHistory: false, historyTruncated: truncated });
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.#set({ ...this.#state, loadingHistory: false });
      this.#fail("CHAT_HISTORY_UNAVAILABLE", cause);
    }
  }

  /** False when the core refused the text, which the caller should give back to the user. */
  async send(rawText: string, mode: SendMode = "chat"): Promise<boolean> {
    const text = rawText.trim();
    if (text.length === 0) return true;

    const localId = this.#showLocally(text);

    try {
      if (mode === "chat") await this.#sendToAgent(text);
      else if (mode === "action") await this.#sendAsAction(text);
      else await this.#sendAsMission(text);
      return true;
    } catch (cause) {
      this.#set({ ...this.#state, running: false, activeRunId: null });
      this.#options.dispatch({ kind: "removeMessage", messageId: localId });
      this.#fail("CHAT_SEND_FAILED", cause);
      return false;
    }
  }

  async answerConfirmation(decision: "approved" | "rejected"): Promise<void> {
    const pending = this.#state.pendingConfirmation;
    if (pending === null) return;

    this.#set({ ...this.#state, pendingConfirmation: null, running: decision === "approved" });
    try {
      const result = await this.#options.mobile.answerRunConfirmation(
        pending.runId,
        decision,
        pending.id,
      );
      await this.#finishRun(result);
    } catch (cause) {
      // The decision may not have reached the core: put it back rather than
      // letting the action look decided.
      this.#set({ ...this.#state, running: false, pendingConfirmation: pending });
      this.#fail("CHAT_CONFIRMATION_FAILED", cause);
    }
  }

  /** Interrupts the run, once the core has identified it. Returns whether it stopped. */
  async stop(): Promise<boolean> {
    const runId = this.#state.activeRunId;
    if (runId === null) return false;
    try {
      return await this.#options.mobile.cancelRun(runId);
    } catch (cause) {
      this.#fail("CHAT_STOP_FAILED", cause);
      return false;
    }
  }

  async #sendToAgent(text: string): Promise<void> {
    const generation = this.#generation;
    const conversationId = await this.#ensureConversation(text);

    this.#set({ ...this.#state, running: true, activeRunId: null, pendingConfirmation: null });
    const stopPolling = this.#watchForRunId(conversationId, generation);
    try {
      const result = await this.#options.mobile.runAgent(conversationId, text);
      if (generation !== this.#generation) return;
      await this.#finishRun(result);
    } catch (cause) {
      if (describeFailure(cause).kind === "network") {
        // The run may well be finishing on the core. No resend: a retried
        // message could repeat a real-world action. Reconnection re-reads the
        // conversation and shows whatever the run produced.
        this.#set({ ...this.#state, running: false, activeRunId: null });
        this.#options.dispatch({
          kind: "error",
          code: "CHAT_ANSWER_DELAYED",
          message:
            "Connection lost while NEXUS was working. The answer will appear here once you are back online.",
          at: this.#now(),
        });
        return;
      }
      throw cause;
    } finally {
      stopPolling();
    }
  }

  async #sendAsAction(text: string): Promise<void> {
    const deviceId = this.#options.session.deviceId;
    if (deviceId === null) throw new Error("This device is not registered with NEXUS yet.");

    const { conversationId } = await this.#options.realtime.sendMessage({
      conversationId: this.#state.conversationId,
      text,
    });
    this.#set({ ...this.#state, conversationId });

    // Progress arrives over the realtime channel as `task.*` frames.
    await this.#options.api.instruct({
      instruction: text,
      originClientDeviceId: deviceId,
      conversationId,
    });
  }

  async #sendAsMission(text: string): Promise<void> {
    const mission = await this.#options.mobile.submitMission(text, this.#timezone());
    this.#set({ ...this.#state, missions: [...this.#state.missions, mission] });
  }

  async #ensureConversation(text: string): Promise<string> {
    if (this.#state.conversationId !== null) return this.#state.conversationId;
    const conversation = await this.#options.mobile.createConversation(text.slice(0, 60));
    this.#set({ ...this.#state, conversationId: conversation.id });
    return conversation.id;
  }

  async #finishRun(result: AgentRunResult): Promise<void> {
    this.#set({
      ...this.#state,
      running: false,
      activeRunId: null,
      lastModel: result.model,
      pendingConfirmation:
        result.confirmation === null ? null : { runId: result.runId, ...result.confirmation },
    });
    await this.refresh();
    if (result.response !== null && result.confirmation === null) {
      this.#options.onReply?.(result.response);
    }
  }

  /**
   * Finds the run's id while it executes.
   *
   * `POST /agent-core/runs` only answers at the end, and `agent.started` is not
   * emitted yet. The run list is the one place to read the id from. It is
   * administrator-only: on a refusal the Stop control simply never appears.
   */
  #watchForRunId(conversationId: string, generation: number): () => void {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = this.#options.pollIntervalMs ?? ACTIVE_RUN_POLL_MS;

    const tick = async () => {
      if (!active || generation !== this.#generation) return;
      try {
        const runs = await this.#options.mobile.listRuns(10);
        const running = runs.find(
          (run) => run.conversationId === conversationId && run.status.toLowerCase() === "running",
        );
        if (active && running !== undefined) {
          this.#set({ ...this.#state, activeRunId: running.runId });
          return;
        }
      } catch (cause) {
        if (describeFailure(cause).kind !== "network") return;
      }
      if (active) timer = setTimeout(() => void tick(), interval);
    };

    timer = setTimeout(() => void tick(), interval);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }

  #showLocally(text: string): string {
    this.#sequence += 1;
    const id = `${LOCAL_MESSAGE_PREFIX}${String(this.#sequence)}-${this.#now()}`;
    this.#options.dispatch({
      kind: "localMessage",
      message: {
        id,
        role: "user",
        content: text,
        streaming: false,
        createdAt: this.#now(),
        originClientDeviceId: this.#options.session.deviceId,
      },
    });
    return id;
  }

  #fail(code: string, cause: unknown): void {
    this.#options.dispatch({
      kind: "error",
      code,
      message: failureMessage(cause),
      at: this.#now(),
    });
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }

  #timezone(): string {
    return this.#options.timezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  #set(state: ChatState): void {
    this.#state = state;
    this.#options.onChange(state);
  }
}

/** Only what the user and the assistant said: internal roles have no place in the timeline. */
export function toMessageViews(messages: readonly ApiMessage[]): MessageView[] {
  const views: MessageView[] = [];
  for (const message of messages) {
    const role = message.role.toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    views.push({
      id: message.id,
      role,
      content: message.content,
      streaming: false,
      createdAt: message.createdAt,
      originClientDeviceId: message.originClientDeviceId,
    });
  }
  return views;
}
