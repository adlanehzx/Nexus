import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

/**
 * Memory through the API.
 *
 * Verifies that the service is the sole route to memory storage,
 * and proves tenant isolation between accounts.
 */

let harness: ApiHarness;
let example: Account;
let other: Account;

beforeEach(async () => {
  harness = await makeApi();
  example = await createAccount(harness, "alex@example.test");
  other = await createAccount(harness, "other@example.com");
});

afterEach(async () => {
  await harness.close();
});

function store(account: Account, payload: Record<string, unknown>) {
  return harness.app.inject({
    method: "POST",
    url: "/api/v1/memory",
    headers: account.authorization,
    payload,
  });
}

async function storeOk(account: Account, content: string, extra: Record<string, unknown> = {}) {
  const response = await store(account, { content, ...extra });
  return response.json<{ data: { id: string; content: string } }>().data;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("store", () => {
  it("stores a memory", async () => {
    const response = await store(example, { content: "Alex prefers the train" });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ data: { content: string } }>().data.content).toBe(
      "Alex prefers the train",
    );
  });

  it("distinguishes a preference from a memory", async () => {
    await storeOk(example, "Always reply in concise English", { layer: "PREFERENCE" });
    await storeOk(example, "Lives in London");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory?layer=PREFERENCE",
      headers: example.authorization,
    });

    const data = response.json<{ data: { content: string }[] }>().data;
    expect(data.map((record) => record.content)).toEqual(["Always reply in concise English"]);
  });

  it("rejects a secret and explains why", async () => {
    const response = await store(example, { content: "My password is Tr0ub4dor3xy" });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("MEMORY_SENSITIVE_REFUSED");
    expect(body.error.message).toContain("password manager");
  });

  it("rejection does not echo the secret", async () => {
    const response = await store(example, { content: "My API key is sk-abcdefghijklmnopqrstuv" });

    expect(response.body).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("requires consent for personal data", async () => {
    const response = await store(example, { content: "I was diagnosed with diabetes" });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("MEMORY_CONSENT_REQUIRED");
  });

  it("accepts once consent is given and preserves it", async () => {
    const response = await store(example, {
      content: "I was diagnosed with diabetes",
      acknowledgedSensitive: true,
    });

    expect(response.statusCode).toBe(201);
    const data = response.json<{ data: { sensitivity: string; sensitiveCategories: string[] } }>()
      .data;
    expect(data.sensitivity).toBe("PERSONAL");
    expect(data.sensitiveCategories).toContain("sante");
  });

  it("consent is never implicit", async () => {
    const response = await store(example, { content: "My IBAN appears on the statement" });

    expect(response.statusCode).toBe(409);
  });
});

describe("search", () => {
  it("finds a memory by keyword", async () => {
    await storeOk(example, "Alex prefers the train");
    await storeOk(example, "Alex likes strong coffee");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=train",
      headers: example.authorization,
    });

    const hits = response.json<{ data: { hits: { content: string }[] } }>().data.hits;
    expect(hits.map((hit) => hit.content)).toEqual(["Alex prefers the train"]);
  });

  it("finds nothing belonging to another user", async () => {
    await storeOk(other, "Secret of the other user");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=secret",
      headers: example.authorization,
    });

    expect(response.json<{ data: { hits: unknown[] } }>().data.hits).toEqual([]);
  });
});

describe("update", () => {
  it("updating supersedes instead of overwriting", async () => {
    const record = await storeOk(example, "Lives in London");

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
      payload: { content: "Lives in Paris" },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json<{ data: { id: string; supersedesId: string | null } }>().data;
    expect(data.supersedesId).toBe(record.id);
    expect(data.id).not.toBe(record.id);
  });

  it("reclassifies revised content", async () => {
    const record = await storeOk(example, "An innocent note");

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
      payload: { content: "My password is Tr0ub4dor3xy" },
    });

    expect(response.statusCode).toBe(422);
  });

  it("does not modify someone else's memory", async () => {
    const record = await storeOk(other, "Memory of the other");

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
      payload: { content: "hijacked" },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("delete", () => {
  it("forgets a memory and returns what disappeared", async () => {
    const record = await storeOk(example, "Lives in London");

    const response = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ data: { forgotten: { content: string }[] } }>().data.forgotten[0]?.content,
    ).toBe("Lives in London");
  });

  it("does not delete another user's memory", async () => {
    const record = await storeOk(other, "Memory of the other");

    const response = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
    });

    expect(response.statusCode).toBe(404);

    const remaining = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory",
      headers: other.authorization,
    });
    expect(remaining.json<{ data: unknown[] }>().data).toHaveLength(1);
  });
});

