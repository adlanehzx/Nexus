import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/in-memory.js";
import { ContextAssembler } from "../src/context.js";
import { ShortTermContext } from "../src/short-term.js";
import type {
  ConversationHistoryPort,
  DeviceContextPort,
  TaskHistoryPort,
} from "../src/sources.js";

/**
 * Context assembly tests.
 *
 * Six layers converge without mixing: each retains its section and budget,
 * and none can starve the others.
 */

const USER_ID = "user-example";
const CONVERSATION = "conv-1";
const NOW = new Date("2026-09-03T10:00:00.000Z");

class FakeConversation implements ConversationHistoryPort {
  turns: { role: string; content: string; createdAt: Date }[] = [];

  recentTurns(): Promise<{ role: string; content: string; createdAt: Date }[]> {
    return Promise.resolve(this.turns);
  }
}

class FakeDevices implements DeviceContextPort {
  devices = [
    {
      id: "d1",
      name: "Portable Windows",
      role: "BOTH",
      status: "ONLINE",
      capabilities: ["terminal.execute"],
    },
  ];

  devicesFor(): Promise<typeof this.devices> {
    return Promise.resolve(this.devices);
  }
}

class FakeTasks implements TaskHistoryPort {
  tasks = [
    {
      id: "t1",
      title: "Run tests",
      status: "succeeded",
      completedAt: NOW,
      deviceName: "Portable Windows",
    },
  ];

  recentTasks(): Promise<typeof this.tasks> {
    return Promise.resolve(this.tasks);
  }
}

function makeAssembler(budget?: Parameters<typeof makeRaw>[0]) {
  return makeRaw(budget);
}

function makeRaw(budget?: Partial<ConstructorParameters<typeof ContextAssembler>[0]["budget"]>) {
  const memory = new InMemoryMemoryProvider({ now: () => NOW });
  const shortTerm = new ShortTermContext({ now: () => NOW });
  const conversation = new FakeConversation();
  const devices = new FakeDevices();
  const tasks = new FakeTasks();

  const assembler = new ContextAssembler({
    memory,
    shortTerm,
    conversation,
    devices,
    tasks,
    ...(budget === undefined ? {} : { budget }),
  });

  return { assembler, memory, shortTerm, conversation, devices, tasks };
}

function section(assembled: Awaited<ReturnType<ContextAssembler["assemble"]>>, name: string) {
  return assembled.sections.find((candidate) => candidate.name === name);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("layer separation", () => {
  it("each source has its own section", async () => {
    const { assembler, memory, shortTerm } = makeAssembler();

    await memory.store({
      userId: USER_ID,
      kind: "PROCEDURAL",
      content: "Always reply concisely",
      layer: "PREFERENCE",
    });
    await memory.store({ userId: USER_ID, kind: "SEMANTIC", content: "Lives in Lyon" });
    shortTerm.set(CONVERSATION, "current-file", "src/auth.ts");

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "where does Alex live",
    });

    expect(assembled.sections.map((s) => s.name)).toEqual([
      "preferences",
      "shortTerm",
      "longTerm",
      "devices",
      "tasks",
      "conversation",
    ]);
  });

  it("a preference is not mixed among memories", async () => {
    const { assembler, memory } = makeAssembler();

    await memory.store({
      userId: USER_ID,
      kind: "PROCEDURAL",
      content: "Always reply concisely",
      layer: "PREFERENCE",
    });

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "docker",
    });

    expect(section(assembled, "preferences")?.lines).toHaveLength(1);
    expect(section(assembled, "longTerm")?.lines).toEqual([]);
  });

  it("preferences are retrieved regardless of topic", async () => {
    const { assembler, memory } = makeAssembler();

    await memory.store({
      userId: USER_ID,
      kind: "PROCEDURAL",
      content: "Always reply concisely",
      layer: "PREFERENCE",
    });

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "what is the weather in Tokyo",
    });

    expect(section(assembled, "preferences")?.lines[0]).toContain("concisely");
  });

  it("memories depend on the query topic", async () => {
    const { assembler, memory } = makeAssembler();

    await memory.store({ userId: USER_ID, kind: "SEMANTIC", content: "Lives in Lyon" });
    await memory.store({ userId: USER_ID, kind: "SEMANTIC", content: "Prefers dark roast coffee" });

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "where he lives",
    });

    expect(section(assembled, "longTerm")?.lines).toEqual(["- Lives in Lyon"]);
  });

  it("flags inferred items versus user-declared items", async () => {
    const { assembler, memory } = makeAssembler();

    await memory.store({
      userId: USER_ID,
      kind: "SEMANTIC",
      content: "Works on NEXUS",
      origin: "AGENT",
    });

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "works",
    });

    expect(section(assembled, "longTerm")?.lines[0]).toContain("(inferred)");
  });
});

