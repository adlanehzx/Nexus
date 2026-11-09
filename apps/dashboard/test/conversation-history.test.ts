import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardApi,
  createSession,
  type ConversationMessage,
  type ConversationSummary,
  type CursorPage,
  type CursorRequest,
  type OrchestratedMission,
  type SendToNexusOptions,
} from "../src/lib/api.js";
import {
  ConversationHistory,
  deriveConversationTitle,
  filterConversations,
  groupConversationsByRecency,
  isSettled,
  readChatLocation,
  toChatEntries,
  writeChatLocation,
  type ConversationHistoryApi,
} from "../src/lib/conversations.js";

/**
 * Conversation switching and persistence in the dashboard chat.
 *
 * The fake below behaves like the API where it matters: the prompt is recorded
 * when a mission is dispatched with a conversation, and the reply when a status
 * read with that conversation observes it, once. Any request can be held back
 * to stage the races a real network produces.
 */

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

class FakeNexus implements ConversationHistoryApi {
  readonly sent: { message: string; options: SendToNexusOptions }[] = [];
  readonly polls: { missionId: string; conversationId: string | undefined }[] = [];
  readonly renames: { conversationId: string; title: string }[] = [];
  created = 0;
  failNextSend: string | null = null;
  failNextRename: string | null = null;

  readonly #conversations = new Map<string, ConversationSummary>();
  readonly #messages = new Map<string, ConversationMessage[]>();
  readonly #missions = new Map<string, OrchestratedMission>();
  readonly #held = new Map<string, Deferred>();
  #clock = Date.parse("2026-11-08T09:00:00.000Z");

  /** Holds the next request for `key` until the returned handle releases it. */
  hold(key: string): Deferred {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deferred = { promise, release };
    this.#held.set(key, deferred);
    return deferred;
  }

  seed(title: string, turns: [ConversationMessage["role"], string][] = []): ConversationSummary {
    const conversation = this.#newConversation(title);
    for (const [role, content] of turns) this.#append(conversation.id, { role, content });
    return { ...conversation };
  }

  complete(missionId: string, response: string): void {
    const mission = this.#mission(missionId);
    Object.assign(mission, {
      state: "succeeded",
      response,
      completedTasks: mission.totalTasks,
    });
  }

  advance(missionId: string): void {
    this.#mission(missionId).completedTasks += 1;
  }

