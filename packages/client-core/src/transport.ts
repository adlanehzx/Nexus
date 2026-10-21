import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Validated core backend addresses.
 *
 * Enforces `https` and `wss` everywhere. `http` and `ws` are **only** permitted
 * for localhost and Android emulator loopbacks (`10.0.2.2`).
 */

export class InsecureBackendUrlError extends AppError {
  readonly code = "CLIENT_INSECURE_BACKEND_URL";
  readonly httpStatus = 500;
  override readonly severity: ErrorSeverity = "error";

  constructor(url: string, reason: string) {
    super({
      // URL is included: not a secret, and without it debugging environment misconfiguration is difficult.
      message: `Invalid backend address (${url}): ${reason}`,
      userMessage: "The application configuration is invalid. Contact your administrator.",
      context: { url, reason },
    });
  }
}

/** Hosts for which plaintext network traffic never leaves the machine. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  /** Android emulator host loopback address. */
  "10.0.2.2",
]);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/**
 * Validates backend HTTP URL and returns normalized string.
 *
 * @throws {InsecureBackendUrlError} on unparseable URL, unexpected protocol,
 *   or plaintext HTTP to remote hosts.
 */
export function backendHttpUrl(raw: string): string {
  const url = parse(raw);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InsecureBackendUrlError(raw, `unexpected protocol "${url.protocol}"`);
  }

  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new InsecureBackendUrlError(
      raw,
      "remote address must use https:// — plaintext channels expose session tokens",
    );
  }

  // Strip trailing slash once to prevent double-slash in path concatenation.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
}

/**
 * Real-time socket URL derived from backend HTTP URL.
 *
 * `https` maps to `wss`, `http` maps to `ws`.
 */
export function clientSocketUrl(raw: string, path = "/ws/client"): string {
  const base = backendHttpUrl(raw);
  const socket = base.replace(/^http/, "ws");

  return socket.endsWith(path) ? socket : `${socket}${path}`;
}

function parse(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new InsecureBackendUrlError(raw, "not a valid URL");
  }
}
