import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/in-memory.js";

/**
 * Memory provider tests.
 *
 * Core properties:
 *  - strict user boundaries without exception;
 *  - supersession lineage: updates record new timestamps while preserving history.
 */

const USER_ID = "user-example";
const OTHER_USER = "user-other";

function makeProvider(now = new Date("2026-09-03T10:00:00.000Z")) {
  let clock = now;
  return {
    provider: new InMemoryMemoryProvider({ now: () => clock }),
    advance: (days: number) => {
      clock = new Date(clock.getTime() + days * 86_400_000);
    },
  };
}

describe("store", () => {
  it("stores a memory with default values", async () => {
    const { provider } = makeProvider();

    const record = await provider.store({
      userId: USER_ID,
      kind: "SEMANTIC",
      content: "Alex prefers trains over planes",
    });

    expect(record.layer).toBe("LONG_TERM");
    expect(record.origin).toBe("USER");
    expect(record.sensitivity).toBe("ORDINARY");
    expect(record.supersededById).toBeNull();
    expect(record.validUntil).toBeNull();
  });

  it("distinguishes preferences from ordinary memories", async () => {
    const { provider } = makeProvider();

    await provider.store({
      userId: USER_ID,
      kind: "PROCEDURAL",
      content: "Always reply concisely",
      layer: "PREFERENCE",
    });
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "Lives in Lyon" });

    const preferences = await provider.search({
      userId: USER_ID,
      query: "",
      layers: ["PREFERENCE"],
    });

    expect(preferences).toHaveLength(1);
    expect(preferences[0]?.record.content).toBe("Always reply concisely");
  });

  it("records who originated the memory", async () => {
    const { provider } = makeProvider();

    const inferred = await provider.store({
      userId: USER_ID,
      kind: "SEMANTIC",
      content: "Probably works on NEXUS",
      origin: "AGENT",
    });

    expect(inferred.origin).toBe("AGENT");
  });
});

describe("search", () => {
  it("retrieves records matching term overlap", async () => {
    const { provider } = makeProvider();
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "Prefers the train" });
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "Likes dark roast coffee" });

    const hits = await provider.search({ userId: USER_ID, query: "train" });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.content).toBe("Prefers the train");
  });

  it("empty query traverses all records newest to oldest", async () => {
    const { provider, advance } = makeProvider();
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "First" });
    advance(1);
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "Second" });

    const hits = await provider.search({ userId: USER_ID, query: "" });

    expect(hits.map((hit) => hit.record.content)).toEqual(["Second", "First"]);
  });

  it("more recent records rank higher with equal relevance", async () => {
    const { provider, advance } = makeProvider();
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "Meeting on Monday" });
    advance(60);
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "Meeting on Tuesday" });

    const hits = await provider.search({ userId: USER_ID, query: "meeting" });

    expect(hits[0]?.record.content).toBe("Meeting on Tuesday");
  });

  it("filters by memory kind", async () => {
    const { provider } = makeProvider();
    await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "Lives in Lyon" });
    await provider.store({ userId: USER_ID, kind: "EPISODIC", content: "Visited Lyon in May" });

    const hits = await provider.search({ userId: USER_ID, query: "lyon", kinds: ["EPISODIC"] });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.kind).toBe("EPISODIC");
  });

  it("respects limit", async () => {
    const { provider } = makeProvider();
    for (let index = 0; index < 10; index += 1) {
      await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: `Note ${String(index)}` });
    }

    expect(await provider.search({ userId: USER_ID, query: "note", limit: 3 })).toHaveLength(3);
  });
});

