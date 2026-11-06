import { describe, expect, it, vi } from "vitest";
import { executeSmokeTest, type MinimalSession, type SmokeTestApi } from "../src/lib/smoke-test.js";
import type { ConnectionCatalogEntry } from "../src/lib/api.js";

function createMockApi() {
  const provider: ConnectionCatalogEntry = {
    providerId: "anthropic",
    displayName: "Anthropic",
    kind: "acp",
    platforms: ["linux"],
    supportedOnThisHost: true,
    actions: ["test"],
    docsUrl: null,
    adapter: {
      provenance: "official",
      provenanceEvidence: "signed",
    },
    observation: {
      id: "obs-1",
      providerId: "anthropic",
      kind: "acp",
      displayName: "Anthropic",
      state: "connected",
      version: "1.0",
      executablePath: "/usr/bin/node",
      capabilities: ["chat"],
      availableActions: ["test"],
      platform: "linux",
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      authStatus: "authenticated",
      errorCategory: null,
      userMessage: null,
      requiresHumanAction: false,
      adapter: null,
    },
  };

  const connections = vi.fn().mockResolvedValue({ connections: [provider] });
  const testConnection = vi.fn().mockResolvedValue(provider);
  const tools = vi.fn().mockResolvedValue({
    tools: [{ name: "device.terminal.execute", description: "Runs terminal command" }],
  });
  const createConversation = vi.fn().mockResolvedValue({ id: "conv-smoke-test-123" });
  const createAgentRun = vi.fn().mockResolvedValue({
    id: "run-smoke-test-456",
    status: "completed",
    output: "Deterministic probe ok",
  });
  const getAgentRun = vi.fn().mockResolvedValue({
    id: "run-smoke-test-456",
    status: "completed",
    output: "Deterministic probe ok",
  });

  const archiveConversation = vi.fn().mockResolvedValue(undefined);

  const api: SmokeTestApi = {
    connections,
    testConnection,
    tools,
    createConversation,
    createAgentRun,
    getAgentRun,
    archiveConversation,
  };

  return {
    api,
    mocks: {
      connections,
      testConnection,
      tools,
      createConversation,
      createAgentRun,
      getAgentRun,
      archiveConversation,
    },
  };
}

