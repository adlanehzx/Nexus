import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { Envelope } from "@nexus/protocol";
import { WebSocketLink, toSocketUrl } from "../src/connection/websocket-link.js";
import { WorkerConfigurationError } from "../src/errors.js";
import { defaultStatePath, publicStateOf } from "../src/runtime/state-file.js";

/**
 * Real daemon channel.
 *
 * A real WebSocket server on an ephemeral port facing the real client `ws`.
 * The core is not involved: what is tested here is the transport — outbound
 * connection, framing, closing — and none of the protocol, which is tested
 * elsewhere without networking.
 */

let server: WebSocketServer;
let url: string;
let sockets: ServerSocket[] = [];
let received: unknown[] = [];

function envelope(type: string): Envelope {
  return { v: 1, id: "e-1", type, ts: new Date().toISOString(), payload: {} };
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
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("outbound connection", () => {
  it("opens a channel to the core", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await link.connect();

    expect(link.state).toBe("open");
    await link.close("end of test");
  });

  it("does not listen on any port", () => {
    // The port shape already indicates this — it has `connect`, but no `listen` —
    // but writing it here fixes the design intent: this daemon is not reachable
    // from any network, eliminating any exposed service surface.
    const link = new WebSocketLink({ backendUrl: url });

    expect("listen" in link).toBe(false);
    expect(link.url).toBe(url.replace("http", "ws") + "/ws/worker");
  });

  it("rejects when the core is unreachable", async () => {
    const link = new WebSocketLink({ backendUrl: "http://127.0.0.1:1", connectTimeoutMs: 500 });

    await expect(link.connect()).rejects.toThrow();
    expect(link.state).toBe("closed");
  });
});

describe("frame exchange", () => {
  it("sends an envelope as is", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await link.connect();

    await link.send(envelope("worker.hello"));
    await until(() => received.length > 0);

    expect(received[0]).toMatchObject({ v: 1, type: "worker.hello" });
    await link.close("end");
  });

  it("delivers downstream frames to runtime", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    const receivedFrames: unknown[] = [];
    link.onMessage((frame) => receivedFrames.push(frame));

    await link.connect();
    await until(() => sockets.length > 0);
    sockets[0]?.send(JSON.stringify(envelope("worker.challenge")));

    await until(() => receivedFrames.length > 0);
    expect(receivedFrames[0]).toMatchObject({ type: "worker.challenge" });
    await link.close("end");
  });

  it("ignores an unreadable frame without closing", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    const receivedFrames: unknown[] = [];
    link.onMessage((frame) => receivedFrames.push(frame));

    await link.connect();
    await until(() => sockets.length > 0);
    sockets[0]?.send("not json");
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => receivedFrames.length > 0);
    expect(receivedFrames).toHaveLength(1);
    expect(link.state).toBe("open");
    await link.close("end");
  });

  it("refuses to send over a closed channel", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await expect(link.send(envelope("worker.hello"))).rejects.toThrow(/closed/);
  });
});

describe("closing", () => {
  it("reports an involuntary disconnection", async () => {
    // Recovery belongs to runtime: the channel merely indicates it is no longer
    // present, and runtime decides when to retry.
    const link = new WebSocketLink({ backendUrl: url });
    let closeReason: string | undefined;
    link.onClose((cause) => {
      closeReason = cause;
    });

    await link.connect();
    await until(() => sockets.length > 0);
    sockets[0]?.close(1011, "core rebooting");

    await until(() => closeReason !== undefined);
    expect(closeReason).toContain("rebooting");
    expect(link.state).toBe("closed");
  });

  it("a requested close is idempotent", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await link.connect();

    await link.close("first");
    await expect(link.close("second")).resolves.toBeUndefined();
  });
});

describe("core address", () => {
  it("switches to wss for an https address", () => {
    expect(toSocketUrl("https://nexus.example.com", "/ws/worker")).toBe(
      "wss://nexus.example.com/ws/worker",
    );
  });

  it("allows cleartext locally only", () => {
    expect(toSocketUrl("http://localhost:3000", "/ws/worker")).toBe(
      "ws://localhost:3000/ws/worker",
    );
  });

  it("rejects a remote cleartext address", () => {
    // The signed challenge authenticates the machine; it does not encrypt subsequent traffic.
    // In cleartext, execution instructions sent to this host could be inspected
    // or altered in transit.
    expect(() => toSocketUrl("http://nexus.example.com", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });

  it("rejects invalid URLs", () => {
    expect(() => toSocketUrl("nexus.example.com", "/ws/worker")).toThrow(WorkerConfigurationError);
  });

  it("preserves path prefixes", () => {
    // A core behind a reverse proxy can live under a sub-path.
    expect(toSocketUrl("https://example.com/nexus/", "/ws/worker")).toBe(
      "wss://example.com/nexus/ws/worker",
    );
  });
});

describe("public daemon state", () => {
  it("publishes only an identifier, never secrets", () => {
    const state = publicStateOf({
      deviceId: "device-laptop",
      platform: "WINDOWS",
      workerVersion: "0.1.0",
      now: new Date("2026-09-02T12:00:00.000Z"),
    });

    // This file is readable by the user on the machine. Everything in it is
    // effectively public.
    expect(Object.keys(state).sort()).toEqual([
      "deviceId",
      "platform",
      "startedAt",
      "workerVersion",
    ]);

    const serialized = JSON.stringify(state);
    for (const forbidden of ["credential", "privateKey", "allowedPaths", "backendUrl", "token"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("is stored under ProgramData", () => {
    const path = defaultStatePath({ ProgramData: "C:\\ProgramData" });

    // ProgramData, not user profile: the daemon runs as a service, the UI runs in
    // an interactive session, and they share no personal folder.
    expect(path).toContain("ProgramData");
    expect(path).toContain("device.json");
  });
});

/** Waits for a condition while yielding event loop. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
