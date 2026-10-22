import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ConnectorServer } from "./server.js";
import { CURRENT_PROTOCOL_VERSION } from "./protocol.js";
import { prepareSocketPath, removeStaleSocket } from "./socket.js";

/**
 * The transport, and nothing else.
 *
 * Every decision in this file is about reducing who can reach the dispatcher.
 * None of it replaces the signature check: a local socket tells you a request
 * came from this machine, which includes every process on it and every page in
 * the user's browser.
 */

/** The single endpoint. No path parameters, nothing derived from a URL. */
const RPC_PATH = "/rpc";

/**
 * Request body ceiling.
 *
 * 64 KiB is far beyond any request this protocol defines. The point is that an
 * unauthenticated caller cannot make the connector hold an arbitrary amount of
 * memory before the first check runs.
 */
const MAX_BODY_BYTES = 64 * 1024;

export type ConnectorListenTarget =
  /** Loopback TCP. `port: 0` asks the operating system for a free port. */
  | { kind: "loopback"; port: number }
  /** A Unix socket, created with owner-only permissions. */
  | { kind: "unix"; path: string };

export interface ConnectorHttpOptions {
  server: ConnectorServer;
  listen: ConnectorListenTarget;
}

export interface RunningConnector {
  /** The bound address: a port for loopback, a path for a Unix socket. */
  address: { port: number } | { path: string };
  close(): Promise<void>;
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // The response is for one caller and must not be cached anywhere.
    "cache-control": "no-store",
    // Belt and braces for a browser that reaches loopback: refuse to be framed
    // and refuse content-type sniffing.
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function protocolError(code: string, message: string): unknown {
  return { ok: false, protocolVersion: CURRENT_PROTOCOL_VERSION, error: { code, message } };
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // Stop reading rather than stop accumulating: continuing to drain a body
    // we have already refused is work an unauthenticated caller chose for us.
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createConnectorHttpServer(options: ConnectorHttpOptions): Server {
  return createServer((request, response) => {
    void handle(options.server, request, response);
  });
}

async function handle(
  connector: ConnectorServer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    return reply(response, 405, protocolError("malformed_request", "Only POST is accepted."));
  }
  if ((request.url ?? "") !== RPC_PATH) {
    return reply(response, 404, protocolError("unknown_method", "No such endpoint."));
  }

  // A browser attaches `Origin` to cross-origin requests, including ones aimed
  // at loopback. No legitimate client of this protocol is a web page, so the
  // presence of the header is itself the answer. The signature would refuse
  // these anyway; refusing before reading a body is cheaper and clearer.
  if (request.headers.origin !== undefined) {
    return reply(response, 403, protocolError("unauthenticated", "This request was refused."));
  }

  // Requiring a JSON content type keeps a form post — which a page can make
  // without any preflight — from reaching the dispatcher at all.
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return reply(
      response,
      415,
      protocolError("malformed_request", "The request body must be JSON."),
    );
  }

  const raw = await readBody(request);
  if (raw === undefined) {
    return reply(
      response,
      413,
      protocolError("malformed_request", "The request body is too large."),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reply(
      response,
      400,
      protocolError("malformed_request", "The request body is not JSON."),
    );
  }

  const result = await connector.handle(parsed);
  // 200 for a protocol-level refusal, because the HTTP layer did its job and
  // the answer is in the envelope. Only transport failures use a 4xx here.
  reply(response, 200, result);
}

/** Starts the connector on loopback or a Unix socket, never on a routable address. */
export async function startConnector(options: ConnectorHttpOptions): Promise<RunningConnector> {
  const server = createConnectorHttpServer(options);

  if (options.listen.kind === "unix") {
    const path = options.listen.path;
    // Checks the parent directory and removes a leftover socket — only an
    // actual socket. Anything else at this path, including a symbolic link,
    // makes the connector refuse to start rather than delete it. See socket.ts.
    await prepareSocketPath(path);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path }, resolve);
    });
    // Owner only. Without this the socket inherits the umask, and a
    // world-writable socket makes the loopback argument moot.
    await chmod(path, 0o600);
    return {
      address: { path },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Node already unlinks the socket on close, so this is belt and braces
        // for the case where it did not get that far. It goes through the same
        // narrow removal as startup: by the time we shut down, something else
        // may be at this path, and shutdown is not a licence to delete it.
        await removeStaleSocket(path).catch(() => undefined);
      },
    };
  }

  const port = options.listen.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The host is hard-coded. An option here would eventually be set to
    // 0.0.0.0 by someone debugging, and a connector reachable from the network
    // is a different product with a different threat model.
    server.listen({ host: "127.0.0.1", port }, resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    address: { port: boundPort },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
