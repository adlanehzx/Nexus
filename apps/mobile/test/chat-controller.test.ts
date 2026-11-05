import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiMessage } from "@nexus/client-core";
import {
  ChatController,
  toMessageViews,
  type ChatControllerOptions,
} from "../lib/chat-controller.js";
import type { MobileAction } from "../lib/chat-state.js";
import type { AgentRunResult } from "../lib/api-types.js";
import { ApiError } from "../lib/errors.js";

const run = (over: Partial<AgentRunResult> = {}): AgentRunResult => ({
  runId: "run-1",
  conversationId: "c1",
  status: "succeeded",
  stopReason: "end",
  response: "Done.",
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "model-a",
  confirmation: null,
  ...over,
});

const apiMessage = (over: Partial<ApiMessage>): ApiMessage => ({
  id: "m1",
  conversationId: "c1",
  role: "USER",
  content: "hi",
  originClientDeviceId: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  ...over,
});

function setup(overrides: Partial<ChatControllerOptions["mobile"]> = {}) {
  const actions: MobileAction[] = [];
  const replies: string[] = [];
  const mobile = {
    createConversation: vi.fn(() =>
      Promise.resolve({ id: "c1", title: "", status: "ACTIVE", createdAt: "", updatedAt: "" }),
    ),
    listAllMessages: vi.fn(() =>
      Promise.resolve({ items: [apiMessage({})] as never[], truncated: false }),
    ),
    runAgent: vi.fn(() => Promise.resolve(run())),
    answerRunConfirmation: vi.fn(() => Promise.resolve(run())),
    cancelRun: vi.fn(() => Promise.resolve(true)),
    listRuns: vi.fn(() => Promise.resolve([])),
    submitMission: vi.fn(() =>
      Promise.resolve({
        missionId: "mission-1",
        title: "T",
        state: "running",
        profiles: [],
        completedTasks: 0,
        totalTasks: 1,
        response: null,
        error: null,
      }),
    ),
    ...overrides,
  };
  const api = { instruct: vi.fn(() => Promise.resolve({})) };
  const realtime = {
    sendMessage: vi.fn(() => Promise.resolve({ conversationId: "c9", messageId: "m" })),
  };
  const controller = new ChatController({
    mobile: mobile,
    api: api as unknown as ChatControllerOptions["api"],
    realtime: realtime,
    session: { deviceId: "device-1" },
    dispatch: (action) => {
      actions.push(action);
    },
    onChange: () => undefined,
    onReply: (text) => {
      replies.push(text);
    },
    now: () => new Date("2026-11-05T10:00:00.000Z"),
    timezone: () => "Europe/Paris",
    pollIntervalMs: 1,
  });
  return { controller, mobile, api, realtime, actions, replies };
}

