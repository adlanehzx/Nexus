import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { uuidv7 } from "@nexus/shared";
import { WsCloseCode, parseClientHello } from "@nexus/protocol";

/**
 * WebSocket transport for both channels.
 *
 * This module is **purely transport**. All logic already lives in
 * `ClientChannel` and `WorkerChannel`, and is thoroughly tested without network; this
 * file opens sockets, decodes frames, and delegates. If it contained an
 * authorization decision, that decision would only be testable by opening a
 * port — which is exactly what we want to avoid.
 *
 * Two paths, separated end-to-end:
 *
 *     /ws/client   access token + device           → ClientChannel
 *     /ws/worker   machine-signed challenge        → WorkerChannel
 *
 * The Windows laptop uses **both**, with two distinct secrets and
 * from two separate processes: the UI holds the user's tokens,
 * while the daemon holds the machine's private key. Neither can substitute
 * for the other, and this separation ensures that a compromised window
 * does not become arbitrary command execution.
 */

/** An endpoint that proves nothing by this deadline is closed. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Cadence of application pings. A dead socket is detected through silence. */
const KEEPALIVE_INTERVAL_MS = 30_000;

/** 256 KB: beyond this, it is no longer a command, it is a file transfer. */
const MAX_PAYLOAD_BYTES = 262_144;

export interface WebSocketRoutesOptions {
  /** Accepted origins for browser connections. */
  allowedOrigins: readonly string[];
  /** Handshake timeout. Shortened in tests that do not wait. */
  handshakeTimeoutMs?: number;
}