  transcript(conversationId: string) {
    return (this.#messages.get(conversationId) ?? []).map(({ id, role, content }) => ({
      id,
      role,
      content,
    }));
  }

  title(conversationId: string): string | undefined {
    return this.#conversations.get(conversationId)?.title;
  }

  exists(conversationId: string): boolean {
    return this.#conversations.has(conversationId);
  }

  async conversations(page: CursorRequest = {}): Promise<CursorPage<ConversationSummary>> {
    await this.#gate("list");
    const all = [...this.#conversations.values()].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    return paginate(all, page);
  }

  async conversation(conversationId: string): Promise<ConversationSummary> {
    await this.#gate(`conversation:${conversationId}`);
    return { ...this.#existing(conversationId) };
  }

  async conversationMessages(
    conversationId: string,
    page: CursorRequest & { order?: "asc" | "desc" } = {},
  ): Promise<CursorPage<ConversationMessage>> {
    await this.#gate(`messages:${conversationId}`);
    this.#existing(conversationId);
    const all = this.#messages.get(conversationId) ?? [];
    return paginate(page.order === "desc" ? [...all].reverse() : all, page);
  }

  async createConversation(input: { title?: string | undefined } = {}) {
    await this.#gate("create");
    this.created += 1;
    return { ...this.#newConversation(input.title ?? "New Conversation") };
  }

  async renameConversation(conversationId: string, title: string) {
    await this.#gate(`rename:${conversationId}`);
    this.renames.push({ conversationId, title });
    if (this.failNextRename !== null) {
      const reason = this.failNextRename;
      this.failNextRename = null;
      throw new Error(reason);
    }
    const conversation = this.#existing(conversationId);
    Object.assign(conversation, { title, updatedAt: this.#tick() });
    return { ...conversation };
  }

  async deleteConversation(conversationId: string) {
    await this.#gate(`delete:${conversationId}`);
    this.#existing(conversationId);
    this.#conversations.delete(conversationId);
    this.#messages.delete(conversationId);
    return { deleted: true as const };
  }

  async sendToNexus(message: string, options: SendToNexusOptions = {}) {
    await this.#gate("send");
    this.sent.push({ message, options });
    if (this.failNextSend !== null) {
      const reason = this.failNextSend;
      this.failNextSend = null;
      throw new Error(reason);
    }
    const mission: OrchestratedMission = {
      missionId: randomUUID(),
      title: "NEXUS Mission",
      state: "pending",
      profiles: ["claude"],
      completedTasks: 0,
      totalTasks: 3,
      response: null,
      error: null,
    };
    this.#missions.set(mission.missionId, mission);
    if (options.conversationId !== undefined) {
      this.#append(options.conversationId, { role: "user", content: message });
    }
    return { ...mission };
  }

  async nexusMission(missionId: string, conversationId?: string) {
    this.polls.push({ missionId, conversationId });
    await this.#gate(`mission:${missionId}`);
    const mission = this.#mission(missionId);
    if (conversationId !== undefined) {
      this.#existing(conversationId);
      const recorded = [...this.#messages.values()].some((turns) =>
        turns.some((turn) => turn.id === missionId),
      );
      if (mission.response !== null && !recorded) {
        this.#append(conversationId, {
          id: missionId,
          role: "assistant",
          content: mission.response,
        });
      }
    }
    return { ...mission };
  }

  async #gate(key: string): Promise<void> {
    const held = this.#held.get(key);
    if (held === undefined) return;
    this.#held.delete(key);
    await held.promise;
  }

  #newConversation(title: string): ConversationSummary {
    const at = this.#tick();
    const conversation = {
      id: randomUUID(),
      title,
      status: "ACTIVE",
      createdAt: at,
      updatedAt: at,
    };
    this.#conversations.set(conversation.id, conversation);
    this.#messages.set(conversation.id, []);
    return conversation;
  }

  #append(
    conversationId: string,
    turn: { id?: string; role: ConversationMessage["role"]; content: string },
  ): void {
    const at = this.#tick();
    this.#messages.get(conversationId)?.push({
      id: turn.id ?? randomUUID(),
      conversationId,
      role: turn.role,
      content: turn.content,
      originClientDeviceId: null,
      createdAt: at,
    });
    const conversation = this.#existing(conversationId);
    conversation.updatedAt = at;
  }

  #existing(conversationId: string): ConversationSummary {
    const conversation = this.#conversations.get(conversationId);
    if (conversation === undefined) throw new Error("The requested resource does not exist.");
    return conversation;
  }

  #mission(missionId: string): OrchestratedMission {
    const mission = this.#missions.get(missionId);
    if (mission === undefined) throw new Error(`Unknown mission ${missionId}`);
    return mission;
  }

  #tick(): string {
    this.#clock += 1_000;
    return new Date(this.#clock).toISOString();
  }
}

