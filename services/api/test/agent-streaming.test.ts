import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import { CLIENT_HELLO, clientEnvelope } from "@nexus/protocol";
import { AgentRealtimeBridge } from "../src/services/agent-realtime.js";
import {
  createAccount,
  makeApi,
  registerDevice,
  type Account,
  type ApiHarness,
} from "./harness.js";

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}

/** A real client socket, past its handshake, recording what it receives. */
async function connectClient(harness: ApiHarness, address: string, account: Account) {
  const { device } = await registerDevice(harness, account, {
    name: "phone",
    role: "BOTH",
    type: "ANDROID",
    platform: "ANDROID",
    trust: true,
  });
  const socket = new WebSocket(`${address.replace("http", "ws")}/ws/client`);
  const frames: Frame[] = [];
  socket.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString("utf8")) as Frame);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify(
      clientEnvelope(
        CLIENT_HELLO as never,
        { accessToken: account.accessToken, deviceId: device.id } as never,
        { id: "hello-1", at: new Date() },
      ),
    ),
  );
  await expect.poll(() => harness.app.services.router.isConnected(device.id)).toBe(true);
  return { socket, frames };
}

describe("reply streaming", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  it("streams to the owner under the id history later returns, and to nobody else", async () => {
    harness = await makeApi({
      llmProvider: new ScriptedLLMProvider([{ kind: "final", text: "Hello from the stream." }]),
    });
    const address = await harness.app.listen({ host: "127.0.0.1", port: 0 });
    const owner = await createAccount(harness, "stream-owner@example.test");
    const other = await createAccount(harness, "stream-other@example.test");
    const mine = await connectClient(harness, address, owner);
    const theirs = await connectClient(harness, address, other);

    const conversation = await harness.app.services.conversations.create({
      userId: owner.userId,
      title: "stream",
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/runs",
      headers: owner.authorization,
      payload: { conversationId: conversation.id, message: "hi" },
    });
    expect(response.statusCode).toBe(200);

    const deltas = () => mine.frames.filter((frame) => frame.type === "message.delta");
    await expect.poll(() => deltas().some((frame) => frame.payload.done === true)).toBe(true);

    const text = deltas()
      .map((frame) => frame.payload.delta)
      .join("");
    expect(text).toBe("Hello from the stream.");
    const ids = new Set(deltas().map((frame) => frame.payload.messageId));
    expect(ids.size).toBe(1);
    expect(deltas()[0]?.payload.conversationId).toBe(conversation.id);
    expect(deltas().at(-1)?.payload.done).toBe(true);

    const history = await harness.app.services.conversations.listMessages(conversation.id, {
      limit: 10,
    });
    const assistant = history.items.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Hello from the stream.");
    expect(ids.has(assistant?.id)).toBe(true);

    expect(theirs.frames.filter((frame) => frame.type === "message.delta")).toEqual([]);
    mine.socket.close();
    theirs.socket.close();
  });
});

describe("AgentRealtimeBridge", () => {
  it("maps tool events to the client contract without exposing arguments", async () => {
    const emitted: { type: string; userId: string; payload: Record<string, unknown> }[] = [];
    const bridge = new AgentRealtimeBridge({
      router: {
        emit: (input: (typeof emitted)[number]) => {
          emitted.push(input);
          return Promise.resolve();
        },
      } as never,
      store: {
        load: () =>
          Promise.resolve({
            record: { userId: "owner", conversationId: "conversation", correlationId: "c" },
          }),
      } as never,
    });
    const at = new Date().toISOString();

    bridge.handle({
      type: "tool.started",
      runId: "run",
      toolCallId: "call",
      name: "web.search",
      riskLevel: "LOW",
      input: { query: "private" },
      at,
    });
    bridge.handle({
      type: "tool.progress",
      runId: "run",
      toolCallId: "call",
      name: "web.search",
      pct: 41.6,
      label: undefined,
      at,
    });
    bridge.handle({
      type: "tool.completed",
      runId: "run",
      toolCallId: "call",
      name: "web.search",
      ok: true,
      durationMs: 12,
      attempts: 1,
      summary: "3 results",
      at,
    });
    await bridge.flushed();

    expect(emitted.map((event) => event.type)).toEqual([
      "tool.started",
      "tool.progress",
      "tool.completed",
    ]);
    expect(emitted.every((event) => event.userId === "owner")).toBe(true);
    expect(emitted[1]?.payload).toMatchObject({ percent: 42, label: null });
    expect(emitted[2]?.payload).toMatchObject({ ok: true, summary: "3 results", durationMs: 12 });
    expect(JSON.stringify(emitted)).not.toContain("private");
  });
});