describe("update", () => {
  it("updating content supersedes rather than overwriting", async () => {
    const { provider } = makeProvider();
    const old = await provider.store({
      userId: USER_ID,
      kind: "SEMANTIC",
      content: "Lives in Lyon",
    });

    const updated = await provider.update({
      userId: USER_ID,
      id: old.id,
      content: "Lives in Paris",
    });

    expect(updated?.content).toBe("Lives in Paris");
    expect(updated?.supersedesId).toBe(old.id);
    expect(updated?.id).not.toBe(old.id);
  });

  it("superseded facts are excluded from normal search but remain queryable", async () => {
    const { provider } = makeProvider();
    const old = await provider.store({
      userId: USER_ID,
      kind: "SEMANTIC",
      content: "Lives in Lyon",
    });
    await provider.update({ userId: USER_ID, id: old.id, content: "Lives in Paris" });

    const current = await provider.search({ userId: USER_ID, query: "lives" });
    expect(current.map((hit) => hit.record.content)).toEqual(["Lives in Paris"]);

    const history = await provider.search({
      userId: USER_ID,
      query: "lives",
      includeSuperseded: true,
    });
    expect(history.map((hit) => hit.record.content).sort()).toEqual([
      "Lives in Lyon",
      "Lives in Paris",
    ]);
  });

  it("correcting metadata applies in-place", async () => {
    const { provider } = makeProvider();
    const record = await provider.store({
      userId: USER_ID,
      kind: "SEMANTIC",
      content: "Prefers the train",
    });

    const patched = await provider.update({
      userId: USER_ID,
      id: record.id,
      importance: 0.95,
      tags: ["transport"],
    });

    expect(patched?.id).toBe(record.id);
    expect(patched?.importance).toBe(0.95);
    expect(patched?.tags).toEqual(["transport"]);
    expect(patched?.supersedesId).toBeNull();
  });

  it("writing identical content does not supersede", async () => {
    const { provider } = makeProvider();
    const record = await provider.store({
      userId: USER_ID,
      kind: "SEMANTIC",
      content: "Prefers the train",
    });

    const patched = await provider.update({
      userId: USER_ID,
      id: record.id,
      content: "Prefers the train",
    });

    expect(patched?.id).toBe(record.id);
  });

  it("returns undefined for unknown id", async () => {
    const { provider } = makeProvider();
    expect(
      await provider.update({ userId: USER_ID, id: "nonexistent", content: "x" }),
    ).toBeUndefined();
  });
});

describe("delete", () => {
  it("deletes a memory record", async () => {
    const { provider } = makeProvider();
    const record = await provider.store({ userId: USER_ID, kind: "SEMANTIC", content: "To forget" });

    expect(await provider.delete({ userId: USER_ID, id: record.id })).toBe(true);
    expect(await provider.search({ userId: USER_ID, query: "forget" })).toEqual([]);
  });

  it("returns false for unknown id", async () => {
    const { provider } = makeProvider();
    expect(await provider.delete({ userId: USER_ID, id: "nonexistent" })).toBe(false);
  });
});

describe("user boundaries", () => {
  it("search never crosses user boundaries", async () => {
    const { provider } = makeProvider();
    await provider.store({ userId: OTHER_USER, kind: "SEMANTIC", content: "Secret of another" });

    expect(await provider.search({ userId: USER_ID, query: "secret" })).toEqual([]);
    expect(await provider.search({ userId: USER_ID, query: "" })).toEqual([]);
  });

  it("guessed id does not grant access to another user's memory", async () => {
    const { provider } = makeProvider();
    const record = await provider.store({
      userId: OTHER_USER,
      kind: "SEMANTIC",
      content: "Secret of another",
    });

    expect(
      await provider.update({ userId: USER_ID, id: record.id, content: "hijacked" }),
    ).toBeUndefined();
    expect(await provider.delete({ userId: USER_ID, id: record.id })).toBe(false);

    const intact = await provider.search({ userId: OTHER_USER, query: "secret" });
    expect(intact[0]?.record.content).toBe("Secret of another");
  });
});

describe("summarize", () => {
  it("splits between sentences, not mid-sentence", async () => {
    const { provider } = makeProvider();

    const summary = await provider.summarize({
      userId: USER_ID,
      text: "First sentence. Second sentence. Third sentence.",
      maxChars: 35,
    });

    expect(summary).toBe("First sentence. Second sentence.");
  });

  it("returns truncated text when no complete sentence fits", async () => {
    const { provider } = makeProvider();

    const summary = await provider.summarize({
      userId: USER_ID,
      text: "A very long sentence without any punctuation whatsoever",
      maxChars: 20,
    });

    expect(summary).toHaveLength(20);
  });
});