/** The API's cursor semantics: resume after the item named by the cursor. */
function paginate<T extends { id: string }>(all: T[], page: CursorRequest): CursorPage<T> {
  const limit = page.limit ?? 25;
  const start =
    page.cursor === undefined ? 0 : all.findIndex((item) => item.id === page.cursor) + 1;
  const items = all.slice(start, start + limit).map((item) => ({ ...item }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: start + items.length < all.length && last !== undefined ? last.id : null,
    total: all.length,
  };
}

function texts(history: ConversationHistory): string[] {
  return history.getSnapshot().entries.map((entry) => entry.text);
}

async function started(nexus: FakeNexus): Promise<ConversationHistory> {
  const history = new ConversationHistory(nexus);
  await history.start();
  return history;
}

describe("sending from a new conversation", () => {
  it("creates the conversation from the first prompt and dispatches with its id", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    const prompt = "Audit the   security\nposture of every worker";

    expect(await history.send(`  ${prompt}  `, { profile: "claude-code" })).toBe(true);

    const state = history.getSnapshot();
    const created = state.conversations[0];
    expect(created?.title).toBe("Audit the security posture of every worker");
    expect(state.activeId).toBe(created?.id);
    expect(nexus.sent).toEqual([
      { message: prompt, options: { profile: "claude-code", conversationId: created?.id } },
    ]);
    // The prompt is the server's record, not something the chat wrote itself.
    expect(nexus.transcript(created?.id ?? "")).toEqual([
      expect.objectContaining({ role: "user", content: prompt }),
    ]);
    expect(state.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    // The reply bubble carries the mission id: the id its stored copy will have.
    expect(state.tracked).toEqual({
      missionId: state.entries[1]?.id,
      conversationId: created?.id,
    });
  });

  it("reuses the open conversation for the next prompts", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);

    await history.send("First question");
    const conversationId = history.getSnapshot().activeId;
    nexus.complete(history.getSnapshot().tracked?.missionId ?? "", "First answer");
    await history.pollTracked();
    await history.send("Second question");

    expect(nexus.created).toBe(1);
    expect(nexus.sent.map((sent) => sent.options.conversationId)).toEqual([
      conversationId,
      conversationId,
    ]);
  });

  it("sends nothing blank, and nothing while a mission is in flight", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);

    expect(await history.send("   ")).toBe(false);
    expect(await history.send("Long task")).toBe(true);
    expect(await history.send("Impatient follow-up")).toBe(false);

    expect(nexus.sent.map((sent) => sent.message)).toEqual(["Long task"]);
    expect(nexus.created).toBe(1);
  });

  it("stops tracking the in-flight mission when requested", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    await history.send("Long running mission");
    expect(history.getSnapshot().tracked).not.toBeNull();

    history.stopTracked();
    expect(history.getSnapshot().tracked).toBeNull();
  });

  it("keeps the prompt on screen and reports why when dispatch fails", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    nexus.failNextSend = "ACP engine is not configured.";

    expect(await history.send("Anyone there?")).toBe(false);

    expect(history.getSnapshot()).toMatchObject({
      error: "ACP engine is not configured.",
      tracked: null,
      sending: false,
    });
    expect(texts(history)).toEqual(["Anyone there?"]);
  });
});

describe("persistence of the reply", () => {
  it("is recorded by the status read that observes it, and is there on reopening", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    await history.send("Check every worker");
    const conversationId = history.getSnapshot().activeId ?? "";
    const missionId = history.getSnapshot().tracked?.missionId ?? "";

    await history.pollTracked();
    expect(history.getSnapshot().tracked).not.toBeNull();
    expect(nexus.transcript(conversationId)).toHaveLength(1);

    nexus.complete(missionId, "All workers are healthy.");
    await history.pollTracked();
    expect(history.getSnapshot().tracked).toBeNull();
    expect(nexus.polls.at(-1)).toEqual({ missionId, conversationId });
    expect(nexus.transcript(conversationId)[1]).toEqual({
      id: missionId,
      role: "assistant",
      content: "All workers are healthy.",
    });

    await history.open(null);
    expect(history.getSnapshot().entries).toEqual([]);
    await history.open(conversationId);

    expect(history.getSnapshot().entries.map(({ id, role, text }) => ({ id, role, text }))).toEqual(
      [
        { id: expect.any(String) as string, role: "user", text: "Check every worker" },
        { id: missionId, role: "assistant", text: "All workers are healthy." },
      ],
    );
  });

  it("keeps following a mission after switching away and records it where it was asked", async () => {
    const nexus = new FakeNexus();
    const other = nexus.seed("Other topic", [["user", "Unrelated question"]]);
    const history = await started(nexus);
    await history.send("Long task");
    const asked = history.getSnapshot().activeId ?? "";
    const missionId = history.getSnapshot().tracked?.missionId ?? "";

    await history.open(other.id);
    nexus.complete(missionId, "Long task done.");
    await history.pollTracked();

    // The screen stays on the other conversation, untouched.
    expect(history.getSnapshot().activeId).toBe(other.id);
    expect(texts(history)).toEqual(["Unrelated question"]);
    expect(history.getSnapshot().tracked).toBeNull();
    expect(nexus.transcript(asked).at(-1)).toEqual({
      id: missionId,
      role: "assistant",
      content: "Long task done.",
    });
    expect(nexus.transcript(other.id)).toHaveLength(1);

    await history.open(asked);
    expect(texts(history)).toEqual(["Long task", "Long task done."]);
  });

  it("shows a running mission under its prompt when its conversation is reopened", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    await history.send("Long task");
    const conversationId = history.getSnapshot().activeId ?? "";
    const missionId = history.getSnapshot().tracked?.missionId ?? "";

    await history.open(null);
    await history.open(conversationId);

    const entries = history.getSnapshot().entries;
    expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(entries[1]).toMatchObject({ id: missionId, mission: { state: "pending" } });

    nexus.advance(missionId);
    await history.pollTracked();
    expect(history.getSnapshot().entries[1]?.mission?.completedTasks).toBe(1);
  });

  it("collapses overlapping status reads into one request", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    await history.send("Slow engine");
    const missionId = history.getSnapshot().tracked?.missionId ?? "";

    const held = nexus.hold(`mission:${missionId}`);
    const first = history.pollTracked();
    const second = history.pollTracked();
    held.release();
    await Promise.all([first, second]);

    expect(nexus.polls).toHaveLength(1);
  });
});

