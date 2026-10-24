import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DashboardApi, createSession } from "../src/lib/api.js";

describe("Phase 2 Supervision and UX Contracts (GA4)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ensures free-form window.prompt permission editing is completely replaced by capability picker", () => {
    const sectionsCode = readFileSync(resolve(__dirname, "../src/ui/Sections.tsx"), "utf8");

    // window.prompt must never be used for permissions
    expect(sectionsCode).not.toContain("window.prompt");
    // Capability picker must offer presets and checkboxes
    expect(sectionsCode).toContain("permission-picker");
    expect(sectionsCode).toContain("PERMISSION_PRESETS");
    expect(sectionsCode).toContain("KNOWN_PERMISSIONS");
    expect(sectionsCode).toContain("mini-latency-bar");
  });

  it("fetches and parses Run Comparison (Codex contract)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "u-1", email: "admin@nexus.test" },
                  tokens: { accessToken: "tok-1", refreshToken: "tok-2" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/runs/compare") {
          expect(parsed.searchParams.get("a")).toBe("run-alpha");
          expect(parsed.searchParams.get("b")).toBe("run-beta");
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  runA: {
                    id: "run-alpha",
                    agentKey: "claude-code",
                    durationMs: 4500,
                    tokenCount: 1200,
                    costEstimateUsd: 0.04,
                    stepCount: 5,
                    status: "completed",
                  },
                  runB: {
                    id: "run-beta",
                    agentKey: "codex-cli",
                    durationMs: 3200,
                    tokenCount: 950,
                    costEstimateUsd: 0.025,
                    stepCount: 4,
                    status: "completed",
                  },
                  diffSummary: {
                    durationDeltaMs: -1300,
                    tokenDelta: -250,
                    fasterRunId: "run-beta",
                    cheaperRunId: "run-beta",
                  },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000", () => undefined);
    await session.login("admin@nexus.test", "secret");
    const api = new DashboardApi(session);

    const comparison = await api.compareRuns("run-alpha", "run-beta");
    expect(comparison.runA.id).toBe("run-alpha");
    expect(comparison.runB.id).toBe("run-beta");
    expect(comparison.diffSummary.fasterRunId).toBe("run-beta");
    expect(comparison.diffSummary.cheaperRunId).toBe("run-beta");
  });

  it("fetches and parses Quota Forecast with confidence levels (Codex contract)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "u-1", email: "admin@nexus.test" },
                  tokens: { accessToken: "tok-1", refreshToken: "tok-2" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/quota/forecast") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  forecasts: [
                    {
                      providerId: "anthropic",
                      accountLabel: "Production Pro",
                      currentUsage: 85000,
                      hardLimit: 100000,
                      estimatedDepletionDate: "2026-11-05T00:00:00.000Z",
                      confidence: "high",
                    },
                    {
                      providerId: "openai",
                      accountLabel: "Dev Tier",
                      currentUsage: 12000,
                      hardLimit: null,
                      estimatedDepletionDate: null,
                      confidence: "unknown",
                      unknownReason: "Uncapped usage plan with pay-as-you-go billing",
                    },
                  ],
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000", () => undefined);
    await session.login("admin@nexus.test", "secret");
    const api = new DashboardApi(session);

    const { forecasts } = await api.quotaForecast();
    expect(forecasts).toHaveLength(2);
    expect(forecasts[0]?.confidence).toBe("high");
    expect(forecasts[1]?.confidence).toBe("unknown");
    expect(forecasts[1]?.unknownReason).toContain("pay-as-you-go");
  });

  it("fetches and controls DAG execution steps (Codex contract)", async () => {
    const postActions: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, _opts?: { method?: string }) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "u-1", email: "admin@nexus.test" },
                  tokens: { accessToken: "tok-1", refreshToken: "tok-2" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/dag/task-99") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  taskId: "task-99",
                  isPaused: false,
                  nodes: [
                    {
                      id: "step-1",
                      label: "Pull repository",
                      status: "completed",
                      dependencies: [],
                      assignedDevice: "worker-desktop",
                    },
                    {
                      id: "step-2",
                      label: "Run test suite",
                      status: "running",
                      dependencies: ["step-1"],
                      assignedDevice: "worker-gpu",
                    },
                  ],
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname.includes("/pause")) {
          postActions.push(parsed.pathname);
          return Promise.resolve(
            new Response(JSON.stringify({ data: { paused: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        if (parsed.pathname.includes("/resume")) {
          postActions.push(parsed.pathname);
          return Promise.resolve(
            new Response(JSON.stringify({ data: { resumed: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000", () => undefined);
    await session.login("admin@nexus.test", "secret");
    const api = new DashboardApi(session);

    const dag = await api.dagDebug("task-99");
    expect(dag.taskId).toBe("task-99");
    expect(dag.nodes).toHaveLength(2);

    const pauseResult = await api.pauseDagStep("task-99", "step-2");
    expect(pauseResult.paused).toBe(true);

    const resumeResult = await api.resumeDagStep("task-99", "step-2");
    expect(resumeResult.resumed).toBe(true);

    expect(postActions).toContain("/api/v1/dashboard/dag/task-99/steps/step-2/pause");
    expect(postActions).toContain("/api/v1/dashboard/dag/task-99/steps/step-2/resume");
  });

  it("inspects inter-agent communication graph and message latencies (Codex contract)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "u-1", email: "admin@nexus.test" },
                  tokens: { accessToken: "tok-1", refreshToken: "tok-2" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/agents/communication-graph") {
          expect(parsed.searchParams.get("range")).toBe("24h");
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  nodes: [
                    { id: "agent-planner", name: "Planner", role: "coordinator", messageCount: 42 },
                    { id: "agent-coder", name: "Coder", role: "developer", messageCount: 38 },
                  ],
                  edges: [
                    {
                      source: "agent-planner",
                      target: "agent-coder",
                      messageCount: 35,
                      avgLatencyMs: 64,
                    },
                  ],
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000", () => undefined);
    await session.login("admin@nexus.test", "secret");
    const api = new DashboardApi(session);

    const graph = await api.communicationGraph("24h");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.avgLatencyMs).toBe(64);
  });

  it("manages Marketplace plugins lifecycle: install, pause, resume, and revoke (Claude contract)", async () => {
    const pluginStates: Record<string, string> = { "plugin-sec": "uninstalled" };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "u-1", email: "admin@nexus.test" },
                  tokens: { accessToken: "tok-1", refreshToken: "tok-2" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/marketplace/plugins") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  plugins: [
                    {
                      id: "plugin-sec",
                      name: "Security Scanner",
                      version: "1.2.0",
                      publisher: "Nexus Verified",
                      description: "Automated vulnerability scanner",
                      status: pluginStates["plugin-sec"],
                      declaredTools: ["security.scan", "security.audit"],
                      reputationScore: 98,
                    },
                  ],
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/marketplace/plugins/plugin-sec/install") {
          pluginStates["plugin-sec"] = "installed";
          return Promise.resolve(
            new Response(JSON.stringify({ data: { success: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/marketplace/plugins/plugin-sec/toggle") {
          const body = JSON.parse(opts?.body ?? "{}");
          pluginStates["plugin-sec"] = body.paused ? "paused" : "installed";
          return Promise.resolve(
            new Response(JSON.stringify({ data: { paused: body.paused } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/marketplace/plugins/plugin-sec/revoke") {
          pluginStates["plugin-sec"] = "revoked";
          return Promise.resolve(
            new Response(JSON.stringify({ data: { revoked: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000", () => undefined);
    await session.login("admin@nexus.test", "secret");
    const api = new DashboardApi(session);

    let catalog = await api.marketplacePlugins();
    expect(catalog.plugins[0]?.status).toBe("uninstalled");

    await api.installPlugin("plugin-sec");
    catalog = await api.marketplacePlugins();
    expect(catalog.plugins[0]?.status).toBe("installed");

    await api.togglePlugin("plugin-sec", true);
    catalog = await api.marketplacePlugins();
    expect(catalog.plugins[0]?.status).toBe("paused");

    await api.revokePlugin("plugin-sec");
    catalog = await api.marketplacePlugins();
    expect(catalog.plugins[0]?.status).toBe("revoked");
  });

  it("inspects Visual Control state and pauses session (Claude contract)", async () => {
    let paused = false;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/v1/auth/login") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  user: { id: "u-1", email: "admin@nexus.test" },
                  tokens: { accessToken: "tok-1", refreshToken: "tok-2" },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/visual-control/status") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  active: true,
                  paused,
                  activeSessionId: "sess-vc-01",
                  lastScreenshotUrl:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                  bounds: { width: 1920, height: 1080 },
                  safetyBoundaryEnforced: true,
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (parsed.pathname === "/api/v1/dashboard/visual-control/pause") {
          const body = JSON.parse(opts?.body ?? "{}");
          paused = body.paused;
          return Promise.resolve(
            new Response(JSON.stringify({ data: { paused } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected path: ${parsed.pathname}`));
      }),
    );

    const session = createSession("http://localhost:3000", () => undefined);
    await session.login("admin@nexus.test", "secret");
    const api = new DashboardApi(session);

    const initial = await api.visualControlStatus();
    expect(initial.active).toBe(true);
    expect(initial.paused).toBe(false);
    expect(initial.safetyBoundaryEnforced).toBe(true);
    expect(initial.bounds).toEqual({ width: 1920, height: 1080 });

    const toggle = await api.toggleVisualControlPause(true);
    expect(toggle.paused).toBe(true);

    const updated = await api.visualControlStatus();
    expect(updated.paused).toBe(true);
  });
});
