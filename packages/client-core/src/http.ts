import type { HttpClient, HttpResponse } from "./ports.js";

/**
 * HTTP client built on top of `fetch`.
 *
 * Shared across clients (desktop, mobile, dashboard).
 * Unifying the HTTP client prevents subtle divergences such as unhandled JSON parse errors
 * or omitted `content-type` headers.
 */
export class FetchHttpClient implements HttpClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    const url = `${this.#baseUrl}${input.path}`;

    // `content-type: application/json` ONLY when a body is present.
    // Setting `content-type` on empty requests causes servers expecting body to return 400.
    const headers = {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...input.headers,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (cause) {
      // AbortError is intentional cancellation, not a network failure.
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new RequestBlockedError(url, cause);
    }

    // 204 No Content, proxy error pages, truncated stream: do not crash on JSON parse failure.
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }
}

/**
 * In-memory volatile storage.
 *
 * Cleared on process/tab exit. Used where persistent plaintext storage would be insecure.
 */
export class VolatileStorage {
  readonly #values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.#values.delete(key);
    return Promise.resolve();
  }
}

/**
 * Request blocked before reaching the network.
 *
 * `fetch` returns a generic "Failed to fetch" for three different causes:
 * core server down, origin rejected by CORS, or Content Security Policy blocking.
 *
 * We identify the target URL and common causes. URL contains no secrets;
 * headers, tokens, and request body are excluded from the error message.
 */
export class RequestBlockedError extends Error {
  readonly code = "CLIENT_REQUEST_BLOCKED";
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `Unable to reach ${url}. Three possible causes: NEXUS core is unreachable, ` +
        `origin not allowed by CORS, or Content Security Policy ` +
        `blocked the connection — CSP permits only https:// and wss:// outside development.`,
      { cause },
    );
    this.name = "RequestBlockedError";
    this.url = url;
  }
}