describe("switching conversations", () => {
  it("never lets a slow transcript replace the conversation now on screen", async () => {
    const nexus = new FakeNexus();
    const alpha = nexus.seed("Alpha", [
      ["user", "Alpha question"],
      ["assistant", "Alpha answer"],
    ]);
    const beta = nexus.seed("Beta", [["user", "Beta question"]]);
    const history = await started(nexus);

    const held = nexus.hold(`messages:${alpha.id}`);
    const openingAlpha = history.open(alpha.id);
    expect(history.getSnapshot().transcriptStatus).toBe("loading");
    await history.open(beta.id);
    held.release();
    await openingAlpha;

    expect(history.getSnapshot().activeId).toBe(beta.id);
    expect(texts(history)).toEqual(["Beta question"]);
    expect(history.getSnapshot().transcriptStatus).toBe("ready");
  });

  it("opens on the newest turns and loads earlier ones on demand", async () => {
    const nexus = new FakeNexus();
    const long = nexus.seed(
      "Long thread",
      Array.from({ length: 60 }, (_, index): ["user", string] => [
        "user",
        `Message ${String(index + 1)}`,
      ]),
    );
    const history = await started(nexus);

    await history.open(long.id);
    expect(texts(history)).toHaveLength(50);
    expect(texts(history)[0]).toBe("Message 11");
    expect(texts(history).at(-1)).toBe("Message 60");
    expect(history.getSnapshot().earlierCursor).not.toBeNull();

    await history.loadEarlier();
    expect(texts(history)).toHaveLength(60);
    expect(texts(history)[0]).toBe("Message 1");
    expect(history.getSnapshot().earlierCursor).toBeNull();
  });

  it("lets a conversation created while the user moved on wait in the list", async () => {
    const nexus = new FakeNexus();
    const beta = nexus.seed("Beta", [["user", "Beta question"]]);
    const history = await started(nexus);

    const held = nexus.hold("create");
    const sending = history.send("A brand new topic");
    await history.open(beta.id);
    held.release();
    expect(await sending).toBe(true);

    const state = history.getSnapshot();
    const created = state.conversations.find((item) => item.title === "A brand new topic");
    expect(state.activeId).toBe(beta.id);
    expect(texts(history)).toEqual(["Beta question"]);
    expect(state.tracked?.conversationId).toBe(created?.id);
  });

  it("hides system and tool turns", () => {
    const base = { conversationId: "c", originClientDeviceId: null, createdAt: "" };
    expect(
      toChatEntries([
        { ...base, id: "1", role: "system", content: "You are NEXUS." },
        { ...base, id: "2", role: "user", content: "Hello" },
        { ...base, id: "3", role: "tool", content: "{}" },
        { ...base, id: "4", role: "assistant", content: "Hi." },
      ]),
    ).toEqual([
      { id: "2", role: "user", text: "Hello" },
      { id: "4", role: "assistant", text: "Hi." },
    ]);
  });
});

