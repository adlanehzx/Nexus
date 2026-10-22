import { describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import { RealtimeClient } from "../src/realtime.js";
import { SessionManager } from "../src/session.js";
import { initialState, reduce, type ClientAction, type ClientState } from "../src/store.js";
import {
  FakeHttpClient,
  FakeNetwork,
  FakeSecureStorage,
  FakeSocket,
  TestTimers,
  loginResponse,
  settle,
  until,
} from "./fixtures.js";

/**
 * Real-time channel, client side.
 *
 * Mobile clients lose network connectivity continuously. Reconnection is normal operating
 * mode: dropping, returning, dropping again, without leaving open promises or hanging.
 */

interface Harness {
  client: RealtimeClient;
  socket: FakeSocket;
  network: FakeNetwork;
  timers: TestTimers;
  http: FakeHttpClient;
  session: SessionManager;
  state(): ClientState;
  actions: ClientAction[];
}

async function makeClient(options?: { withDevice?: boolean }): Promise<Harness> {
  const http = new FakeHttpClient();
  http.on("POST", "/api/v1/auth/login", loginResponse());
  http.on("POST", "/api/v1/auth/refresh", {
    status: 200,
    body: {
      data: { accessToken: "access-token-2", refreshToken: "refresh-token-2" },
    },
  });

  const session = new SessionManager({ http, storage: new FakeSecureStorage() });
  await session.login("alex@example.test", "a sufficient password");

  // Client channel announces where requests originate: without an attached device,
  // RealtimeClient refuses to open the socket.
  if (options?.withDevice !== false) await session.bindDevice("device-iphone");

  const socket = new FakeSocket();
  const network = new FakeNetwork();
  const timers = new TestTimers();

  let state = initialState;
  const actions: ClientAction[] = [];

  const client = new RealtimeClient({
    socket,
    session,
    url: "wss://nexus.test/ws/client",
    network,
    timers,
    random: () => 0.5,
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    dispatch: (action) => {
      actions.push(action);
      state = reduce(state, action);
    },
  });

  return { client, socket, network, timers, http, session, actions, state: () => state };
}

describe("connection", () => {
  it("connects and announces session", async () => {
    const h = await makeClient();
    await h.client.start();

    expect(h.client.state).toBe("connected");
    // Handshake carries access token, never password.
    const hello = h.socket.lastOfType("client.hello");
    expect(hello?.payload.accessToken).toBe("access-token-1");
  });

  it("transitions through connecting then authenticating", async () => {
    const h = await makeClient();
    await h.client.start();

    const states = h.actions
      .filter((action) => action.kind === "connection")
      .map((action) => action.state);

    expect(states).toEqual(["connecting", "authenticating", "connected"]);
  });

  it("schedules reconnection if server is unreachable", async () => {
    const h = await makeClient();
    h.socket.failNextConnect = true;

    await h.client.start();

    expect(h.client.state).toBe("reconnecting");
    expect(h.timers.pending.size).toBe(1);
  });

  it("does not dial into the void when offline", async () => {
    const h = await makeClient();
    h.network.set(false);

    await h.client.start();

    expect(h.client.state).toBe("offline");
    expect(h.socket.state).toBe("idle");
  });
});

describe("reconnection", () => {
  it("reschedules after a connection drop", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.drop("mobile network dropped");
    await settle();

    expect(h.client.state).toBe("reconnecting");
    expect(h.timers.delays.some((delay) => delay >= 1_000)).toBe(true);
  });

  it("re-executes full handshake", async () => {
    const h = await makeClient();
    await h.client.start();

    const before = h.socket.sent.filter((m) => m.type === "client.hello").length;

    h.socket.drop();
    await settle();
    h.timers.flush();
    await settle();

    expect(h.socket.sent.filter((m) => m.type === "client.hello").length).toBeGreaterThan(before);
  });

  it("spaces out attempts then caps", async () => {
    const h = await makeClient();
    h.socket.failNextConnect = true;
    await h.client.start();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      delays.push(h.timers.delays[0] ?? 0);
      h.socket.failNextConnect = true;
      h.timers.flush();
      await settle();
    }

    expect(delays[0]).toBeLessThan(delays[3] ?? 0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
  });

  it("does not schedule duplicate reconnections for rapid drops", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.drop("drop 1");
    h.socket.drop("drop 2");
    await settle();

    expect(h.timers.pending.size).toBe(1);
  });

  it("resumes immediately upon network restoration", async () => {
    const h = await makeClient();
    await h.client.start();

    h.network.set(false);
    h.socket.drop("network lost");
    await settle();

    const pendingBefore = h.timers.pending.size;
    h.network.set(true);
    await settle();

    expect(h.client.state).toBe("connected");
    expect(pendingBefore).toBeGreaterThan(0);
  });

  it("records offline state in store", async () => {
    const h = await makeClient();
    await h.client.start();

    h.network.set(false);
    await settle();

    expect(h.state().online).toBe(false);
    expect(h.state().connection).toBe("offline");
  });

  it("intentional stop does not reconnect", async () => {
    const h = await makeClient();
    await h.client.start();

    h.client.stop("user closed the application");
    h.timers.flush();
    await settle();

    expect(h.client.state).toBe("offline");
  });
});

