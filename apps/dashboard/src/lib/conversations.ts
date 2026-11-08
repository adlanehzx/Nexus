import type {
  ConversationMessage,
  ConversationSummary,
  DashboardApi,
  OrchestratedMission,
  SendToNexusOptions,
} from "./api.js";

/**
 * Conversation history for the dashboard chat.
 *
 * DOM-free on purpose. Switching conversations, recording exchanges and the
 * races between them are decided here, where a test can drive every step; the
 * component only renders the snapshot. The class follows React's external
 * store contract (`subscribe` / `getSnapshot`), so `useSyncExternalStore`
 * reads it without effects of its own.
 *
 * What is recorded is decided by the server. The chat sends its prompt with a
 * conversation id and the server writes it; the reply is written by the server
 * when a status read observes it. Nothing here ever posts an assistant message.
 */

export type ConversationHistoryApi = Pick<
  DashboardApi,
  | "conversations"
  | "conversation"
  | "conversationMessages"
  | "createConversation"
  | "renameConversation"
  | "deleteConversation"
  | "sendToNexus"
  | "nexusMission"
>;

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Present on a reply NEXUS is working on, or one observed live. */
  mission?: OrchestratedMission;
}

export interface TrackedMission {
  missionId: string;
  /** Where the reply is recorded. `null` for a mission restored from a link naming no conversation. */
  conversationId: string | null;
}

export interface ConversationHistoryState {
  /** Most recently updated first, as the server orders them. */
  conversations: readonly ConversationSummary[];
  listStatus: LoadStatus;
  /** Last failure of the list or of a rename/delete, shown in the sidebar. */
  listError: string | null;
  listCursor: string | null;

  /** `null`: a new conversation, created on its first message. */
  activeId: string | null;
  entries: readonly ChatEntry[];
  transcriptStatus: LoadStatus;
  transcriptError: string | null;
  /** Older messages remain to load when not `null`. */
  earlierCursor: string | null;
  loadingEarlier: boolean;

  /** The mission in flight. One at a time, as the composer always allowed. */
  tracked: TrackedMission | null;
  sending: boolean;
  /** Last failure to send or follow a mission, shown in the chat. */
  error: string | null;
}

export interface ChatLocation {
  conversationId: string | null;
  missionId: string | null;
}

export const CONVERSATION_PAGE_SIZE = 30;
export const TRANSCRIPT_PAGE_SIZE = 50;
export const CONVERSATION_TITLE_LIMIT = 60;
/** The server's own bound on a title. */
export const CONVERSATION_TITLE_MAX = 200;

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "scheduled"]);

export class ConversationHistory {
  readonly #api: ConversationHistoryApi;
  readonly #listeners = new Set<() => void>();
  #state: ConversationHistoryState;
  /** Bumped by every switch: a transcript that lands under an older value is stale. */
  #view = 0;
  /** Bumped by every list request: only the latest one may write the list. */
  #listRequest = 0;
  #polling = false;
  #started = false;
  #localSequence = 0;