export async function websocketRoutes(
  app: FastifyInstance,
  options: WebSocketRoutesOptions,
): Promise<void> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;

  await app.register(websocket, {
    options: {
      maxPayload: MAX_PAYLOAD_BYTES,
      // `Origin` does not replace authentication — token and signature handle
      // that — but it takes three lines and shuts down cross-site WebSocket
      // hijacking even before the handshake. A missing origin is accepted:
      // the worker daemon is not a browser and does not send one.
      verifyClient: ({ origin }, done) => {
        if (origin === undefined || options.allowedOrigins.includes(origin)) {
          done(true);
          return;
        }
        done(false, 403, "origin rejected");
      },
    },
  });

  clientSocketRoute(app, handshakeTimeoutMs);
  workerSocketRoute(app, handshakeTimeoutMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Client channel
// ─────────────────────────────────────────────────────────────────────────────

function clientSocketRoute(app: FastifyInstance, handshakeTimeoutMs: number): void {
  app.get("/ws/client", { websocket: true }, (socket: WebSocket, request) => {
    const log = request.log;
    let context: Awaited<ReturnType<typeof app.clientChannel.authenticate>> | undefined;

    // An open socket that does not present itself consumes a descriptor and a
    // table entry for nothing. The timer terminates silence.
    const handshake = setTimeout(() => {
      if (context === undefined) socket.close(WsCloseCode.AUTH_TIMEOUT, "missing handshake");
    }, handshakeTimeoutMs);

    const keepalive = setInterval(() => {
      socket.ping();
    }, KEEPALIVE_INTERVAL_MS);

    const shutdown = () => {
      clearTimeout(handshake);
      clearInterval(keepalive);
      if (context !== undefined) app.clientChannel.detach(context.deviceId);
    };

    // Frames are processed **in order, one at a time**.
    //
    // Without this queue, a client sending its handshake followed by its first
    // request in the same event loop would see the second frame arrive while
    // authentication is still in flight: the session does not yet exist,
    // the frame is mistaken for a second handshake, and the connection is closed.
    // This is exactly what `RealtimeClient` does on startup — the normal case,
    // not an edge case.
    const queue = serialize();

    socket.on("message", (data) => {
      const frame = decode(data);
      if (frame === undefined) return;

      queue(async () => {
        if (context === undefined) {
          context = await openClientSession(app, socket, frame, log);
          if (context !== undefined) clearTimeout(handshake);
          return;
        }

        await app.clientChannel.handle(context, frame);
      });
    });

    socket.on("close", shutdown);
    socket.on("error", (cause) => {
      log.warn({ err: cause }, "client socket error");
      shutdown();
    });
  });
}

/**
 * Opens a client session from the first frame.
 *
 * Returns `undefined` and closes if the frame is not a valid handshake.
 * Code 4401 is what informs the client to rotate its token rather than
 * endlessly reconnecting with the same one.
 */
async function openClientSession(
  app: FastifyInstance,
  socket: WebSocket,
  frame: unknown,
  log: FastifyInstance["log"],
): Promise<Awaited<ReturnType<typeof app.clientChannel.authenticate>> | undefined> {
  const hello = parseClientHello(frame);
  if (hello === undefined) {
    socket.close(WsCloseCode.UNAUTHENTICATED, "handshake expected");
    return undefined;
  }

  try {
    const context = await app.clientChannel.authenticate(hello);
    await app.clientChannel.attach(context, {
      send: (data) => {
        socket.send(data);
      },
      close: (code, reason) => {
        socket.close(code, reason);
      },
    });

    // The token appears nowhere: only the device is logged.
    log.info({ deviceId: context.deviceId, userId: context.userId }, "client connected");
    return context;
  } catch (cause) {
    log.warn({ err: cause, deviceId: hello.deviceId }, "client handshake rejected");
    const isDeviceError =
      cause instanceof Error &&
      (cause.message.includes("Device") || cause.message.includes("Appareil"));
    const code = isDeviceError ? WsCloseCode.FORBIDDEN_CHANNEL : WsCloseCode.UNAUTHENTICATED;
    socket.close(code, "authentication rejected");
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker channel
// ─────────────────────────────────────────────────────────────────────────────

function workerSocketRoute(app: FastifyInstance, handshakeTimeoutMs: number): void {
  app.get("/ws/worker", { websocket: true }, (socket: WebSocket, request) => {
    const log = request.log;
    const connectionId = uuidv7();

    app.workerChannel.open(connectionId, {
      send: (data) => {
        socket.send(data);
      },
      close: (code, reason) => {
        socket.close(code, reason);
      },
      ...(request.ip === undefined ? {} : { remoteAddress: request.ip }),
    });

    // Same rule as for clients: a machine that does not sign the challenge
    // in time gets no reprieve.
    const handshake = setTimeout(() => {
      if (!app.workerChannel.isAuthenticated(connectionId)) {
        socket.close(WsCloseCode.AUTH_TIMEOUT, "missing authentication");
      }
    }, handshakeTimeoutMs);

    const keepalive = setInterval(() => {
      socket.ping();
    }, KEEPALIVE_INTERVAL_MS);

    const shutdown = (reason: string) => {
      clearTimeout(handshake);
      clearInterval(keepalive);
      void app.workerChannel.close(connectionId, reason);
    };

    // Same queue as client-side: `worker.hello`, `worker.authenticate`, and
    // `worker.register` chain sequentially, each assuming the previous succeeded.
    const queue = serialize();

    socket.on("message", (data) => {
      const frame = decode(data);
      if (frame === undefined) return;
      queue(() => app.workerChannel.handle(connectionId, frame));
    });

    socket.on("close", () => {
      shutdown("socket closed");
    });
    socket.on("error", (cause) => {
      log.warn({ err: cause }, "worker socket error");
      shutdown("socket error");
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sequential execution queue.
 *
 * Returns a function that chains tasks one after another. A failed task
 * does not break the chain: the next one still runs, otherwise a single
 * malformed frame would freeze the connection permanently.
 */
function serialize(): (task: () => Promise<void>) => void {
  let chain: Promise<void> = Promise.resolve();

  return (task) => {
    chain = chain.then(task).catch(() => undefined);
  };
}

/**
 * Decodes a frame.
 *
 * Returns `undefined` for non-JSON content. We do not close the socket:
 * channels already know how to ignore unhandled content, and closing on
 * an unreadable frame would grant a denial of service to a single noisy socket.
 */
function decode(data: unknown): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}
