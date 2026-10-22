import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardApi, createSession } from "../src/lib/api.js";

describe("Dashboard configuration and account administration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates provider account label and priority via PATCH", async () => {
    let capturedMethod = "";
    let capturedPath = "";
    let capturedBody: unknown = null;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: { method: string; body?: string }) => {
        const path = new URL(url).pathname;
        if (path === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "user-1", email: "admin@example.test" },
                  tokens: { accessToken: "access-token-123", refreshToken: "refresh-token-123" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        capturedMethod = opts.method;
        capturedPath = path;
        if (opts.body) capturedBody = JSON.parse(opts.body);

        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "claude-work",
                name: "Claude Pro Work",
                provider: "claude",
                priority: 1,
                authStatus: "authenticated",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );

    const session = createSession("http://localhost:3000");
    await session.login("admin@example.test", "secure-password");

    const api = new DashboardApi(session);
    const updated = await api.updateProviderAccount("claude-work", {
      name: "Claude Pro Work",
      priority: 1,
    });

    expect(capturedMethod).toBe("PATCH");
    expect(capturedPath).toBe("/api/v1/orchestrator/accounts/claude-work");
    expect(capturedBody).toEqual({ name: "Claude Pro Work", priority: 1 });
    expect(updated.name).toBe("Claude Pro Work");
  });

  it("saves external notification configuration", async () => {
    let capturedMethod = "";
    let capturedPath = "";
    let capturedBody: unknown = null;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: { method: string; body?: string }) => {
        const path = new URL(url).pathname;
        if (path === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "user-1", email: "admin@example.test" },
                  tokens: { accessToken: "access-token-123", refreshToken: "refresh-token-123" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        capturedMethod = opts.method;
        capturedPath = path;
        if (opts.body) capturedBody = JSON.parse(opts.body);

        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { saved: true },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );

    const session = createSession("http://localhost:3000");
    await session.login("admin@example.test", "secure-password");

    const api = new DashboardApi(session);
    const result = await api.saveNotificationConfig({
      enabled: true,
      desktop: { enabled: true, urgency: "normal" },
      ntfy: { enabled: true, serverUrl: "https://ntfy.sh", topic: "nexus-alerts" },
      quietHours: {
        enabled: false,
        start: "22:00",
        end: "08:00",
        timezone: "UTC",
        allowUrgent: true,
      },
      grouping: { enabled: true, windowSeconds: 60 },
      dashboardBaseUrl: "http://localhost:3000",
    });

    expect(capturedMethod).toBe("PUT");
    expect(capturedPath).toBe("/api/v1/dashboard/notifications/config");
    expect((capturedBody as { ntfy: { topic: string } }).ntfy.topic).toBe("nexus-alerts");
    expect(result.saved).toBe(true);
  });
});
