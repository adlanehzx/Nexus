import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import { createAccount, makeApi, type ApiHarness } from "./harness.js";

describe("Agent Core HTTP", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  it("executes a response, persists the run and transcript", async () => {
    const llm = new ScriptedLLMProvider([
      { kind: "final", text: "Effective Agent Core response." },
    ]);
    harness = await makeApi({
      llmProvider: llm,
    });
    const account = await createAccount(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: account.authorization,
      payload: { title: "Agent Core" },
    });
    const conversationId = created.json<{ data: { id: string } }>().data.id;

    const executed = await harness.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/runs",
      headers: account.authorization,
      payload: { conversationId, message: "Reply now" },
    });

    expect(executed.statusCode).toBe(200);
    const body = executed.json<{ data: { runId: string; status: string; response: string } }>();
    expect(body.data.status).toBe("completed");
    expect(body.data.response).toBe("Effective Agent Core response.");
    const occurrences = llm.requests[0]?.messages.filter(
      (message) =>
        message.role === "user" &&
        message.content.some((block) => block.type === "text" && block.text === "Reply now"),
    );
    expect(occurrences).toHaveLength(1);

    const loaded = await harness.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/runs/${body.data.runId}`,
      headers: account.authorization,
    });
    expect(loaded.statusCode).toBe(200);

    const transcript = await harness.services.conversations.listMessages(conversationId, {
      limit: 10,
    });
    expect(transcript.items.map((message) => [message.role, message.content])).toEqual([
      ["user", "Reply now"],
      ["assistant", "Effective Agent Core response."],
    ]);
  });
});

/**
 * Mission Engine -> Agent Core bridge.
 *
 * Verifies that the service surface rejects standard user tokens,
 * out-of-scope assertions, and foreign conversations.
 */
describe("Mission Engine to Agent Core bridge", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  const MISSION = "nexus-mission-under-test";

  async function setup(responses = ["Delegated work completed."]) {
    const llm = new ScriptedLLMProvider(
      responses.map((text) => ({ kind: "final" as const, text })),
    );
    harness = await makeApi({ llmProvider: llm });
    const account = await createAccount(harness);
    const grant = await harness.services.missionGrants.issue({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });
    return { account, grant, harness };
  }

  it("executes a run on behalf of the owner and opens a conversation", async () => {
    const { account, grant, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: MISSION,
        taskKey: "delegated",
        instruction: "Tidy my emails",
      },
    });

    expect(executed.statusCode).toBe(200);
    const body = executed.json<{ data: { conversationId: string; response: string } }>();
    expect(body.data.response).toBe("Delegated work completed.");

    const conversation = await api.services.conversations.get(body.data.conversationId);
    expect(conversation?.userId).toBe(account.userId);
  });

  it("extends returned conversation instead of opening a second one", async () => {
    const { grant, harness: api } = await setup(["First attempt.", "Second attempt."]);

    const first = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { missionExternalKey: MISSION, taskKey: "delegated", instruction: "Try" },
    });
    const conversationId = first.json<{ data: { conversationId: string } }>().data.conversationId;

    const second = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: MISSION,
        taskKey: "delegated",
        instruction: "Retry",
        conversationId,
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { conversationId: string } }>().data.conversationId).toBe(
      conversationId,
    );
    const transcript = await api.services.conversations.listMessages(conversationId, { limit: 10 });
    expect(transcript.items).toHaveLength(4);
  });

  it("rejects assertion used for another mission", async () => {
    const { grant, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: "nexus-another-mission",
        taskKey: "delegated",
        instruction: "Tidy my emails",
      },
    });

    expect(executed.statusCode).toBe(403);
  });

  it("rejects user access token on service surface", async () => {
    const { account, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: account.authorization,
      payload: {
        missionExternalKey: MISSION,
        taskKey: "delegated",
        instruction: "Tidy my emails",
      },
    });

    expect(executed.statusCode).toBe(401);
  });

  it("rejects assertion on user surface", async () => {
    const { grant, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { conversationId: randomUUID(), message: "Tidy my emails" },
    });

    expect(executed.statusCode).toBe(401);
  });

  it("refuses to work in another account's conversation", async () => {
    const { grant, harness: api } = await setup();
    const other = await createAccount(api, "other@example.com");
    const foreign = await api.services.conversations.create({
      userId: other.userId,
      title: "Someone else's conversation",
    });

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: MISSION,
        taskKey: "delegated",
        instruction: "Tidy my emails",
        conversationId: foreign.id,
      },
    });

    expect(executed.statusCode).toBe(403);
  });
});

/**
 * Reading a mission run.
 *
 * Verifies that a mission grant only permits reading runs within its own mission.
 */
describe("reading a mission run", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  const MISSION = "nexus-mission-reading";

  async function setup() {
    const llm = new ScriptedLLMProvider([{ kind: "final", text: "Done." }]);
    harness = await makeApi({ llmProvider: llm });
    const account = await createAccount(harness);
    const grant = await harness.services.missionGrants.issue({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });
    return { account, grant, api: harness };
  }

  it("reads back run launched within its mission", async () => {
    const { grant, api } = await setup();
    const started = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { missionExternalKey: MISSION, taskKey: "t", instruction: "Act" },
    });
    const runId = started.json<{ data: { runId: string } }>().data.runId;

    const reread = await api.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/mission-runs/${runId}`,
      headers: { authorization: `Bearer ${grant.token}` },
    });

    expect(reread.statusCode).toBe(200);
    expect(reread.json<{ data: { runId: string } }>().data.runId).toBe(runId);
  });

  it("refuses to read back run launched by an individual", async () => {
    const { account, grant, api } = await setup();
    const created = await api.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: account.authorization,
      payload: { title: "Private conversation" },
    });
    const conversationId = created.json<{ data: { id: string } }>().data.id;
    const personal = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/runs",
      headers: account.authorization,
      payload: { conversationId, message: "Work" },
    });
    const runId = personal.json<{ data: { runId: string } }>().data.runId;

    const attempted = await api.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/mission-runs/${runId}`,
      headers: { authorization: `Bearer ${grant.token}` },
    });

    expect(attempted.statusCode).toBe(403);
  });

  it("rejects assertion issued for another mission", async () => {
    const { account, grant, api } = await setup();
    const started = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { missionExternalKey: MISSION, taskKey: "t", instruction: "Act" },
    });
    const runId = started.json<{ data: { runId: string } }>().data.runId;

    const other = await api.services.missionGrants.issue({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: "nexus-neighbor-mission",
    });
    const attempted = await api.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/mission-runs/${runId}`,
      headers: { authorization: `Bearer ${other.token}` },
    });

    expect(attempted.statusCode).toBe(403);
  });
});