  constructor(api: ConversationHistoryApi, restore: Partial<ChatLocation> = {}) {
    this.#api = api;
    const activeId = restore.conversationId ?? null;
    const tracked =
      restore.missionId === undefined || restore.missionId === null
        ? null
        : { missionId: restore.missionId, conversationId: activeId };
    this.#state = {
      conversations: [],
      listStatus: "idle",
      listError: null,
      listCursor: null,
      activeId,
      // A mission restored without a conversation has no transcript to come
      // back from: its progress is the whole view, as before history existed.
      entries:
        activeId === null && tracked !== null ? [pendingEntry(tracked.missionId)] : ([] as const),
      transcriptStatus: activeId === null ? "ready" : "loading",
      transcriptError: null,
      earlierCursor: null,
      loadingEarlier: false,
      tracked,
      sending: false,
      error: null,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ConversationHistoryState => this.#state;

  /** Loads the list and the conversation the page was opened on. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const restoring = this.#state.activeId;
    await Promise.all([
      this.refresh(),
      restoring === null ? Promise.resolve() : this.#load(restoring, this.#view, true),
    ]);
  }

  async refresh(): Promise<void> {
    const request = ++this.#listRequest;
    this.#set({ listStatus: "loading", listError: null });
    try {
      const page = await this.#api.conversations({ limit: CONVERSATION_PAGE_SIZE });
      if (request !== this.#listRequest) return;
      // The open conversation can sit beyond the first page (opened from a link);
      // it stays listed rather than vanishing from under the user.
      const active = this.#state.conversations.find((item) => item.id === this.#state.activeId);
      const items =
        active === undefined || page.items.some((item) => item.id === active.id)
          ? page.items
          : sortByRecency([...page.items, active]);
      this.#set({ conversations: items, listCursor: page.nextCursor, listStatus: "ready" });
    } catch (cause) {
      if (request !== this.#listRequest) return;
      this.#set({ listStatus: "error", listError: messageOf(cause) });
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.#state.listCursor;
    if (cursor === null || this.#state.listStatus === "loading") return;
    const request = ++this.#listRequest;
    this.#set({ listStatus: "loading", listError: null });
    try {
      const page = await this.#api.conversations({ cursor, limit: CONVERSATION_PAGE_SIZE });
      if (request !== this.#listRequest) return;
      const known = new Set(this.#state.conversations.map((item) => item.id));
      this.#set({
        conversations: [
          ...this.#state.conversations,
          ...page.items.filter((item) => !known.has(item.id)),
        ],
        listCursor: page.nextCursor,
        listStatus: "ready",
      });
    } catch (cause) {
      if (request !== this.#listRequest) return;
      this.#set({ listStatus: "error", listError: messageOf(cause) });
    }
  }

  /** Switches the chat to a conversation, or to a new one with `null`. */
  open(conversationId: string | null): Promise<void> {
    const current = this.#state;
    if (
      conversationId !== null &&
      conversationId === current.activeId &&
      current.transcriptStatus !== "error"
    ) {
      return Promise.resolve();
    }
    const view = ++this.#view;
    this.#set({
      activeId: conversationId,
      entries: [],
      transcriptStatus: conversationId === null ? "ready" : "loading",
      transcriptError: null,
      earlierCursor: null,
      loadingEarlier: false,
    });
    return conversationId === null ? Promise.resolve() : this.#load(conversationId, view, false);
  }

  async loadEarlier(): Promise<void> {
    const { activeId, earlierCursor, loadingEarlier } = this.#state;
    if (activeId === null || earlierCursor === null || loadingEarlier) return;
    const view = this.#view;
    this.#set({ loadingEarlier: true });
    try {
      const page = await this.#api.conversationMessages(activeId, {
        order: "desc",
        limit: TRANSCRIPT_PAGE_SIZE,
        cursor: earlierCursor,
      });
      if (view !== this.#view) return;
      const known = new Set(this.#state.entries.map((entry) => entry.id));
      const earlier = toChatEntries([...page.items].reverse()).filter(
        (entry) => !known.has(entry.id),
      );
      this.#set({
        entries: [...earlier, ...this.#state.entries],
        earlierCursor: page.nextCursor,
        loadingEarlier: false,
      });
    } catch (cause) {
      if (view !== this.#view) return;
      this.#set({ loadingEarlier: false, error: messageOf(cause) });
    }
  }

  /**
   * Sends a prompt in the open conversation, creating the conversation first
   * when the chat is on a new one. Resolves `false` when nothing was sent.
   */
  async send(
    text: string,
    options: Omit<SendToNexusOptions, "conversationId"> = {},
  ): Promise<boolean> {
    const prompt = text.trim();
    const start = this.#state;
    if (prompt.length === 0 || start.sending || start.tracked !== null) return false;

    const view = this.#view;
    let conversationId = start.activeId;
    this.#set({
      sending: true,
      error: null,
      entries: [...start.entries, { id: this.#localId(), role: "user", text: prompt }],
    });

    try {
      if (conversationId === null) {
        const created = await this.#api.createConversation({
          title: deriveConversationTitle(prompt),
        });
        conversationId = created.id;
        // Still on the new conversation: it becomes this one. If the user moved
        // on meanwhile, it simply waits in the list with its exchange.
        const adopt = view === this.#view && this.#state.activeId === null;
        this.#set({
          conversations: upsertConversation(this.#state.conversations, created),
          ...(adopt ? { activeId: created.id } : {}),
        });
      }

      const mission = await this.#api.sendToNexus(prompt, { ...options, conversationId });
      if (this.#state.activeId === conversationId) {
        this.#set({
          entries: [
            ...this.#state.entries,
            { id: mission.missionId, role: "assistant", text: "", mission },
          ],
        });
      }
      this.#set({
        conversations: touchConversation(this.#state.conversations, conversationId),
        ...(isSettled(mission)
          ? {}
          : { tracked: { missionId: mission.missionId, conversationId } }),
      });
      return true;
    } catch (cause) {
      this.#set({ error: messageOf(cause) });
      return false;
    } finally {
      this.#set({ sending: false });
    }
  }

  /** One status read of the mission in flight. Overlapping calls collapse into one. */
  async pollTracked(): Promise<void> {
    const tracked = this.#state.tracked;
    if (tracked === null || this.#polling) return;
    this.#polling = true;
    try {
      const mission = await this.#api.nexusMission(
        tracked.missionId,
        tracked.conversationId ?? undefined,
      );
      // Stopped meanwhile — its conversation was deleted — so this result is not ours.
      if (this.#state.tracked?.missionId !== tracked.missionId) return;
      const settled = isSettled(mission);
      this.#set({
        entries: this.#state.entries.map((entry) =>
          entry.id === mission.missionId || entry.mission?.missionId === mission.missionId
            ? { ...entry, mission }
            : entry,
        ),
        ...(settled ? { tracked: null } : {}),
        ...(settled && tracked.conversationId !== null
          ? {
              conversations: touchConversation(this.#state.conversations, tracked.conversationId),
            }
          : {}),
      });
    } catch (cause) {
      if (this.#state.tracked?.missionId !== tracked.missionId) return;
      this.#set({ tracked: null, error: messageOf(cause) });
    } finally {
      this.#polling = false;
    }
  }

  async rename(conversationId: string, title: string): Promise<boolean> {
    const next = title.trim();
    const current = this.#state.conversations.find((item) => item.id === conversationId);
    if (current === undefined || next.length === 0 || next.length > CONVERSATION_TITLE_MAX) {
      return false;
    }
    if (current.title === next) return true;

    // Optimistic: the row reads right away, and is put back if the server refuses.
    this.#set({
      listError: null,
      conversations: this.#state.conversations.map((item) =>
        item.id === conversationId ? { ...item, title: next } : item,
      ),
    });
    try {
      const renamed = await this.#api.renameConversation(conversationId, next);
      this.#set({ conversations: upsertConversation(this.#state.conversations, renamed) });
      return true;
    } catch (cause) {
      this.#set({
        listError: messageOf(cause),
        conversations: this.#state.conversations.map((item) =>
          item.id === conversationId && item.title === next
            ? { ...item, title: current.title }
            : item,
        ),
      });
      return false;
    }
  }

  async remove(conversationId: string): Promise<boolean> {
    const tracked = this.#state.tracked;
    const stopsTracking = tracked?.conversationId === conversationId;
    // The reply has nowhere to go once the conversation is gone, and a read
    // still in flight would only report the conversation missing.
    this.#set({ listError: null, ...(stopsTracking ? { tracked: null } : {}) });
    try {
      await this.#api.deleteConversation(conversationId);
    } catch (cause) {
      this.#set({
        listError: messageOf(cause),
        ...(stopsTracking && this.#state.tracked === null ? { tracked } : {}),
      });
      return false;
    }
    this.#set({
      conversations: this.#state.conversations.filter((item) => item.id !== conversationId),
    });
    if (this.#state.activeId === conversationId) await this.open(null);
    return true;
  }

  async #load(conversationId: string, view: number, restoring: boolean): Promise<void> {
    try {
      const [summary, page] = await Promise.all([
        this.#api.conversation(conversationId),
        this.#api.conversationMessages(conversationId, {
          order: "desc",
          limit: TRANSCRIPT_PAGE_SIZE,
        }),
      ]);
      if (view !== this.#view) return;
      this.#set({
        conversations: upsertConversation(this.#state.conversations, summary),
        entries: withTrackedReply(
          toChatEntries([...page.items].reverse()),
          this.#state.tracked,
          conversationId,
        ),
        earlierCursor: page.nextCursor,
        transcriptStatus: "ready",
      });
    } catch (cause) {
      if (view !== this.#view) return;
      if (!restoring) {
        this.#set({ transcriptStatus: "error", transcriptError: messageOf(cause) });
        return;
      }
      // A link to a conversation that is gone, or not this account's: fall back
      // to a new one instead of a dead end. Its mission cannot record anywhere.
      ++this.#view;
      this.#set({
        activeId: null,
        entries: [],
        transcriptStatus: "ready",
        transcriptError: null,
        earlierCursor: null,
        error: messageOf(cause),
        ...(this.#state.tracked?.conversationId === conversationId ? { tracked: null } : {}),
      });
    }
  }

  #localId(): string {
    this.#localSequence += 1;
    return `local-${String(this.#localSequence)}`;
  }

  #set(patch: Partial<ConversationHistoryState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Title of a conversation started by `text`: its first words, on one line.
 *
 * Cut by code point, never by UTF-16 unit: half of a surrogate pair is not
 * valid UTF-8, and PostgreSQL would refuse the whole title.
 */
