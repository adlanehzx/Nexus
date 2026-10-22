import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CURRENT_PROTOCOL_VERSION,
  type ConnectorErrorCode,
  type ConnectorResponse,
} from "./protocol.js";
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
 * What the dispatcher has to look like from here.
 *
 * An interface rather than the concrete `ConnectorServer`, so a test can supply
 * one that rejects. The handler's catch-all is the thing most likely to be
 * wrong and the hardest to exercise through a real server, which works.
 */
export interface ConnectorDispatcher {
  handle(body: unknown): Promise<ConnectorResponse>;
}

/**
 * Transport limits.
 *
 * Injectable, so the tests that prove them use small numbers and finish
 * immediately instead of waiting on realistic ones. A test that needs sixty
 * seconds to show a sixty-second timeout works gets deleted by whoever is in a
 * hurry.
 */
export interface ConnectorHttpLimits {
  /** Ceiling on the request body, enforced twice: declared, then observed. */
  maxBodyBytes: number;
  /** Time allowed to send the headers. */
  headersTimeoutMs: number;
  /** Time allowed for the whole request, body included. */
  requestTimeoutMs: number;
  /** Ceiling on the total size of the headers. */
  maxHeaderSizeBytes: number;
  /** How long an idle keep-alive connection is held. */
  keepAliveTimeoutMs: number;
  /**
   * How often Node checks connections against the two timeouts above.
   *
   * This is not a detail. Node's default is 30 seconds, so setting
   * `headersTimeout` to five and nothing else means a stalled connection is
   * actually cut somewhere between five and thirty-five seconds later — the
   * timeout is a lower bound, and the checking interval is the resolution.
   * Configuring only the timeout gives a false sense of a bound, which is
   * exactly how this was found: a test asserting a 300 ms limit sat there for
   * three seconds.
   */
  connectionsCheckingIntervalMs: number;
}

export const DEFAULT_HTTP_LIMITS: ConnectorHttpLimits = {
  // 64 KiB is far beyond any request this protocol defines. The point is that
  // the number exists: without it, how much an unauthenticated caller can make
  // the connector hold is answered by how much memory the machine has.
  maxBodyBytes: 64 * 1024,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 15_000,
  maxHeaderSizeBytes: 16 * 1024,
  keepAliveTimeoutMs: 5_000,
  // Two seconds: the resolution at which the timeouts above are actually
  // applied. Cheap — it is one interval over the listening socket, not per
  // connection — and without it the numbers above are aspirational.
  connectionsCheckingIntervalMs: 2_000,
};

export type ConnectorListenTarget =
  /** Loopback TCP. `port: 0` asks the operating system for a free port. */
  | { kind: "loopback"; port: number }
  /** A Unix socket, created with owner-only permissions. */
  | { kind: "unix"; path: string };

export interface ConnectorHttpOptions {
  server: ConnectorDispatcher;
  listen: ConnectorListenTarget;
  limits?: Partial<ConnectorHttpLimits>;
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

/**
 * A transport-level refusal, in the protocol's own error shape.
 *
 * `code` is typed as `ConnectorErrorCode` rather than `string` on purpose: this
 * file builds error payloads by hand, and when the code enum changed a free
 * `string` let it keep emitting a code that no longer existed. The compiler now
 * catches that instead of a reader having to.
 */
function protocolError(code: ConnectorErrorCode, message: string): unknown {
  return { ok: false, protocolVersion: CURRENT_PROTOCOL_VERSION, error: { code, message } };
}

/**
 * Reads the body, with the limit enforced on what actually arrives.
 *
 * The declared `Content-Length` was already checked by the caller. This is the
 * second enforcement, and it is the one that matters: a header is a claim by
 * the peer, and a peer that lies about it — or omits it entirely, which chunked
 * encoding allows — would otherwise stream as much as it liked.
 */
async function readBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBodyBytes) {
      // Destroy rather than return and let the stream drain. Continuing to
      // read a body already refused is work an unauthenticated caller chose
      // for us, and the socket is the only way to make them stop.
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The declared body size, or `undefined` when there is no usable claim.
 *
 * A malformed or negative value is treated as absent rather than as zero: the
 * streaming limit then does the work, which is the safe direction.
 */
function declaredLength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function createConnectorHttpServer(options: ConnectorHttpOptions): Server {
  const limits = { ...DEFAULT_HTTP_LIMITS, ...options.limits };

  const server = createServer(
    {
      maxHeaderSize: limits.maxHeaderSizeBytes,
      connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
    },
    (request, response) => {
      // The callback is synchronous and `handle` is not, so without this catch
      // any rejection becomes an unhandled rejection — which, under Node's
      // default, takes the whole process down. A connector that can be killed by
      // a malformed request is a denial-of-service hole with extra steps.
      handle(options.server, request, response, limits).catch(() => {
        replyInternalError(response);
      });
    },
  );

  // Bounded time, not just bounded size. A connection that sends one header
  // byte a minute consumes a slot indefinitely otherwise.
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  return server;
}

/**
 * The only thing said when something unexpected breaks.
 *
 * Fixed text, and deliberately no detail from the exception: a message or a
 * stack can carry a path, a provider's output or an argument vector. If the
 * headers are already out there is nothing left to say, so the socket is simply
 * ended.
 */
function replyInternalError(response: ServerResponse): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  reply(
    response,
    500,
    protocolError("internal_error", "The connector could not complete this request."),
  );
}

async function handle(
  connector: ConnectorDispatcher,
  request: IncomingMessage,
  response: ServerResponse,
  limits: ConnectorHttpLimits,
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
    return reply(
      response,
      403,
      protocolError("authentication_failed", "This request was refused."),
    );
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

  // Checked before a single byte is read. A caller announcing a gigabyte is
  // refused on the strength of its own claim, which costs nothing.
  const declared = declaredLength(request.headers["content-length"]);
  if (declared !== undefined && declared > limits.maxBodyBytes) {
    return reply(
      response,
      413,
      protocolError("malformed_request", "The request body is too large."),
    );
  }

  const raw = await readBody(request, limits.maxBodyBytes);
  if (raw === undefined) {
    // The socket is already destroyed; nothing can be written to it.
    return;
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