describe("forget", () => {
  it("forgets by text match", async () => {
    await storeOk(example, "Lives in London");
    await storeOk(example, "Prefers strong coffee");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { match: "lives london" },
    });

    expect(response.json<{ data: { forgotten: unknown[] } }>().data.forgotten).toHaveLength(1);
  });

  it("returns candidates rather than guessing", async () => {
    await storeOk(example, "Team meeting on Monday");
    await storeOk(example, "Team meeting on Tuesday");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { match: "team meeting" },
    });

    const data = response.json<{ data: { forgotten: unknown[]; ambiguous: unknown[] } }>().data;
    expect(data.forgotten).toEqual([]);
    expect(data.ambiguous).toHaveLength(2);
  });

  it("requires confirmation to delete everything", async () => {
    await storeOk(example, "A memory");

    const withoutConf = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { all: true },
    });
    expect(withoutConf.json<{ data: { needsConfirmation: boolean } }>().data.needsConfirmation).toBe(true);

    const withConf = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { all: true, confirmed: true },
    });
    expect(withConf.json<{ data: { forgotten: unknown[] } }>().data.forgotten).toHaveLength(1);
  });

  it("'all' means 'all of mine'", async () => {
    await storeOk(example, "Alex's memory");
    await storeOk(other, "Memory of the other");

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { all: true, confirmed: true },
    });

    const remaining = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory",
      headers: other.authorization,
    });
    expect(remaining.json<{ data: unknown[] }>().data).toHaveLength(1);
  });
});

describe("explicit commands", () => {
  it("executes 'remember that...'", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "Remember that I prefer the train" },
    });

    const data = response.json<{
      data: { recognized: boolean; kind: string; stored: { content: string } | null };
    }>().data;

    expect(data.recognized).toBe(true);
    expect(data.kind).toBe("remember");
    expect(data.stored?.content).toBe("I prefer the train");
  });

  it("executes 'forget...'", async () => {
    await storeOk(example, "I live in London");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "Forget that I live in London" },
    });

    expect(response.json<{ data: { forgotten: unknown[] } }>().data.forgotten).toHaveLength(1);
  });

  it("dictated command undergoes same classification", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "Remember that my password is Tr0ub4dor3xy" },
    });

    expect(response.statusCode).toBe(422);
  });

  it("recognizes nothing in ordinary conversation", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "What is the weather in London?" },
    });

    expect(response.json<{ data: { recognized: boolean } }>().data.recognized).toBe(false);
  });
});

describe("authentication boundary", () => {
  it("rejects call without token", async () => {
    for (const [method, url, payload] of [
      ["GET", "/api/v1/memory", undefined],
      ["POST", "/api/v1/memory", { content: "something" }],
      ["POST", "/api/v1/memory/forget", { match: "something" }],
      ["POST", "/api/v1/memory/command", { text: "Remember that X" }],
      ["GET", "/api/v1/memory/search?q=x", undefined],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("context assembly", () => {
  it("connects the six layers without blending them", async () => {
    await storeOk(example, "Always reply in concise English", { layer: "PREFERENCE" });
    await storeOk(example, "Alex lives in London");

    const conversation = await harness.services.conversations.create({
      userId: example.userId,
      title: "Test",
    });
    await harness.services.conversations.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Hello NEXUS",
      originClientDeviceId: null,
    });

    harness.services.shortTerm.set(conversation.id, "current-file", "src/memory.ts");

    const assembled = await harness.services.context.assemble({
      userId: example.userId,
      conversationId: conversation.id,
      query: "where does Alex live in London",
    });

    expect(assembled.text).toContain("Always reply in concise English");
    expect(assembled.text).toContain("Alex lives in London");
    expect(assembled.text).toContain("src/memory.ts");
    expect(assembled.text).toContain("Hello NEXUS");

    const preferences = assembled.sections.find((s) => s.name === "preferences");
    expect(preferences?.lines.join()).toContain("concise English");
    expect(preferences?.lines.join()).not.toContain("London");
  });

  it("never assembles another user's context", async () => {
    await storeOk(other, "Secret of the other user");

    const assembled = await harness.services.context.assemble({
      userId: example.userId,
      conversationId: "unknown-conv",
      query: "secret",
    });

    expect(assembled.text).not.toContain("Secret of the other user");
  });

  it("does not read another user's conversation", async () => {
    const conversation = await harness.services.conversations.create({
      userId: other.userId,
      title: "Private",
    });
    await harness.services.conversations.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Confidential message",
      originClientDeviceId: null,
    });

    const assembled = await harness.services.context.assemble({
      userId: example.userId,
      conversationId: conversation.id,
      query: "what is new",
    });

    expect(assembled.text).not.toContain("Confidential message");
  });
});
