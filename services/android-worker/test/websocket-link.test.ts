import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { Envelope } from "@nexus/protocol";
import { WorkerConfigurationError } from "@nexus/worker-core";
import {
  AndroidWebSocketLink,
  toAndroidSocketUrl,
  type WebSocketFactory,
  type WebSocketLike,
} from "../src/connection/websocket-link.js";

/**
 * Android WebSocket link tests.
 *
 * Real WebSocket server on an ephemeral port facing the global WebSocket.
 */

let server: WebSocketServer;
let url: string;
let sockets: ServerSocket[] = [];
let received: unknown[] = [];

function envelope(type: string): Envelope {
  return { v: 1, id: "e-1", type, ts: new Date().toISOString(), payload: {} };
}

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never reached: ${label}`);
}

beforeEach(async () => {
  received = [];
  sockets = [];

  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data: Buffer) => {
      received.push(JSON.parse(data.toString("utf8")));
    });
  });

  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  url = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────────

describe("outbound connection", () => {
  it("opens link to core", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await link.connect();

    expect(link.state).toBe("open");
    await link.close("end of test");
  });

  it("does not listen on any port", () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });

    expect("listen" in link).toBe(false);
    expect(link.url).toBe(`${url.replace("http", "ws")}/ws/worker`);
  });

  it("rejects when core is unreachable", async () => {
    const link = new AndroidWebSocketLink({
      backendUrl: "http://127.0.0.1:1",
      connectTimeoutMs: 1_000,
    });

    await expect(link.connect()).rejects.toThrow();
    expect(link.state).toBe("closed");
  });

  it("aborts when connection never establishes", async () => {
    const link = new AndroidWebSocketLink({
      backendUrl: url,
      connectTimeoutMs: 40,
      socketFactory: silentFactory(),
    });

    await expect(link.connect()).rejects.toThrow(/timeout/);
    expect(link.state).toBe("closed");
  });

  it("treats factory errors as connection failure", async () => {
    const link = new AndroidWebSocketLink({
      backendUrl: url,
      socketFactory: () => {
        throw new Error("no implementation");
      },
    });

    await expect(link.connect()).rejects.toThrow(/no implementation/);
    expect(link.state).toBe("closed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frames
// ─────────────────────────────────────────────────────────────────────────────

describe("frame exchange", () => {
  it("sends envelope as-is", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await link.connect();

    await link.send(envelope("worker.hello"));
    await until(() => received.length > 0, "frame received by server");

    expect(received[0]).toMatchObject({ v: 1, type: "worker.hello" });
    await link.close("end");
  });

  it("delivers inbound frames to runtime", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const frames: unknown[] = [];
    link.onMessage((frame) => frames.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "server socket");
    sockets[0]?.send(JSON.stringify(envelope("worker.challenge")));

    await until(() => frames.length > 0, "inbound frame");
    expect(frames[0]).toMatchObject({ type: "worker.challenge" });
    await link.close("end");
  });

  it("ignores unparseable frame without closing channel", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const frames: unknown[] = [];
    link.onMessage((frame) => frames.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "server socket");
    sockets[0]?.send("not json");
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => frames.length > 0, "valid frame");
    expect(frames).toHaveLength(1);
    expect(link.state).toBe("open");
    await link.close("end");
  });

  it("discards oversized frame", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url, maxFrameBytes: 256 });
    const frames: unknown[] = [];
    link.onMessage((frame) => frames.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "server socket");

    const huge = JSON.stringify({ ...envelope("worker.task"), padding: "x".repeat(2_000) });
    sockets[0]?.send(huge);
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => frames.length > 0, "valid frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "worker.session" });
    await link.close("end");
  });

  it("discards binary frame", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const frames: unknown[] = [];
    link.onMessage((frame) => frames.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "server socket");
    sockets[0]?.send(Buffer.from(JSON.stringify(envelope("worker.task"))));
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => frames.length > 0, "valid frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "worker.session" });
    await link.close("end");
  });

  it("refuses to send on closed channel", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await expect(link.send(envelope("worker.hello"))).rejects.toThrow(/channel closed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Closure and reconnect
// ─────────────────────────────────────────────────────────────────────────────

describe("closure", () => {
  it("signals unexpected disconnect for runtime reconnect", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const reasons: string[] = [];
    link.onClose((reason) => reasons.push(reason));

    await link.connect();
    await until(() => sockets.length > 0, "server socket");
    sockets[0]?.close(1011, "core rebooted");

    await until(() => reasons.length > 0, "disconnect signaled");
    expect(reasons[0]).toContain("core rebooted");
    expect(link.state).toBe("closed");
  });

  it("does not signal voluntary closure", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const reasons: string[] = [];
    link.onClose((reason) => reasons.push(reason));

    await link.connect();
    await link.close("stop requested");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(reasons).toEqual([]);
    expect(link.state).toBe("closed");
  });

  it("allows reconnect after unexpected disconnect", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });

    await link.connect();
    await until(() => sockets.length > 0, "first socket");
    sockets[0]?.terminate();
    await until(() => link.state === "closed", "channel closed");

    await link.connect();
    expect(link.state).toBe("open");

    await link.send(envelope("worker.hello"));
    await until(() => received.length > 0, "frame after reconnect");
    await link.close("end");
  });

  it("closing twice does not throw", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await link.connect();

    await link.close("once");
    await expect(link.close("twice")).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// URL validation
// ─────────────────────────────────────────────────────────────────────────────

describe("toAndroidSocketUrl", () => {
  it("switches to wss for remote address", () => {
    expect(toAndroidSocketUrl("https://nexus.example.com", "/ws/worker")).toBe(
      "wss://nexus.example.com/ws/worker",
    );
  });

  it("refuses cleartext remote backend address", () => {
    expect(() => toAndroidSocketUrl("http://nexus.example.com", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
    expect(() => toAndroidSocketUrl("ws://192.168.1.20:3000", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });

  it("tolerates localhost and emulator addresses", () => {
    expect(toAndroidSocketUrl("http://localhost:3000", "/ws/worker")).toBe(
      "ws://localhost:3000/ws/worker",
    );
    expect(toAndroidSocketUrl("http://10.0.2.2:3000", "/ws/worker")).toBe(
      "ws://10.0.2.2:3000/ws/worker",
    );
  });

  it("does not duplicate link path", () => {
    expect(toAndroidSocketUrl("wss://nexus.example.com/ws/worker", "/ws/worker")).toBe(
      "wss://nexus.example.com/ws/worker",
    );
  });

  it("refuses invalid URL or unknown protocol", () => {
    expect(() => toAndroidSocketUrl("not a url", "/ws/worker")).toThrow(WorkerConfigurationError);
    expect(() => toAndroidSocketUrl("file:///etc/passwd", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });
});

/** Silent socket factory that accepts and never responds. */
function silentFactory(): WebSocketFactory {
  return (): WebSocketLike => ({
    readyState: 0,
    send: () => undefined,
    close: () => undefined,
    addEventListener: () => undefined,
  });
}