function createMockSession(
  status: "ok" | "degraded" | "down" = "ok",
  authenticated = true,
): MinimalSession {
  return {
    checkReadiness: vi.fn().mockResolvedValue({ status }),
    isAuthenticated: authenticated,
    ensureActiveSession: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Dashboard Smoke Test Engine", () => {
  it("executes Level 1 diagnostic smoke test successfully across all 6 steps", async () => {
    const { api, mocks } = createMockApi();
    const session = createMockSession("ok", true);

    const result = await executeSmokeTest(api, session, { level: 1 });

    expect(result.overallStatus).toBe("passed");
    expect(result.steps).toHaveLength(6);
    expect(result.steps.every((s) => s.status === "passed")).toBe(true);

    const stepIds = result.steps.map((s) => s.id);
    expect(stepIds).toEqual([
      "backend_reachability",
      "user_auth",
      "provider_availability",
      "controlled_request",
      "verify_outcome",
      "capabilities_sandbox",
    ]);

    expect(mocks.connections).toHaveBeenCalled();
    expect(mocks.testConnection).toHaveBeenCalledWith("anthropic");
    expect(mocks.tools).toHaveBeenCalled();
    expect(mocks.createAgentRun).not.toHaveBeenCalled(); // Level 1 is non-billable
  });

  it("blocks subsequent steps when backend reachability fails", async () => {
    const { api, mocks } = createMockApi();
    const session = createMockSession("down", true);

    const result = await executeSmokeTest(api, session, { level: 1 });

    expect(result.overallStatus).toBe("failed");
    expect(result.steps[0]?.id).toBe("backend_reachability");
    expect(result.steps[0]?.status).toBe("failed");

    // All downstream steps must be blocked
    const downstream = result.steps.slice(1);
    expect(downstream.length).toBeGreaterThan(0);
    expect(downstream.every((s) => s.status === "blocked")).toBe(true);
    expect(mocks.testConnection).not.toHaveBeenCalled();
  });

  it("fails user authentication step when session is unauthenticated and blocks remaining steps", async () => {
    const { api } = createMockApi();
    const session = createMockSession("ok", false);

    const result = await executeSmokeTest(api, session, { level: 1 });

    expect(result.overallStatus).toBe("failed");
    expect(result.steps[0]?.id).toBe("backend_reachability");
    expect(result.steps[0]?.status).toBe("passed");

    expect(result.steps[1]?.id).toBe("user_auth");
    expect(result.steps[1]?.status).toBe("failed");

    const downstream = result.steps.slice(2);
    expect(downstream.every((s) => s.status === "blocked")).toBe(true);
  });

  it("executes Level 2 controlled real agent core run with explicit consent and generates proof", async () => {
    const { api } = createMockApi();
    const session = createMockSession("ok", true);

    const result = await executeSmokeTest(api, session, {
      level: 2,
      allowBillableRequests: true,
      selectedProviderId: "anthropic",
    });

    expect(result.overallStatus).toBe("passed");
    expect(result.steps).toHaveLength(7);
    expect(result.steps[6]?.id).toBe("agent_core_run");
    expect(result.steps[6]?.status).toBe("passed");

    expect(result.proof).toBeDefined();
    expect(result.proof?.conversationId).toBe("conv-smoke-test-123");
    expect(result.proof?.runId).toBe("run-smoke-test-456");
    expect(result.proof?.status).toBe("completed");
    expect(result.proof?.controlledResult).toContain("Deterministic probe ok");
  });

  it("skips Level 2 execution if billable requests are not explicitly allowed", async () => {
    const { api, mocks } = createMockApi();
    const session = createMockSession("ok", true);

    const result = await executeSmokeTest(api, session, {
      level: 2,
      allowBillableRequests: false,
    });

    expect(result.overallStatus).toBe("passed");
    expect(result.steps).toHaveLength(7);
    expect(result.steps[6]?.id).toBe("agent_core_run");
    expect(result.steps[6]?.status).toBe("skipped");
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("fails step 7 if Agent Core run produces empty output instead of falling back to fake string", async () => {
    const { api, mocks } = createMockApi();
    mocks.createAgentRun.mockResolvedValueOnce({
      id: "run-empty-output",
      status: "succeeded",
      output: "", // Empty output!
    });
    const session = createMockSession("ok", true);

    const result = await executeSmokeTest(api, session, {
      level: 2,
      allowBillableRequests: true,
    });

    expect(result.overallStatus).toBe("failed");
    expect(result.steps[6]?.id).toBe("agent_core_run");
    expect(result.steps[6]?.status).toBe("failed");
    expect(result.steps[6]?.error).toContain("empty or missing response payload");
    expect(mocks.archiveConversation).toHaveBeenCalledWith("conv-smoke-test-123");
  });

  it("fails step 7 if Agent Core run ends in failed status", async () => {
    const { api, mocks } = createMockApi();
    mocks.createAgentRun.mockResolvedValueOnce({
      id: "run-failed",
      status: "failed",
      output: undefined,
    });
    const session = createMockSession("ok", true);

    const result = await executeSmokeTest(api, session, {
      level: 2,
      allowBillableRequests: true,
    });

    expect(result.overallStatus).toBe("failed");
    expect(result.steps[6]?.id).toBe("agent_core_run");
    expect(result.steps[6]?.status).toBe("failed");
    expect(result.steps[6]?.error).toContain("terminal succeeded state");
    expect(mocks.archiveConversation).toHaveBeenCalledWith("conv-smoke-test-123");
  });

  it("polls for terminal succeeded state when run starts in running state", async () => {
    const { api, mocks } = createMockApi();
    mocks.createAgentRun.mockResolvedValueOnce({
      id: "run-polling",
      status: "running",
    });
    mocks.getAgentRun.mockResolvedValueOnce({
      id: "run-polling",
      status: "succeeded",
      output: "Poll completed with actual LLM generation",
    });
    const session = createMockSession("ok", true);

    const result = await executeSmokeTest(api, session, {
      level: 2,
      allowBillableRequests: true,
    });

    expect(result.overallStatus).toBe("passed");
    expect(result.steps[6]?.status).toBe("passed");
    expect(result.proof?.controlledResult).toBe("Poll completed with actual LLM generation");
    expect(mocks.getAgentRun).toHaveBeenCalledWith("run-polling");
    expect(mocks.archiveConversation).toHaveBeenCalledWith("conv-smoke-test-123");
  });
});