describe("restoring from a link", () => {
  it("reopens the conversation and resumes the mission in flight", async () => {
    const nexus = new FakeNexus();
    const conversation = nexus.seed("Restored");
    const mission = await nexus.sendToNexus("Resume me", { conversationId: conversation.id });

    const history = new ConversationHistory(nexus, {
      conversationId: conversation.id,
      missionId: mission.missionId,
    });
    expect(history.getSnapshot()).toMatchObject({
      activeId: conversation.id,
      transcriptStatus: "loading",
      tracked: { missionId: mission.missionId, conversationId: conversation.id },
    });

    await history.start();
    expect(texts(history)).toEqual(["Resume me", ""]);

    nexus.complete(mission.missionId, "Resumed and done.");
    await history.pollTracked();
    expect(history.getSnapshot().entries[1]?.mission?.response).toBe("Resumed and done.");
    expect(nexus.transcript(conversation.id).at(-1)?.content).toBe("Resumed and done.");
  });

  it("falls back to a new conversation when the linked one is gone", async () => {
    const nexus = new FakeNexus();
    const history = new ConversationHistory(nexus, {
      conversationId: randomUUID(),
      missionId: randomUUID(),
    });

    await history.start();

    expect(history.getSnapshot()).toMatchObject({
      activeId: null,
      transcriptStatus: "ready",
      tracked: null,
      error: "The requested resource does not exist.",
    });
  });

  it("start() runs once, as React's development double mount calls it twice", async () => {
    const nexus = new FakeNexus();
    nexus.seed("Only");
    const history = new ConversationHistory(nexus);
    const counting = vi.spyOn(nexus, "conversations");

    await Promise.all([history.start(), history.start()]);

    expect(counting).toHaveBeenCalledTimes(1);
  });
});

describe("rename and delete", () => {
  it("renames at once, and puts the title back when the server refuses", async () => {
    const nexus = new FakeNexus();
    const alpha = nexus.seed("Alpha");
    const history = await started(nexus);

    const renaming = history.rename(alpha.id, "  Alpha, renamed  ");
    expect(history.getSnapshot().conversations[0]?.title).toBe("Alpha, renamed");
    expect(await renaming).toBe(true);
    expect(nexus.title(alpha.id)).toBe("Alpha, renamed");

    nexus.failNextRename = "Rename refused.";
    expect(await history.rename(alpha.id, "Never applied")).toBe(false);
    expect(history.getSnapshot().conversations[0]?.title).toBe("Alpha, renamed");
    expect(history.getSnapshot().listError).toBe("Rename refused.");

    // Blank or unchanged titles never reach the server.
    expect(await history.rename(alpha.id, "   ")).toBe(false);
    expect(await history.rename(alpha.id, "Alpha, renamed")).toBe(true);
    expect(nexus.renames).toHaveLength(2);
  });

  it("deletes the open conversation, resets the chat, and stops following its mission", async () => {
    const nexus = new FakeNexus();
    const beta = nexus.seed("Beta");
    const history = await started(nexus);
    await history.send("Doomed question");
    const doomed = history.getSnapshot().activeId ?? "";

    expect(await history.remove(doomed)).toBe(true);

    expect(nexus.exists(doomed)).toBe(false);
    expect(history.getSnapshot()).toMatchObject({
      activeId: null,
      entries: [],
      tracked: null,
      error: null,
    });
    expect(history.getSnapshot().conversations.map((item) => item.id)).toEqual([beta.id]);
  });

  it("drops a status read that was in flight when its conversation was deleted", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    await history.send("Doomed question");
    const doomed = history.getSnapshot().activeId ?? "";
    const missionId = history.getSnapshot().tracked?.missionId ?? "";

    const held = nexus.hold(`mission:${missionId}`);
    const polling = history.pollTracked();
    await history.remove(doomed);
    held.release();
    await polling;

    // The read fails — its conversation no longer exists — and nobody hears of it.
    expect(history.getSnapshot()).toMatchObject({ error: null, tracked: null });
  });

  it("keeps the conversation and its mission when the server refuses the deletion", async () => {
    const nexus = new FakeNexus();
    const history = await started(nexus);
    await history.send("Precious question");
    const kept = history.getSnapshot().activeId ?? "";
    const tracked = history.getSnapshot().tracked;
    vi.spyOn(nexus, "deleteConversation").mockRejectedValueOnce(new Error("Delete refused."));

    expect(await history.remove(kept)).toBe(false);

    expect(history.getSnapshot()).toMatchObject({
      activeId: kept,
      tracked,
      listError: "Delete refused.",
    });
    expect(history.getSnapshot().conversations.map((item) => item.id)).toContain(kept);
  });
});

