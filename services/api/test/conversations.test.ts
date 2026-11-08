import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";
import { InMemoryConversationStore } from "../src/services/stores.js";

/**
 * Conversation lifecycle: rename and delete.
 *
 * Both are writes on a resource that belongs to one user, so each is checked
 * twice — that it works for the owner, and that it is refused to anyone else
 * without revealing whether the conversation exists.
 */

let harness: ApiHarness;
let owner: Account;

beforeEach(async () => {
  harness = await makeApi();
  owner = await createAccount(harness, "owner@example.test");
});

afterEach(async () => {
  await harness.close();
});

interface ConversationBody {
  data: { id: string; title: string; status: string; updatedAt: string };
}

async function createConversation(account: Account, title = "Quarterly review") {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/conversations",
    headers: account.authorization,
    payload: { title },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ConversationBody>().data;
}

describe("PATCH /conversations/:id", () => {
  it("renames the conversation, trimming the title", async () => {
    const conversation = await createConversation(owner);

    const renamed = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: owner.authorization,
      payload: { title: "  Budget planning  " },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<ConversationBody>().data).toMatchObject({
      id: conversation.id,
      title: "Budget planning",
      status: "ACTIVE",
    });

    const read = await harness.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: owner.authorization,
    });
    expect(read.json<ConversationBody>().data.title).toBe("Budget planning");
  });

  it.each([
    ["an empty title", ""],
    ["a title of spaces", "    "],
    ["a title over 200 characters", "x".repeat(201)],
  ])("rejects %s", async (_label, title) => {
    const conversation = await createConversation(owner);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: owner.authorization,
      payload: { title },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses another user's conversation and leaves it untouched", async () => {
    const conversation = await createConversation(owner, "Private");
    const intruder = await createAccount(harness, "intruder@example.test");

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: intruder.authorization,
      payload: { title: "Taken over" },
    });

    expect(response.statusCode).toBe(403);
    expect((await harness.services.conversations.get(conversation.id))?.title).toBe("Private");
  });

  it("answers 404 for an unknown conversation", async () => {
    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${randomUUID()}`,
      headers: owner.authorization,
      payload: { title: "Anything" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const conversation = await createConversation(owner);
    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversation.id}`,
      payload: { title: "Anonymous" },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("DELETE /conversations/:id", () => {
  it("removes the conversation, its transcript, and its working notes", async () => {
    const conversation = await createConversation(owner);
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.id}/messages`,
      headers: owner.authorization,
      payload: { content: "Remember the deadline is Friday." },
    });
    harness.services.shortTerm.set(conversation.id, "deadline", "Friday");

    const deleted = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: owner.authorization,
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<{ data: { deleted: boolean } }>().data).toEqual({ deleted: true });

    const read = await harness.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: owner.authorization,
    });
    expect(read.statusCode).toBe(404);

    const messages = await harness.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversation.id}/messages`,
      headers: owner.authorization,
    });
    expect(messages.statusCode).toBe(404);

    const list = await harness.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: owner.authorization,
    });
    expect(list.json<{ data: { id: string }[] }>().data.map((item) => item.id)).not.toContain(
      conversation.id,
    );
    expect(harness.services.shortTerm.list(conversation.id)).toEqual([]);
  });

  it("refuses another user's conversation and keeps it", async () => {
    const conversation = await createConversation(owner, "Private");
    const intruder = await createAccount(harness, "intruder@example.test");

    const response = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: intruder.authorization,
    });

    expect(response.statusCode).toBe(403);
    expect(await harness.services.conversations.get(conversation.id)).toBeDefined();
  });

  it("answers 404 once the conversation is gone", async () => {
    const conversation = await createConversation(owner);
    const first = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: owner.authorization,
    });
    expect(first.statusCode).toBe(200);

    const second = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversation.id}`,
      headers: owner.authorization,
    });
    expect(second.statusCode).toBe(404);
  });
});

describe("InMemoryConversationStore", () => {
  it("appends a message under a chosen id at most once", async () => {
    const store = new InMemoryConversationStore();
    const conversation = await store.create({ userId: "user-1", title: "Replies" });
    const reply = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: "assistant" as const,
      content: "Done.",
      originClientDeviceId: null,
    };

    const [first, second] = await Promise.all([
      store.appendMessageOnce(reply),
      store.appendMessageOnce(reply),
    ]);

    expect([first, second].filter((message) => message !== undefined)).toHaveLength(1);
    const page = await store.listMessages(conversation.id, { limit: 10 });
    expect(page.items.map((message) => message.id)).toEqual([reply.id]);
  });

  it("orders a renamed conversation as recently updated", async () => {
    let now = 1_000;
    const store = new InMemoryConversationStore(() => new Date((now += 1_000)));
    const older = await store.create({ userId: "user-1", title: "Older" });
    await store.create({ userId: "user-1", title: "Newer" });

    await store.rename(older.id, "Older, renamed");

    const page = await store.listByUser("user-1", { limit: 10 });
    expect(page.items.map((conversation) => conversation.title)).toEqual([
      "Older, renamed",
      "Newer",
    ]);
  });
});