describe("rejected session", () => {
  it("rotates token before reconnecting", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.reject();
    await settle();

    expect(h.http.countOf("POST", "/api/v1/auth/refresh")).toBe(1);
  });

  it("reconnects with fresh token", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.reject();
    await settle();

    h.socket.reopen();
    h.timers.flush();
    await settle();

    const hello = h.socket.lastOfType("client.hello");
    expect(hello?.payload.accessToken).toBe("access-token-2");
  });

  it("does not rotate token on plain network drop", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.drop("mobile network dropped");
    await settle();

    expect(h.http.countOf("POST", "/api/v1/auth/refresh")).toBe(0);
  });

  it("failed refresh does not prevent rescheduling", async () => {
    const h = await makeClient();
    await h.client.start();

    h.http.on("POST", "/api/v1/auth/refresh", { status: 401, body: {} });
    h.socket.reject();
    await settle();

    expect(h.client.state).toBe("reconnecting");
  });
});

describe("requests and acknowledgements", () => {
  it("correlates response to request", async () => {
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.sendMessage({ conversationId: null, text: "Hello" });
    const sent = h.socket.lastOfType("message.send");
    expect(sent?.requestId).toBeTruthy();

    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: true, data: { conversationId: "c1", messageId: "m1" }, error: null },
      sent?.requestId,
    );

    await expect(pending).resolves.toEqual({ conversationId: "c1", messageId: "m1" });
  });

  it("distinguishes multiple in-flight requests", async () => {
    const h = await makeClient();
    await h.client.start();

    const first = h.client.cancelTask("t1");
    const second = h.client.cancelTask("t2");

    const requests = h.socket.sent.filter((m) => m.type === "task.cancel");
    expect(requests).toHaveLength(2);

    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: true, data: { cancelled: false }, error: null },
      requests[1]?.requestId,
    );
    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: true, data: { cancelled: true }, error: null },
      requests[0]?.requestId,
    );

    expect(await first).toEqual({ cancelled: true });
    expect(await second).toEqual({ cancelled: false });
  });

  it("rejects with server error code", async () => {
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.cancelTask("unknown");
    const sent = h.socket.lastOfType("task.cancel");

    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: false, data: null, error: { code: "NOT_FOUND", message: "Unknown task" } },
      sent?.requestId,
    );

    await expect(pending).rejects.toMatchObject({ message: "Unknown task" });
  });

  it("times out request left without response", async () => {
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.cancelTask("t1");
    expect(h.client.pendingRequestCount).toBe(1);

    h.timers.flush();
    await expect(pending).rejects.toThrow(/did not respond/i);
    expect(h.client.pendingRequestCount).toBe(0);
  });

  it("rejects in-flight requests when connection drops", async () => {
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.cancelTask("t1");
    h.socket.drop("network lost");

    await expect(pending).rejects.toThrow(/Connection lost/i);
    expect(h.client.pendingRequestCount).toBe(0);
  });

  it("refuses to send when disconnected", async () => {
    const h = await makeClient();
    await expect(h.client.cancelTask("t1")).rejects.toThrow(/No connection/i);
  });
});

describe("incoming frames", () => {
  it("routes an event to the store", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.deliver(SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Run tests",
      stepCount: 2,
      originClientDeviceId: "device-iphone",
    });

    await until(() => h.state().tasks.length > 0);
    expect(h.state().tasks[0]).toMatchObject({ id: "t1", title: "Run tests" });
  });

  it("ignores malformed frame without dropping connection", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.deliverRaw("not json");
    h.socket.deliverRaw('{"incomplete":true}');
    await settle();

    expect(h.client.state).toBe("connected");
  });

  it("uses server timestamp rather than client time", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.deliver(SERVER_TO_CLIENT.notificationCreated, {
      notificationId: "n1",
      title: "Task completed",
      body: "ok",
      severity: "info",
    });

    await until(() => h.state().notifications.length > 0);
    expect(h.state().notifications[0]?.createdAt).toBe("2026-09-02T12:00:00.000Z");
  });
});
