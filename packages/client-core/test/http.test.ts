import { describe, expect, it } from "vitest";
import { FetchHttpClient, RequestBlockedError } from "../src/http.js";

/**
 * Handling of requests blocked before reaching the network.
 */

function clientWith(fetchImpl: typeof fetch): FetchHttpClient {
  const client = new FetchHttpClient("https://nexus.test");
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  Reflect.set(client, "restore", () => {
    globalThis.fetch = original;
  });
  return client;
}

describe("requests blocked before network", () => {
  it("specifies possible causes and targeted URL", async () => {
    const client = clientWith(() => Promise.reject(new TypeError("Failed to fetch")));

    try {
      await client.request({ method: "GET", path: "/api/v1/health" });
      expect.unreachable("request should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBlockedError);
      const message = (error as Error).message;

      expect(message).toContain("https://nexus.test/api/v1/health");
      expect(message).toContain("CORS");
      expect(message).toContain("Content Security Policy");
    } finally {
      (Reflect.get(client, "restore") as () => void)();
    }
  });

  it("preserves underlying cause", async () => {
    const cause = new TypeError("Failed to fetch");
    const client = clientWith(() => Promise.reject(cause));

    try {
      await client.request({ method: "GET", path: "/x" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).cause).toBe(cause);
    } finally {
      (Reflect.get(client, "restore") as () => void)();
    }
  });

  it("does not expose headers, tokens, or body", async () => {
    const client = clientWith(() => Promise.reject(new TypeError("Failed to fetch")));

    try {
      await client.request({
        method: "POST",
        path: "/api/v1/auth/login",
        headers: { authorization: "Bearer very-secret-token" },
        body: { password: "secret-password" },
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("very-secret-token");
      expect(message).not.toContain("secret-password");
      expect(message).not.toContain("Bearer");
    } finally {
      (Reflect.get(client, "restore") as () => void)();
    }
  });

  it("propagates intentional abort without wrapping in RequestBlockedError", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const client = clientWith(() => Promise.reject(abort));

    try {
      await client.request({ method: "GET", path: "/x" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBe(abort);
      expect(error).not.toBeInstanceOf(RequestBlockedError);
    } finally {
      (Reflect.get(client, "restore") as () => void)();
    }
  });

  it("server error response is not treated as a blocked request", async () => {
    const client = clientWith(() =>
      Promise.resolve(new Response(JSON.stringify({ error: {} }), { status: 500 })),
    );

    try {
      const response = await client.request({ method: "GET", path: "/x" });
      expect(response.status).toBe(500);
    } finally {
      (Reflect.get(client, "restore") as () => void)();
    }
  });
});

describe("content header", () => {
  function capture() {
    const seen: RequestInit[] = [];
    const client = clientWith((_url, init) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    return { client, seen };
  }

  it("does not set content-type when body is absent", async () => {
    const { client, seen } = capture();

    await client.request({ method: "POST", path: "/api/v1/devices/d1/trust" });

    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(seen[0]?.body).toBeUndefined();
  });

  it("sets content-type when body is present", async () => {
    const { client, seen } = capture();

    await client.request({ method: "POST", path: "/api/v1/auth/login", body: { email: "a@b.c" } });

    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(seen[0]?.body).toBe(JSON.stringify({ email: "a@b.c" }));
  });

  it("includes authorization header in both cases", async () => {
    const { client, seen } = capture();

    await client.request({
      method: "POST",
      path: "/api/v1/devices/d1/trust",
      headers: { authorization: "Bearer token" },
    });

    expect((seen[0]?.headers as Record<string, string>).authorization).toBe("Bearer token");
  });
});
