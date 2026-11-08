import { describe, expect, it, vi, afterEach } from "vitest";
import { DashboardApi, createSession } from "../src/lib/api.js";

describe("NexusChat engine & model options", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes profile, model, and reasoningEffort to /orchestrator/messages when provided", async () => {
    let capturedBody: {
      message?: string;
      profile?: string;
      model?: string;
      reasoningEffort?: string;
    } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: {
                  user: { id: "user-1", email: "user@test.org", role: "USER" },
                  tokens: { accessToken: "access-token-123", refreshToken: "refresh-token-123" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (parsed.pathname === "/api/v1/orchestrator/messages") {
          if (init?.body) {
            capturedBody = JSON.parse(init.body as string);
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: {
                  missionId: "11111111-2222-3333-4444-555555555555",
                  status: "running",
                  state: "running",
                  title: "Test Mission",
                  response: null,
                  error: null,
                  workspace: "/tmp/workspace",
                  runs: [],
                  schedule: null,
                },
              }),
              { status: 202, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000");
    await session.login("user@test.org", "secret-password");
    const api = new DashboardApi(session);

    await api.sendToNexus("Diagnose performance bottleneck", {
      profile: "claude-code",
      model: "claude-3-7-sonnet",
      reasoningEffort: "high",
    });

    expect(capturedBody).not.toBeNull();
    const body = capturedBody!;
    expect(body.message).toBe("Diagnose performance bottleneck");
    expect(body.profile).toBe("claude-code");
    expect(body.model).toBe("claude-3-7-sonnet");
    expect(body.reasoningEffort).toBe("high");
  });

  it("omits profile, model, and reasoningEffort when auto mode is selected", async () => {
    let capturedBody: {
      message?: string;
      profile?: string;
      model?: string;
      reasoningEffort?: string;
    } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: {
                  user: { id: "user-1", email: "user@test.org", role: "USER" },
                  tokens: { accessToken: "access-token-123", refreshToken: "refresh-token-123" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (parsed.pathname === "/api/v1/orchestrator/messages") {
          if (init?.body) {
            capturedBody = JSON.parse(init.body as string);
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: {
                  missionId: "11111111-2222-3333-4444-555555555555",
                  status: "running",
                  state: "running",
                  title: "Test Mission",
                  response: null,
                  error: null,
                  workspace: "/tmp/workspace",
                  runs: [],
                  schedule: null,
                },
              }),
              { status: 202, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000");
    await session.login("user@test.org", "secret-password");
    const api = new DashboardApi(session);

    await api.sendToNexus("Auto routed message");

    expect(capturedBody).not.toBeNull();
    const body = capturedBody!;
    expect(body.message).toBe("Auto routed message");
    expect(body.profile).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.reasoningEffort).toBeUndefined();
  });
});
