import { describe, expect, it } from "vitest";
import {
  STEP_ORDER,
  getStepIndex,
  getStepProgress,
  isStepOptional,
  type WizardStep,
} from "../src/ui/SetupWizard.js";
import type { ConnectionCatalogEntry } from "../src/lib/api.js";
import type { MinimalSession, SmokeTestApi } from "../src/lib/smoke-test.js";

describe("SetupWizard navigation & progression logic", () => {
  it("defines standard chronological ordering of setup steps", () => {
    expect(STEP_ORDER).toEqual(["prerequisites", "admin", "agents", "capabilities", "complete"]);
  });

  it("identifies optional and mandatory steps accurately", () => {
    expect(isStepOptional("capabilities")).toBe(true);
    expect(isStepOptional("prerequisites")).toBe(false);
    expect(isStepOptional("admin")).toBe(false);
    expect(isStepOptional("agents")).toBe(false);
    expect(isStepOptional("complete")).toBe(false);
  });

  it("calculates progress percentage correctly across steps", () => {
    expect(getStepProgress("prerequisites")).toBe(0);
    expect(getStepProgress("admin")).toBe(25);
    expect(getStepProgress("agents")).toBe(50);
    expect(getStepProgress("capabilities")).toBe(75);
    expect(getStepProgress("complete")).toBe(100);
  });

  it("handles step index lookup robustly", () => {
    expect(getStepIndex("prerequisites")).toBe(0);
    expect(getStepIndex("complete")).toBe(4);
    expect(getStepIndex("unknown" as WizardStep)).toBe(0);
  });

  describe("executeSmokeTest real pipeline & failure detection", () => {
    const makeFakeSession = (
      readinessStatus: "ok" | "down" = "ok",
      auth = true,
    ): MinimalSession => ({
      checkReadiness: () =>
        Promise.resolve({
          status: readinessStatus,
          diagnostic: readinessStatus === "down" ? "Connection refused (503)" : undefined,
        }),
      isAuthenticated: auth,
      ensureActiveSession: () => Promise.resolve(),
    });

    const makeFakeApi = (overrides?: Partial<SmokeTestApi>): SmokeTestApi => ({
      connections: () =>
        Promise.resolve({
          connections: [
            {
              providerId: "anthropic",
              displayName: "Anthropic Claude",
              supportedOnThisHost: true,
              observation: {
                state: "connected",
                authStatus: "authenticated",
                adapter: { availability: "available" },
              },
            } as unknown as ConnectionCatalogEntry,
          ],
        }),
      testConnection: (providerId: string) =>
        Promise.resolve({
          providerId,
          displayName: "Anthropic Claude",
          supportedOnThisHost: true,
          observation: {
            state: "connected",
            authStatus: "authenticated",
            userMessage: "Connection validated",
          },
        } as unknown as ConnectionCatalogEntry),
      tools: () =>
        Promise.resolve({
          tools: [{ name: "terminal.execute" }, { name: "file.read" }],
        }),
      ...overrides,
    });

    it("NEVER passes if backend is down (fails immediately at step 1)", async () => {
      const session = makeFakeSession("down", true);
      const api = makeFakeApi();

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api, session);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[0]?.id).toBe("backend_reachability");
      expect(result.steps[0]?.status).toBe("failed");
      expect(result.steps[0]?.error).toContain("Connection refused");
      // Subsequent steps blocked
      expect(result.steps[1]?.status).toBe("blocked");
      expect(result.steps[2]?.status).toBe("blocked");
      expect(result.steps[3]?.status).toBe("blocked");
    });

    it("NEVER passes if user is unauthenticated (fails at step 2)", async () => {
      const session = makeFakeSession("ok", false);
      const api = makeFakeApi();

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api, session);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[1]?.id).toBe("user_auth");
      expect(result.steps[1]?.status).toBe("failed");
      expect(result.steps[1]?.error).toContain("Admin authentication required");
      expect(result.steps[2]?.status).toBe("blocked");
    });

    it("NEVER passes if no operational provider is configured (fails at step 3)", async () => {
      const session = makeFakeSession("ok", true);
      const api = makeFakeApi({
        connections: () => Promise.resolve({ connections: [] }),
      });

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api, session);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[1]?.status).toBe("passed");
      expect(result.steps[2]?.id).toBe("provider_availability");
      expect(result.steps[2]?.status).toBe("failed");
      expect(result.steps[2]?.error).toContain(
        "No operational or authenticated provider configured",
      );
      expect(result.steps[3]?.status).toBe("blocked");
    });

    it("NEVER passes if provider test execution throws or fails", async () => {
      const session = makeFakeSession("ok", true);
      const api = makeFakeApi({
        testConnection: () => Promise.reject(new Error("Rate limit exceeded 429")),
      });

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api, session);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[3]?.id).toBe("controlled_request");
      expect(result.steps[3]?.status).toBe("failed");
      expect(result.steps[3]?.error).toContain("Rate limit exceeded 429");
      expect(result.steps[4]?.status).toBe("blocked");
    });

    it("succeeds with granular trace details when all prerequisites and actions pass", async () => {
      const session = makeFakeSession("ok", true);
      const api = makeFakeApi();

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api, session);

      expect(result.overallStatus).toBe("passed");
      expect(result.steps).toHaveLength(6);
      expect(result.steps.every((s) => s.status === "passed")).toBe(true);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.traceId).toMatch(/^smoke-/);
      expect(result.steps[0]?.traceId).toContain(result.traceId);
    });

    it("executes Level 2 controlled real Agent Core run with proof when requested", async () => {
      const session = makeFakeSession("ok", true);
      const api = makeFakeApi({
        createConversation: () => Promise.resolve({ id: "conv-smoke-test-123" }),
        createAgentRun: () =>
          Promise.resolve({
            id: "run-smoke-test-456",
            status: "succeeded",
            output: "PONG_OK 2026-11-05T22:00:00Z",
          }),
      });

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api, session, { level: 2 });

      expect(result.overallStatus).toBe("passed");
      expect(result.steps).toHaveLength(7);
      expect(result.steps[6]?.id).toBe("agent_core_run");
      expect(result.steps[6]?.status).toBe("passed");
      expect(result.proof?.conversationId).toBe("conv-smoke-test-123");
      expect(result.proof?.runId).toBe("run-smoke-test-456");
      expect(result.proof?.controlledResult).toContain("PONG_OK");
    });
  });
});
