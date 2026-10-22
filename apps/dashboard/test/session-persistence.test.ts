import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/lib/api.js";

describe("dashboard session", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("survives application recreation within the same tab", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              user: { id: "user-1" },
              tokens: { accessToken: "access-for-test", refreshToken: "refresh-for-test" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const first = createSession("http://localhost:3000");
    await first.login("admin@example.test", "test-password");

    const afterRefresh = createSession("http://localhost:3000");
    await expect(afterRefresh.restore()).resolves.toBe(true);
    expect(afterRefresh.isAuthenticated).toBe(true);
  });

  it("clears tab session on logout", async () => {
    const values = new Map([
      ["nexus.access", "access-for-test"],
      ["nexus.refresh", "refresh-for-test"],
    ]);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const session = createSession("http://localhost:3000");
    await session.restore();
    await session.logout();

    expect(values.size).toBe(0);
  });
});
