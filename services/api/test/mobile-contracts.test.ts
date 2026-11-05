import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

/** Contracts the mobile app depends on: docs in apps/mobile/docs/BACKEND-GAPS.md. */
describe("mobile API contracts", () => {
  let harness: ApiHarness;
  let owner: Account;
  let other: Account;

  beforeAll(async () => {
    harness = await makeApi();
    owner = await createAccount(harness, "contracts-owner@example.test");
    other = await createAccount(harness, "contracts-other@example.test");
  });

  afterAll(async () => {
    await harness.close();
  });

  const get = (account: Account, url: string) =>
    harness.app.inject({ method: "GET", url, headers: account.authorization });

  describe("GET /confirmations?status=pending", () => {
    it("lists only the caller's live confirmations", async () => {
      const requestFor = (userId: string, runId: string) =>
        harness.app.services.confirmations.request({
          runId,
          userId,
          tool: "terminal.execute",
          toolCallId: `call-${runId}`,
          action: "run a command",
          description: "ls",
          riskLevel: "HIGH",
          payload: { command: "ls" },
        });
      const mine = await requestFor(owner.userId, "run-mine");
      const decided = await requestFor(owner.userId, "run-decided");
      await harness.app.services.confirmations.resolve(decided.id, "rejected");
      const theirs = await requestFor(other.userId, "run-theirs");

      const response = await get(owner, "/api/v1/confirmations?status=pending");
      expect(response.statusCode).toBe(200);
      const { data } = response.json<{ data: Record<string, unknown>[] }>();
      expect(data.map((entry) => entry.id)).toEqual([mine.id]);
      expect(data[0]).toMatchObject({
        taskId: "run-mine",
        capability: "terminal.execute",
        action: "run a command",
        description: "ls",
        riskLevel: "HIGH",
      });
      expect(data[0]).toHaveProperty("expiresAt");
      expect(JSON.stringify(data)).not.toContain(theirs.id);
      expect(JSON.stringify(data)).not.toContain("payloadHash");
    });

    it("requires a session", async () => {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/v1/confirmations?status=pending",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /conversations/:id/messages?order=desc", () => {
    it("pages from the newest message with the same cursor semantics", async () => {
      const conversation = await harness.app.services.conversations.create({
        userId: owner.userId,
        title: "order test",
      });
      for (const content of ["one", "two", "three"]) {
        await harness.app.services.conversations.appendMessage({
          conversationId: conversation.id,
          role: "user",
          content,
          originClientDeviceId: null,
        });
      }
      const url = `/api/v1/conversations/${conversation.id}/messages`;
      type Page = {
        data: { content: string }[];
        meta: { nextCursor: string | null; total: number };
      };

      const first = (await get(owner, `${url}?order=desc&limit=2`)).json<Page>();
      expect(first.data.map((m) => m.content)).toEqual(["three", "two"]);
      expect(first.meta.total).toBe(3);

      const second = (
        await get(owner, `${url}?order=desc&limit=2&cursor=${String(first.meta.nextCursor)}`)
      ).json<Page>();
      expect(second.data.map((m) => m.content)).toEqual(["one"]);
      expect(second.meta.nextCursor).toBeNull();

      // Unchanged without the parameter.
      const ascending = (await get(owner, url)).json<Page>();
      expect(ascending.data.map((m) => m.content)).toEqual(["one", "two", "three"]);
    });
  });

  describe("user-scoped lists", () => {
    it("opens tasks and runs to any account, without an administrator role", async () => {
      expect((await get(other, "/api/v1/dashboard/tasks")).statusCode).toBe(403);

      const tasks = await get(other, "/api/v1/tasks");
      expect(tasks.statusCode).toBe(200);
      expect(tasks.json<{ data: { tasks: unknown[] } }>().data.tasks).toEqual([]);

      const runs = await get(other, "/api/v1/agent-core/runs");
      expect(runs.statusCode).toBe(200);
      expect(runs.json<{ data: { runs: unknown[] } }>().data.runs).toEqual([]);
    });
  });

  describe("no engine configured", () => {
    it("answers 503, not 500", async () => {
      const message = await harness.app.inject({
        method: "POST",
        url: "/api/v1/orchestrator/messages",
        headers: owner.authorization,
        payload: { message: "hello" },
      });
      expect(message.statusCode).toBe(503);
      expect(message.json<{ error: { code: string } }>().error.code).toBe("DEPENDENCY_UNAVAILABLE");

      const instruct = await harness.app.inject({
        method: "POST",
        url: "/api/v1/tasks/instruct",
        headers: owner.authorization,
        payload: { instruction: "hello", originClientDeviceId: "any-device" },
      });
      expect(instruct.statusCode).toBe(503);
    });
  });
});