describe("ChatController.send", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("chat: creates a conversation once, runs the agent, re-reads history, reads the reply", async () => {
    const { controller, mobile, actions, replies } = setup();

    await controller.send(" hello ", "chat");
    await controller.send("again", "chat");

    expect(mobile.createConversation).toHaveBeenCalledTimes(1);
    expect(mobile.runAgent).toHaveBeenNthCalledWith(1, "c1", "hello");
    expect(mobile.runAgent).toHaveBeenNthCalledWith(2, "c1", "again");
    expect(actions.some((action) => action.kind === "hydrateMessages")).toBe(true);
    expect(replies).toEqual(["Done.", "Done."]);
    expect(controller.state.running).toBe(false);
    expect(controller.state.lastModel).toBe("model-a");
  });

  it("ignores blank input", async () => {
    const { controller, actions } = setup();
    await controller.send("   ");
    expect(actions).toEqual([]);
  });

  it("chat: a paused run exposes its confirmation and is not read aloud", async () => {
    const { controller, replies } = setup({
      runAgent: vi.fn(() =>
        Promise.resolve(
          run({
            status: "waiting_for_confirmation",
            response: null,
            confirmation: { id: "conf", toolName: "mail.send", riskLevel: "HIGH", expiresAt: "x" },
          }),
        ),
      ),
    });

    await controller.send("email them", "chat");

    expect(controller.state.pendingConfirmation).toMatchObject({ runId: "run-1", id: "conf" });
    expect(replies).toEqual([]);
  });

  it("answering a confirmation resumes the run and clears it", async () => {
    const { controller, mobile, replies } = setup({
      runAgent: vi.fn(() =>
        Promise.resolve(
          run({
            response: null,
            confirmation: { id: "conf", toolName: "t", riskLevel: "HIGH", expiresAt: "x" },
          }),
        ),
      ),
    });
    await controller.send("go", "chat");
    await controller.answerConfirmation("approved");

    expect(mobile.answerRunConfirmation).toHaveBeenCalledWith("run-1", "approved", "conf");
    expect(controller.state.pendingConfirmation).toBeNull();
    expect(replies).toEqual(["Done."]);
  });

  it("restores the confirmation when the answer could not be delivered", async () => {
    const { controller } = setup({
      runAgent: vi.fn(() =>
        Promise.resolve(
          run({
            response: null,
            confirmation: { id: "conf", toolName: "t", riskLevel: "HIGH", expiresAt: "x" },
          }),
        ),
      ),
      answerRunConfirmation: vi.fn(() => Promise.reject(new ApiError(500, "nope"))),
    });
    await controller.send("go", "chat");
    await controller.answerConfirmation("approved");
    expect(controller.state.pendingConfirmation?.id).toBe("conf");
  });

  it("never resends after a network failure, and says the answer may still come", async () => {
    const { controller, mobile, actions } = setup({
      runAgent: vi.fn(() =>
        Promise.reject(Object.assign(new Error("gone"), { code: "CLIENT_REQUEST_BLOCKED" })),
      ),
    });

    await controller.send("buy the ticket", "chat");

    expect(mobile.runAgent).toHaveBeenCalledTimes(1);
    expect(controller.state.running).toBe(false);
    expect(actions).toContainEqual(expect.objectContaining({ code: "CHAT_ANSWER_DELAYED" }));
  });

  it("reports a refusal as an error, not as a delay", async () => {
    const { controller, actions } = setup({
      runAgent: vi.fn(() => Promise.reject(new ApiError(503, "No active LLM provider."))),
    });
    await controller.send("hi", "chat");
    expect(actions).toContainEqual(expect.objectContaining({ code: "CHAT_SEND_FAILED" }));
  });

  it("action: goes through the channel and the planner", async () => {
    const { controller, api, realtime } = setup();

    await controller.send("open chrome", "action");

    expect(realtime.sendMessage).toHaveBeenCalledWith({
      conversationId: null,
      text: "open chrome",
    });
    expect(api.instruct).toHaveBeenCalledWith({
      instruction: "open chrome",
      originClientDeviceId: "device-1",
      conversationId: "c9",
    });
    expect(controller.state.conversationId).toBe("c9");
  });

  it("mission: submits with the phone's timezone and lists the mission", async () => {
    const { controller, mobile } = setup();
    await controller.send("audit this", "mission");
    expect(mobile.submitMission).toHaveBeenCalledWith("audit this", "Europe/Paris");
    expect(controller.state.missions.map((mission) => mission.missionId)).toEqual(["mission-1"]);
  });

  it("finds the running run so it can be interrupted", async () => {
    let finish: (value: AgentRunResult) => void = () => undefined;
    const { controller, mobile } = setup({
      runAgent: vi.fn(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            finish = resolve;
          }),
      ),
      listRuns: vi.fn(() =>
        Promise.resolve([{ runId: "active", conversationId: "c1", status: "running" }] as never),
      ),
    });

    const sending = controller.send("long work", "chat");
    await vi.waitFor(() => {
      expect(controller.state.activeRunId).toBe("active");
    });

    expect(await controller.stop()).toBe(true);
    expect(mobile.cancelRun).toHaveBeenCalledWith("active");

    finish(run());
    await sending;
    expect(controller.state.activeRunId).toBeNull();
  });

  it("stops looking for the run when the account may not list runs", async () => {
    let finish: (value: AgentRunResult) => void = () => undefined;
    const { controller, mobile } = setup({
      runAgent: vi.fn(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            finish = resolve;
          }),
      ),
      listRuns: vi.fn(() => Promise.reject(new ApiError(403, "Admins only"))),
    });

    const sending = controller.send("work", "chat");
    await vi.waitFor(() => {
      expect(mobile.listRuns).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mobile.listRuns).toHaveBeenCalledTimes(1);

    finish(run());
    await sending;
  });
});

describe("ChatController conversations", () => {
  it("a late history response cannot overwrite a newer conversation", async () => {
    let release: (value: { items: never[]; truncated: boolean }) => void = () => undefined;
    const { controller, actions } = setup({
      listAllMessages: vi.fn(
        () =>
          new Promise<{ items: never[]; truncated: boolean }>((resolve) => {
            release = resolve;
          }),
      ),
    });

    const opening = controller.openConversation("old");
    controller.newConversation();
    release({ items: [], truncated: false });
    await opening;

    expect(actions.filter((action) => action.kind === "hydrateMessages")).toEqual([]);
    expect(controller.state.conversationId).toBeNull();
    expect(controller.state.loadingHistory).toBe(false);
  });

  it("reports a history failure and leaves the loading state", async () => {
    const { controller, actions } = setup({
      listAllMessages: vi.fn(() => Promise.reject(new ApiError(500, "boom"))),
    });
    await controller.openConversation("c1");
    expect(controller.state.loadingHistory).toBe(false);
    expect(actions).toContainEqual(expect.objectContaining({ code: "CHAT_HISTORY_UNAVAILABLE" }));
  });
});

describe("toMessageViews", () => {
  it("normalizes stored roles and hides internal ones", () => {
    const views = toMessageViews([
      apiMessage({ id: "a", role: "USER" }),
      apiMessage({ id: "b", role: "ASSISTANT" }),
      apiMessage({ id: "c", role: "SYSTEM" }),
    ]);
    expect(views.map((view) => [view.id, view.role])).toEqual([
      ["a", "user"],
      ["b", "assistant"],
    ]);
  });
});