describe("budgets", () => {
  it("verbose conversation does not starve preferences", async () => {
    const { assembler, memory, conversation } = makeAssembler();

    await memory.store({
      userId: USER_ID,
      kind: "PROCEDURAL",
      content: "Always reply concisely",
      layer: "PREFERENCE",
    });
    conversation.turns = Array.from({ length: 200 }, (_, index) => ({
      role: "user",
      content: `Very verbose message number ${String(index)} `.repeat(10),
      createdAt: NOW,
    }));

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "docker",
    });

    expect(section(assembled, "preferences")?.lines[0]).toContain("concisely");
  });

  it("each section respects its ceiling", async () => {
    const { assembler, memory } = makeAssembler({ longTerm: 60 });

    for (let index = 0; index < 20; index += 1) {
      await memory.store({
        userId: USER_ID,
        kind: "SEMANTIC",
        content: `Memory record number ${String(index)} about train travel`,
      });
    }

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "train",
    });

    const longTerm = section(assembled, "longTerm");
    expect(longTerm?.chars).toBeLessThanOrEqual(60);
    expect(longTerm?.dropped).toBeGreaterThan(0);
  });

  it("splits strictly between lines, never mid-sentence", async () => {
    const { assembler, memory } = makeAssembler({ preferences: 40 });

    await memory.store({
      userId: USER_ID,
      kind: "PROCEDURAL",
      content: "Never delete a file without asking",
      layer: "PREFERENCE",
    });

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "x",
    });

    const lines = section(assembled, "preferences")?.lines ?? [];
    for (const line of lines) expect(line).toContain("without asking");
  });

  it("keeps most recent turns of conversation", async () => {
    const { assembler, conversation } = makeAssembler({ conversation: 60 });

    conversation.turns = [
      { role: "user", content: "very first message", createdAt: NOW },
      { role: "user", content: "middle message", createdAt: NOW },
      { role: "user", content: "very last message", createdAt: NOW },
    ];

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "x",
    });

    const lines = section(assembled, "conversation")?.lines ?? [];
    expect(lines.join("\n")).toContain("very last message");
    expect(lines.join("\n")).not.toContain("very first message");
  });

  it("returns turns in chronological order", async () => {
    const { assembler, conversation } = makeAssembler();

    conversation.turns = [
      { role: "user", content: "first", createdAt: NOW },
      { role: "assistant", content: "second", createdAt: NOW },
    ];

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "x",
    });

    expect(section(assembled, "conversation")?.lines).toEqual([
      "- user : first",
      "- assistant : second",
    ]);
  });
});

describe("user boundaries", () => {
  it("never assembles another user's context", async () => {
    const { assembler, memory } = makeAssembler();

    await memory.store({ userId: "other-user", kind: "SEMANTIC", content: "Secret of another" });

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "secret",
    });

    expect(assembled.text).not.toContain("Secret of another");
  });
});

describe("missing sources", () => {
  it("assembles without devices, tasks, or history", async () => {
    const memory = new InMemoryMemoryProvider({ now: () => NOW });
    await memory.store({ userId: USER_ID, kind: "SEMANTIC", content: "Lives in Lyon" });

    const assembled = await new ContextAssembler({ memory }).assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "lives",
    });

    expect(assembled.text).toContain("Lives in Lyon");
    expect(section(assembled, "devices")?.lines).toEqual([]);
  });

  it("produces no header for empty sections", async () => {
    const memory = new InMemoryMemoryProvider({ now: () => NOW });

    const assembled = await new ContextAssembler({ memory }).assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "nothing",
    });

    expect(assembled.text).toBe("");
    expect(assembled.chars).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("short-term context", () => {
  it("replaces a note with same key instead of stacking duplicates", async () => {
    const { assembler, shortTerm } = makeAssembler();

    shortTerm.set(CONVERSATION, "current-file", "src/auth.ts");
    shortTerm.set(CONVERSATION, "current-file", "src/memory.ts");

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "x",
    });

    expect(section(assembled, "shortTerm")?.lines).toEqual(["- current-file : src/memory.ts"]);
  });

  it("does not leak across conversations", async () => {
    const { assembler, shortTerm } = makeAssembler();

    shortTerm.set("other-conv", "current-file", "src/secret.ts");

    const assembled = await assembler.assemble({
      userId: USER_ID,
      conversationId: CONVERSATION,
      query: "x",
    });

    expect(section(assembled, "shortTerm")?.lines).toEqual([]);
  });

  it("expires with time", () => {
    let clock = NOW;
    const shortTerm = new ShortTermContext({ ttlMs: 1_000, now: () => clock });

    shortTerm.set(CONVERSATION, "current-file", "src/auth.ts");
    expect(shortTerm.list(CONVERSATION)).toHaveLength(1);

    clock = new Date(NOW.getTime() + 2_000);
    expect(shortTerm.list(CONVERSATION)).toEqual([]);
  });

  it("remains bounded", () => {
    const shortTerm = new ShortTermContext({ maxNotesPerConversation: 3, now: () => NOW });

    for (let index = 0; index < 10; index += 1) {
      shortTerm.set(CONVERSATION, `key-${String(index)}`, "val");
    }

    const notes = shortTerm.list(CONVERSATION);
    expect(notes).toHaveLength(3);
    expect(notes.map((note) => note.key)).toEqual(["key-7", "key-8", "key-9"]);
  });

  it("refreshing a note puts it at the back of the queue", () => {
    const shortTerm = new ShortTermContext({ maxNotesPerConversation: 2, now: () => NOW });

    shortTerm.set(CONVERSATION, "a", "1");
    shortTerm.set(CONVERSATION, "b", "1");
    shortTerm.set(CONVERSATION, "a", "2");
    shortTerm.set(CONVERSATION, "c", "1");

    expect(shortTerm.list(CONVERSATION).map((note) => note.key)).toEqual(["a", "c"]);
  });
});