describe("pure helpers", () => {
  it("titles a conversation with its first words, on one line", () => {
    expect(deriveConversationTitle("  Plan\nthe   release  ")).toBe("Plan the release");
    expect(deriveConversationTitle("   ")).toBe("New conversation");

    const long = deriveConversationTitle(
      "Investigate why the nightly backup job stopped uploading archives to the remote bucket",
    );
    expect(Array.from(long).length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
    expect(long).toBe("Investigate why the nightly backup job stopped uploading…");
  });

  it("never splits a character outside the basic plane", () => {
    // U+1D400 (mathematical bold A) is two UTF-16 units, as any astral character is.
    const title = deriveConversationTitle("\u{1D400}".repeat(80));
    expect(title).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(Array.from(title)).toHaveLength(60);
  });

  it("filters active conversations by title, ignoring case and accents", () => {
    const conversation = (title: string, status = "ACTIVE"): ConversationSummary => ({
      id: title,
      title,
      status,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const list = [
      conversation("Résumé du projet"),
      conversation("Budget"),
      conversation("Resume archive", "ARCHIVED"),
    ];

    expect(filterConversations(list, "").map((item) => item.title)).toEqual([
      "Résumé du projet",
      "Budget",
    ]);
    expect(filterConversations(list, "RESUME").map((item) => item.title)).toEqual([
      "Résumé du projet",
    ]);
  });

  it("groups by local calendar day, newest first, leaving empty groups out", () => {
    const now = new Date(2026, 10, 8, 15, 0);
    const at = (days: number, hour = 12) => new Date(2026, 10, 8 - days, hour, 0).toISOString();
    const conversation = (id: string, updatedAt: string): ConversationSummary => ({
      id,
      title: id,
      status: "ACTIVE",
      createdAt: updatedAt,
      updatedAt,
    });

    const groups = groupConversationsByRecency(
      [
        conversation("this morning", at(0, 8)),
        conversation("yesterday", at(1)),
        conversation("last week", at(5)),
        conversation("ancient", at(90)),
      ],
      now,
    );

    expect(groups.map(({ group, items }) => [group, items.map((item) => item.id)])).toEqual([
      ["today", ["this morning"]],
      ["yesterday", ["yesterday"]],
      ["week", ["last week"]],
      ["older", ["ancient"]],
    ]);
  });

  it("knows when a mission no longer needs following", () => {
    const mission: OrchestratedMission = {
      missionId: "m",
      title: "t",
      state: "running",
      profiles: [],
      completedTasks: 0,
      totalTasks: 1,
      response: null,
      error: null,
    };
    expect(isSettled(mission)).toBe(false);
    expect(isSettled({ ...mission, response: "Done." })).toBe(true);
    expect(isSettled({ ...mission, error: "Failed." })).toBe(true);
    expect(isSettled({ ...mission, state: "cancelled" })).toBe(true);
    expect(isSettled({ ...mission, state: "scheduled" })).toBe(true);
  });

  it("reads and writes the chat location in the link", () => {
    const conversationId = "0196f3a2-7c41-7d55-9a1e-3b2c4d5e6f70";
    const missionId = "33333333-3333-4333-8333-333333333333";

    expect(readChatLocation(`https://nexus.local/?conversation=${conversationId}#chat`)).toEqual({
      conversationId,
      missionId: null,
    });
    // Legacy links carried the mission in the hash.
    expect(readChatLocation(`https://nexus.local/#chat?mission=${missionId}`)).toEqual({
      conversationId: null,
      missionId,
    });
    expect(readChatLocation("https://nexus.local/?conversation=not-an-id#chat")).toEqual({
      conversationId: null,
      missionId: null,
    });

    const written = writeChatLocation(`https://nexus.local/?tab=1#chat?mission=${missionId}`, {
      conversationId,
      missionId: null,
    });
    expect(written).toBe(`https://nexus.local/?tab=1&conversation=${conversationId}#chat`);
    expect(writeChatLocation(written, { conversationId: null, missionId: null })).toBe(
      "https://nexus.local/?tab=1#chat",
    );
  });
});

describe("DashboardApi conversation routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  interface Recorded {
    method: string;
    path: string;
    search: string;
    body: unknown;
  }

  async function connect(
    respond: (request: Recorded) => { status: number; body: unknown },
  ): Promise<{ api: DashboardApi; requests: Recorded[] }> {
    const requests: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const reply = (status: number, body: unknown) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        if (url.pathname === "/api/v1/auth/login") {
          return reply(200, {
            data: {
              user: { id: "user-1", email: "user@test.org", role: "USER" },
              tokens: { accessToken: "access-for-test", refreshToken: "refresh-for-test" },
            },
          });
        }
        const request: Recorded = {
          method: init?.method ?? "GET",
          path: url.pathname,
          search: url.search,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        };
        requests.push(request);
        const { status, body } = respond(request);
        return reply(status, body);
      }),
    );
    const session = createSession("http://localhost:3000");
    await session.login("user@test.org", "test-password");
    return { api: new DashboardApi(session), requests };
  }

  const summary: ConversationSummary = {
    id: "0196f3a2-7c41-7d55-9a1e-3b2c4d5e6f70",
    title: "Budget",
    status: "ACTIVE",
    createdAt: "2026-11-08T09:00:00.000Z",
    updatedAt: "2026-11-08T09:00:00.000Z",
  };

  it("keeps the cursor of list responses", async () => {
    const { api, requests } = await connect(() => ({
      status: 200,
      body: { data: [summary], meta: { requestId: "r", nextCursor: summary.id, total: 31 } },
    }));

    const page = await api.conversations();
    const messages = await api.conversationMessages(summary.id, {
      order: "desc",
      limit: 50,
      cursor: "older",
    });

    expect(page).toEqual({ items: [summary], nextCursor: summary.id, total: 31 });
    expect(messages.nextCursor).toBe(summary.id);
    expect(requests.map(({ method, path, search }) => `${method} ${path}${search}`)).toEqual([
      "GET /api/v1/conversations?limit=30",
      `GET /api/v1/conversations/${summary.id}/messages?limit=50&cursor=older&order=desc`,
    ]);
  });

  it("reads, renames and deletes a conversation by id", async () => {
    const { api, requests } = await connect((request) => ({
      status: 200,
      body: {
        data: request.method === "DELETE" ? { deleted: true } : { ...summary, title: "Renamed" },
        meta: { requestId: "r" },
      },
    }));

    await api.conversation(summary.id);
    const renamed = await api.renameConversation(summary.id, "Renamed");
    const deleted = await api.deleteConversation(summary.id);

    expect(renamed.title).toBe("Renamed");
    expect(deleted).toEqual({ deleted: true });
    expect(requests).toEqual([
      { method: "GET", path: `/api/v1/conversations/${summary.id}`, search: "", body: undefined },
      {
        method: "PATCH",
        path: `/api/v1/conversations/${summary.id}`,
        search: "",
        body: { title: "Renamed" },
      },
      {
        method: "DELETE",
        path: `/api/v1/conversations/${summary.id}`,
        search: "",
        body: undefined,
      },
    ]);
  });

  it("names the conversation when dispatching and when reading the mission", async () => {
    const mission: OrchestratedMission = {
      missionId: "33333333-3333-4333-8333-333333333333",
      title: "NEXUS Mission",
      state: "pending",
      profiles: [],
      completedTasks: 0,
      totalTasks: 1,
      response: null,
      error: null,
    };
    const { api, requests } = await connect(() => ({
      status: 202,
      body: { data: mission, meta: { requestId: "r" } },
    }));

    await api.sendToNexus("Plan the release", { conversationId: summary.id });
    await api.nexusMission(mission.missionId, summary.id);
    await api.nexusMission(mission.missionId);

    expect(requests[0]?.body).toMatchObject({
      message: "Plan the release",
      conversationId: summary.id,
    });
    expect(requests.slice(1).map(({ path, search }) => `${path}${search}`)).toEqual([
      `/api/v1/orchestrator/missions/${mission.missionId}?conversationId=${summary.id}`,
      `/api/v1/orchestrator/missions/${mission.missionId}`,
    ]);
  });
});
