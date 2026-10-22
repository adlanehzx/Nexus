import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  CLIENT_HELLO,
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
  WORKER_MESSAGE,
  WsCloseCode,
  clientEnvelope,
  workerEnvelope,
} from "@nexus/protocol";
import {
  createAccount,
  listeningApi,
  registerDevice,
  signNonce,
  type Account,
  type ListeningApi,
  type RegisteredDevice,
} from "./harness.js";

/**
 * WebSocket transport on a real listening port.
 *
 * Verifies HTTP upgrades, close codes, and wire framing.
 */

let api: ListeningApi;
let account: Account;
let portable: RegisteredDevice;

let sequence = 0;

function envelope(type: string, payload: unknown, requestId?: string) {
  sequence += 1;
  return JSON.stringify(
    clientEnvelope(type as never, payload as never, {
      id: `c-${String(sequence)}`,
      at: new Date(),
      requestId,
    }),
  );
}

function workerFrame(kind: keyof typeof WORKER_MESSAGE, payload: unknown) {
  sequence += 1;
  return JSON.stringify(
    workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
      id: `w-${String(sequence)}`,
      at: new Date(),
    }),
  );
}

/** Opens a socket and waits for open event. */
function open(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, headers === undefined ? undefined : { headers });
    socket.once("open", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Waits for first frame of given type. */
function waitFor(socket: WebSocket, type: string, timeoutMs = 3_000): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`no frame "${type}" within ${String(timeoutMs)} ms`));
    }, timeoutMs);

    function onMessage(data: unknown) {
      const frame = JSON.parse(String(data)) as Envelope;
      if (frame.type !== type) return;

      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    }

    socket.on("message", onMessage);
  });
}

interface Envelope {
  type: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

/** Waits for close event and returns code. */
function waitClose(socket: WebSocket, timeoutMs = 3_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("socket was not closed"));
    }, timeoutMs);

    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

beforeEach(async () => {
  api = await listeningApi();
  account = await createAccount(api.harness);
  portable = await registerDevice(api.harness, account, {
    name: "Windows Laptop",
    role: "BOTH",
    permissions: ["filesystem.read"],
  });
});

afterEach(async () => {
  await api.close();
});

describe("client channel on the wire", () => {
  it("opens session on valid handshake", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);

    socket.send(
      envelope(CLIENT_HELLO, {
        accessToken: account.accessToken,
        deviceId: portable.device.id,
      }),
    );

    // Proof session is open: request receives its ack
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "r1"));
    const ack = await waitFor(socket, SERVER_TO_CLIENT.ack);

    expect(ack.requestId).toBe("r1");
    expect(ack.payload.ok).toBe(true);
    socket.close();
  });

  it("closes with 4401 when token is rejected", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(
      envelope(CLIENT_HELLO, { accessToken: "invented-token", deviceId: portable.device.id }),
    );

    expect(await waitClose(socket)).toBe(WsCloseCode.UNAUTHENTICATED);
  });

  it("closes when first frame is not a handshake", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "r1"));

    expect(await waitClose(socket)).toBe(WsCloseCode.UNAUTHENTICATED);
  });

  it("closes silent socket", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);

    expect(await waitClose(socket)).toBe(WsCloseCode.AUTH_TIMEOUT);
  });

  it("ignores unreadable frame without closing", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(
      envelope(CLIENT_HELLO, {
        accessToken: account.accessToken,
        deviceId: portable.device.id,
      }),
    );

    socket.send("this is not json");
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: true }, "r2"));

    const ack = await waitFor(socket, SERVER_TO_CLIENT.ack);
    expect(ack.requestId).toBe("r2");
    socket.close();
  });

  it("rejects unknown origin before handshake", async () => {
    await expect(
      open(`${api.wsUrl}/ws/client`, { origin: "https://malicious-site.example" }),
    ).rejects.toThrow();
  });

  it("accepts declared origin", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`, { origin: "http://localhost:3000" });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("accepts Tauri desktop shell", async () => {
    for (const origin of ["http://tauri.localhost", "tauri://localhost"]) {
      const socket = await open(`${api.wsUrl}/ws/client`, { origin });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    }
  });

  it("opening to Tauri widens nothing else", async () => {
    for (const origin of [
      "https://tauri.localhost.attacker.test",
      "http://tauri.localhost.evil.test",
      "tauri://other-host",
    ]) {
      await expect(open(`${api.wsUrl}/ws/client`, { origin })).rejects.toThrow();
    }
  });
});

describe("worker channel on the wire", () => {
  it("conducts signed handshake end-to-end", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);

    socket.send(
      workerFrame("hello", {
        deviceId: portable.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = await waitFor(socket, WORKER_MESSAGE.challenge);
    const nonce = String(challenge.payload.nonce);

    socket.send(
      workerFrame("authenticate", {
        deviceId: portable.device.id,
        nonce,
        signature: signNonce(portable.privateKeyPem, nonce),
        capabilities: ["filesystem.read"],
        requestId: "auth-1",
        timestamp: new Date().toISOString(),
      }),
    );

    const session = await waitFor(socket, WORKER_MESSAGE.session);
    expect(session.payload.sessionId).toBeTruthy();

    expect(api.harness.services.gateway.isConnected(portable.device.id)).toBe(true);
    socket.close();
  });

  it("closes on invalid signature", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);
    socket.send(
      workerFrame("hello", {
        deviceId: portable.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = await waitFor(socket, WORKER_MESSAGE.challenge);

    socket.send(
      workerFrame("authenticate", {
        deviceId: portable.device.id,
        nonce: String(challenge.payload.nonce),
        signature: Buffer.from("not a signature").toString("base64"),
        capabilities: [],
        requestId: "auth-2",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(await waitClose(socket)).toBe(4401);
  });

  it("closes machine that does not authenticate", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);

    expect(await waitClose(socket)).toBe(WsCloseCode.AUTH_TIMEOUT);
  });

  it("releases worker when socket drops", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);
    socket.send(
      workerFrame("hello", {
        deviceId: portable.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = await waitFor(socket, WORKER_MESSAGE.challenge);
    const nonce = String(challenge.payload.nonce);

    socket.send(
      workerFrame("authenticate", {
        deviceId: portable.device.id,
        nonce,
        signature: signNonce(portable.privateKeyPem, nonce),
        capabilities: ["filesystem.read"],
        requestId: "auth-3",
        timestamp: new Date().toISOString(),
      }),
    );
    await waitFor(socket, WORKER_MESSAGE.session);

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(api.harness.services.gateway.isConnected(portable.device.id)).toBe(false);
  });
});

describe("channel partitioning on the wire", () => {
  it("a client cannot emit a frame from worker channel", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(
      envelope(CLIENT_HELLO, {
        accessToken: account.accessToken,
        deviceId: portable.device.id,
      }),
    );

    socket.send(
      JSON.stringify(
        workerEnvelope(
          WORKER_MESSAGE.taskResult,
          {
            taskId: "t1",
            stepId: "s1",
            ok: true,
            result: {},
            sensitiveResult: false,
            error: null,
            durationMs: 1,
          },
          { id: "forge-1", at: new Date() },
        ),
      ),
    );
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "r3"));

    const ack = await waitFor(socket, SERVER_TO_CLIENT.ack);
    expect(ack.requestId).toBe("r3");
    socket.close();
  });
});