export function deriveConversationTitle(text: string, limit = CONVERSATION_TITLE_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  if (characters.length === 0) return "New conversation";
  if (characters.length <= limit) return flat;

  const cut = characters.slice(0, limit - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  // A word boundary when there is one reasonably close; otherwise a hard cut.
  const kept = lastSpace >= cut.length / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}

/** Stored turns as chat entries. Only what was said: system and tool turns stay out. */
export function toChatEntries(messages: readonly ConversationMessage[]): ChatEntry[] {
  return messages.flatMap((message): ChatEntry[] =>
    message.role === "user" || message.role === "assistant"
      ? [{ id: message.id, role: message.role, text: message.content }]
      : [],
  );
}

/** The mission no longer needs following: it answered, failed, or was scheduled. */
export function isSettled(mission: OrchestratedMission): boolean {
  return mission.response !== null || mission.error !== null || TERMINAL_STATES.has(mission.state);
}

/** Active conversations whose title contains `query`, ignoring case and accents. */
export function filterConversations(
  conversations: readonly ConversationSummary[],
  query: string,
): ConversationSummary[] {
  const needle = fold(query.trim());
  return conversations.filter(
    (conversation) =>
      conversation.status !== "ARCHIVED" &&
      (needle.length === 0 || fold(conversation.title).includes(needle)),
  );
}

export type RecencyGroup = "today" | "yesterday" | "week" | "month" | "older";

/** Buckets by local calendar day, newest first; empty buckets are left out. */
export function groupConversationsByRecency(
  conversations: readonly ConversationSummary[],
  now: Date,
): { group: RecencyGroup; items: ConversationSummary[] }[] {
  const day = 86_400_000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const order: RecencyGroup[] = ["today", "yesterday", "week", "month", "older"];
  const buckets = new Map<RecencyGroup, ConversationSummary[]>(order.map((key) => [key, []]));

  for (const conversation of conversations) {
    const at = Date.parse(conversation.updatedAt);
    const group: RecencyGroup = Number.isNaN(at)
      ? "older"
      : at >= today
        ? "today"
        : at >= today - day
          ? "yesterday"
          : at >= today - 7 * day
            ? "week"
            : at >= today - 30 * day
              ? "month"
              : "older";
    buckets.get(group)?.push(conversation);
  }

  return order.flatMap((group) => {
    const items = buckets.get(group) ?? [];
    return items.length === 0 ? [] : [{ group, items }];
  });
}

/** Reads the conversation and mission a chat link points at. */
export function readChatLocation(href: string): ChatLocation {
  const url = new URL(href);
  const hashQuery = url.hash.includes("?") ? new URLSearchParams(url.hash.split("?")[1]) : null;
  const read = (key: string): string | null => {
    const value = url.searchParams.get(key) ?? hashQuery?.get(key) ?? null;
    return value !== null && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  };
  return { conversationId: read("conversation"), missionId: read("mission") };
}

/**
 * The same link, pointing at `location`.
 *
 * Both keys live in the query string. A legacy `#chat?mission=` copy is dropped
 * so that it cannot resurrect a finished mission on the next reload.
 */
export function writeChatLocation(href: string, location: ChatLocation): string {
  const url = new URL(href);
  const assign = (params: URLSearchParams, key: string, value: string | null) => {
    if (value === null) params.delete(key);
    else params.set(key, value);
  };
  assign(url.searchParams, "conversation", location.conversationId);
  assign(url.searchParams, "mission", location.missionId);

  if (url.hash.includes("?")) {
    const [path = "", query = ""] = url.hash.split("?");
    const params = new URLSearchParams(query);
    params.delete("conversation");
    params.delete("mission");
    const rest = params.toString();
    url.hash = rest.length === 0 ? path : `${path}?${rest}`;
  }
  return url.toString();
}

function upsertConversation(
  conversations: readonly ConversationSummary[],
  conversation: ConversationSummary,
): ConversationSummary[] {
  return sortByRecency([
    conversation,
    ...conversations.filter((item) => item.id !== conversation.id),
  ]);
}

/** Moves a conversation up as the server will once it records the exchange. */
function touchConversation(
  conversations: readonly ConversationSummary[],
  conversationId: string,
): ConversationSummary[] {
  const at = new Date().toISOString();
  return sortByRecency(
    conversations.map((item) => (item.id === conversationId ? { ...item, updatedAt: at } : item)),
  );
}

function sortByRecency(conversations: ConversationSummary[]): ConversationSummary[] {
  // Stable: equal timestamps keep their relative order.
  return conversations.sort(
    (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  );
}

/** A reply still being worked on is shown under its prompt when the conversation reopens. */
function withTrackedReply(
  entries: ChatEntry[],
  tracked: TrackedMission | null,
  conversationId: string,
): ChatEntry[] {
  if (tracked?.conversationId !== conversationId) return entries;
  if (entries.some((entry) => entry.id === tracked.missionId)) return entries;
  return [...entries, pendingEntry(tracked.missionId)];
}

function pendingEntry(missionId: string): ChatEntry {
  return {
    id: missionId,
    role: "assistant",
    text: "",
    mission: {
      missionId,
      title: "NEXUS Mission",
      state: "pending",
      profiles: [],
      completedTasks: 0,
      totalTasks: 1,
      response: null,
      error: null,
    },
  };
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : "Request failed.";
}