/**
 * Mission run uniqueness per attempt.
 *
 * Prevents redundant tool executions when lease expires and another worker claims the task.
 */
describe("mission run uniqueness", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  const MISSION = "nexus-mission-uniqueness";

  async function setup(responses: string[]) {
    const llm = new ScriptedLLMProvider(
      responses.map((text) => ({ kind: "final" as const, text })),
    );
    harness = await makeApi({ llmProvider: llm });
    const account = await createAccount(harness);
    const grant = await harness.services.missionGrants.issue({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });
    return { account, grant, api: harness, llm };
  }

  const request = (api: ApiHarness, token: string, payload: Record<string, unknown>) =>
    api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${token}` },
      payload: { missionExternalKey: MISSION, taskKey: "delegated", ...payload },
    });

  it("returns the same run for a repeated attempt without calling model again", async () => {
    const { grant, api, llm } = await setup(["Unique work."]);

    const first = await request(api, grant.token, {
      instruction: "Tidy my emails",
      attemptId: "attempt-1",
    });
    const second = await request(api, grant.token, {
      instruction: "Tidy my emails",
      attemptId: "attempt-1",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstRun = first.json<{ data: { runId: string } }>().data.runId;
    const secondRun = second.json<{ data: { runId: string } }>().data.runId;
    expect(secondRun).toBe(firstRun);

    expect(llm.requests).toHaveLength(1);
  });

  it("launches a fresh run for a different attempt", async () => {
    const { grant, api, llm } = await setup(["First attempt.", "Second attempt."]);

    const first = await request(api, grant.token, {
      instruction: "Tidy my emails",
      attemptId: "attempt-1",
    });
    const second = await request(api, grant.token, {
      instruction: "Tidy my emails",
      attemptId: "attempt-2",
    });

    const firstRun = first.json<{ data: { runId: string } }>().data.runId;
    const secondRun = second.json<{ data: { runId: string } }>().data.runId;
    expect(secondRun).not.toBe(firstRun);
    expect(llm.requests).toHaveLength(2);
  });

  it("claims run under the identifier it will actually hold", async () => {
    const { grant, api } = await setup(["Unique work."]);

    const response = await request(api, grant.token, {
      instruction: "Tidy my emails",
      attemptId: "attempt-1",
    });
    const runId = response.json<{ data: { runId: string } }>().data.runId;

    const claim = await api.services.agentRunClaims.find({
      missionExternalKey: MISSION,
      taskKey: "delegated",
      attemptId: "attempt-1",
    });
    expect(claim?.runId).toBe(runId);
  });

  it("isolates claims by task and mission", async () => {
    const { account, grant, api, llm } = await setup(["A.", "B."]);

    await request(api, grant.token, {
      instruction: "Task A",
      taskKey: "task-a",
      attemptId: "attempt-1",
    });
    await request(api, grant.token, {
      instruction: "Task B",
      taskKey: "task-b",
      attemptId: "attempt-1",
    });

    expect(llm.requests).toHaveLength(2);
    expect(account.userId).toBeDefined();
  });

  it("does not require an attempt but then guarantees nothing", async () => {
    const { grant, api, llm } = await setup(["Without attempt.", "Again."]);

    const first = await request(api, grant.token, { instruction: "Tidy my emails" });
    const second = await request(api, grant.token, { instruction: "Tidy my emails" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { runId: string } }>().data.runId).not.toBe(
      first.json<{ data: { runId: string } }>().data.runId,
    );
    expect(llm.requests).toHaveLength(2);
  });
});

/**
 * Assertion registry on the HTTP bridge surface.
 */
describe("assertion registry on bridge surface", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  const MISSION = "nexus-mission-registry";

  async function setup() {
    const llm = new ScriptedLLMProvider([
      { kind: "final", text: "Done." },
      { kind: "final", text: "Again." },
    ]);
    harness = await makeApi({ llmProvider: llm });
    const account = await createAccount(harness);
    const granted = await harness.services.missionGrants.issue({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });
    return { account, granted, api: harness };
  }

  const run = (api: ApiHarness, token: string, attemptId: string) =>
    api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        missionExternalKey: MISSION,
        taskKey: "delegated",
        instruction: "Act",
        attemptId,
      },
    });

  it("accepts assertion registered in the registry", async () => {
    const { granted, api } = await setup();
    expect((await run(api, granted.token, "attempt-1")).statusCode).toBe(200);
  });

  it("rejects signed assertion never registered", async () => {
    const { account, api } = await setup();
    const orphan = api.services.tokens.issueMissionGrant({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });

    expect((await run(api, orphan.token, "attempt-1")).statusCode).toBe(403);
  });

  it("rejects retired assertion without awaiting expiration", async () => {
    const { granted, api } = await setup();
    expect((await run(api, granted.token, "attempt-1")).statusCode).toBe(200);

    await api.services.missionGrants.retire(MISSION);

    expect((await run(api, granted.token, "attempt-2")).statusCode).toBe(403);
  });

  it("retires assertions via its own route upon presenting one", async () => {
    const { granted, api } = await setup();

    const retired = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-grants/retire",
      headers: { authorization: `Bearer ${granted.token}` },
      payload: { missionExternalKey: MISSION, reason: "completed" },
    });

    expect(retired.statusCode).toBe(200);
    expect(retired.json<{ data: { retired: number } }>().data.retired).toBe(1);
    expect((await run(api, granted.token, "attempt-1")).statusCode).toBe(403);
  });

  it("refuses to retire assertions of another mission", async () => {
    const { granted, api } = await setup();

    const attempted = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-grants/retire",
      headers: { authorization: `Bearer ${granted.token}` },
      payload: { missionExternalKey: "nexus-neighbor-mission", reason: "revoked" },
    });

    expect(attempted.statusCode).toBe(403);
  });
});
