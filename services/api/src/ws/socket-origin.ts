/**
 * Which `Origin` may open a WebSocket.
 *
 * Three cases are accepted, and nothing else:
 *
 * - **No origin.** Not a browser: the worker daemon does not send one.
 * - **A listed origin**, from `CORS_ORIGINS`.
 * - **The server's own address.** React Native always sends an `Origin` built from
 *   the socket's address, and Android cannot omit it. A page served from another
 *   site cannot produce this value: browsers set `Origin` themselves.
 *
 * The comparison uses the raw `Host` header on purpose, never `X-Forwarded-Host`:
 * a client chooses that header's value, so honoring it would let any origin match.
 * Behind a proxy that rewrites `Host`, the two differ and the socket is refused,
 * so such a deployment still has to list its public address in `CORS_ORIGINS`.
 *
 * DNS rebinding can also make `Origin` and `Host` agree. It gains nothing here:
 * this socket authenticates with a token in its first frame, not with cookies, so a
 * page that reaches it has no credential to use.
 */

const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

function isSameAddress(origin: string, host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return false;
  let parsedOrigin: URL;
  let parsedHost: URL;
  try {
    parsedOrigin = new URL(origin);
    // The scheme only lets URL parse the authority. A port equal to its default is
    // dropped, so a scheme neither form can use keeps an explicit port intact.
    parsedHost = new URL(`nexus-host://${host}`);
  } catch {
    return false;
  }

  const defaultPort = DEFAULT_PORTS[parsedOrigin.protocol];
  if (defaultPort === undefined) return false;
  // Anything beyond host and port means this was not a plain Host header.
  if (parsedHost.username !== "" || parsedHost.password !== "" || parsedHost.pathname !== "") {
    return false;
  }

  return (
    parsedOrigin.hostname.toLowerCase() === parsedHost.hostname.toLowerCase() &&
    (parsedOrigin.port || defaultPort) === (parsedHost.port || defaultPort)
  );
}

export function isAllowedSocketOrigin(input: {
  origin: string | undefined;
  host: string | undefined;
  allowedOrigins: readonly string[];
}): boolean {
  const { origin, host, allowedOrigins } = input;
  return origin === undefined || allowedOrigins.includes(origin) || isSameAddress(origin, host);
}
