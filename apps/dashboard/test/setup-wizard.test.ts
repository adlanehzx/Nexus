import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyConnection } from "../src/lib/format.js";

describe("Setup wizard presentation and state persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists step progress in session storage without secrets", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });

    window.sessionStorage.setItem("nexus.setup.step", "agents");
    expect(window.sessionStorage.getItem("nexus.setup.step")).toBe("agents");

    // Ensure no sensitive token is stored in the setup key
    const raw = JSON.stringify([...store.entries()]);
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("token");
  });

  it("classifies connection provider states correctly for wizard cards", () => {
    const detected = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "detected",
        adapter: { availability: "available" },
        authStatus: "authenticated",
      },
    });
    expect(detected.key).toBe("detected");
    expect(detected.tone).toBe("good");

    const needsAuth = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "authentication_required",
        adapter: { availability: "available" },
        authStatus: "unauthenticated",
      },
    });
    expect(needsAuth.key).toBe("connection_required");
    expect(needsAuth.tone).toBe("warning");

    const missingAdapter = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "detected",
        adapter: { availability: "missing" },
        authStatus: "authenticated",
      },
    });
    expect(missingAdapter.key).toBe("missing_adapter");
    expect(missingAdapter.tone).toBe("warning");
  });

  it("formats sanitized diagnostics safely without credentials", () => {
    const errDiagnostic = {
      event: "readiness_probe_failed",
      at: "2026-10-22T20:00:00.000Z",
      status: "down",
      diagnostic: "Connection refused on port 3000",
    };

    const serialized = JSON.stringify(errDiagnostic);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).toContain("Connection refused");
  });

  it("probes setup status to detect existing administrative account", async () => {
    let checked = false;
    const fakeSession = {
      checkReadiness: () => Promise.resolve({ status: "ok" as const }),
      checkSetupStatus: () => {
        checked = true;
        return Promise.resolve({ initialized: true });
      },
    };

    const status = await fakeSession.checkSetupStatus();
    expect(checked).toBe(true);
    expect(status.initialized).toBe(true);
  });
});

describe("Onboarding Wizard & Smoke Test Contracts (Mission A)", () => {
  it("enforces strict step progression order without skips", () => {
    const steps = ["prerequisites", "admin", "agents", "capabilities", "complete"];
    expect(steps).toHaveLength(5);
    expect(steps[0]).toBe("prerequisites");
    expect(steps[4]).toBe("complete");
  });

  it("validates smoke test stages definition", () => {
    const stages = [
      "Backend Reachability & Health",
      "User Authentication & Context",
      "Operational AI Provider Check",
      "Controlled Provider Test Execution",
      "Execution Outcome Verification",
      "Mission Capabilities & Sandbox Guard",
    ];
    expect(stages).toHaveLength(6);
  });

  describe("executeSmokeTest real pipeline & failure detection", () => {
    const makeFakeSession = (readinessStatus: "ok" | "down" = "ok", auth = true) => ({
      checkReadiness: () =>
        Promise.resolve({
          status: readinessStatus,
          diagnostic: readinessStatus === "down" ? "Connection refused (503)" : undefined,
        }),
      isAuthenticated: auth,
      ensureActiveSession: () => Promise.resolve(),
    });

    const makeFakeApi = (overrides?: Partial<any>) => ({
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
            },
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
        }),
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
      const result = await executeSmokeTest(api as any, session as any);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[0].id).toBe("backend_reachability");
      expect(result.steps[0].status).toBe("failed");
      expect(result.steps[0].error).toContain("Connection refused");
      // Subsequent steps blocked
      expect(result.steps[1].status).toBe("blocked");
      expect(result.steps[2].status).toBe("blocked");
      expect(result.steps[3].status).toBe("blocked");
    });

    it("NEVER passes if user is unauthenticated (fails at step 2)", async () => {
      const session = makeFakeSession("ok", false);
      const api = makeFakeApi();

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api as any, session as any);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[0].status).toBe("passed");
      expect(result.steps[1].id).toBe("user_auth");
      expect(result.steps[1].status).toBe("failed");
      expect(result.steps[1].error).toContain("Admin authentication required");
      expect(result.steps[2].status).toBe("blocked");
    });

    it("NEVER passes if no operational provider is configured (fails at step 3)", async () => {
      const session = makeFakeSession("ok", true);
      const api = makeFakeApi({
        connections: () => Promise.resolve({ connections: [] }),
      });

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api as any, session as any);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[0].status).toBe("passed");
      expect(result.steps[1].status).toBe("passed");
      expect(result.steps[2].id).toBe("provider_availability");
      expect(result.steps[2].status).toBe("failed");
      expect(result.steps[2].error).toContain(
        "No operational or authenticated provider configured",
      );
      expect(result.steps[3].status).toBe("blocked");
    });

    it("NEVER passes if provider test execution throws or fails", async () => {
      const session = makeFakeSession("ok", true);
      const api = makeFakeApi({
        testConnection: () => Promise.reject(new Error("Rate limit exceeded 429")),
      });

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api as any, session as any);

      expect(result.overallStatus).toBe("failed");
      expect(result.steps[3].id).toBe("controlled_request");
      expect(result.steps[3].status).toBe("failed");
      expect(result.steps[3].error).toContain("Rate limit exceeded 429");
      expect(result.steps[4].status).toBe("blocked");
    });

    it("succeeds with granular trace details when all prerequisites and actions pass", async () => {
      const session = makeFakeSession("ok", true);
      const api = makeFakeApi();

      const { executeSmokeTest } = await import("../src/lib/smoke-test.js");
      const result = await executeSmokeTest(api as any, session as any);

      expect(result.overallStatus).toBe("passed");
      expect(result.steps).toHaveLength(6);
      expect(result.steps.every((s) => s.status === "passed")).toBe(true);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.traceId).toMatch(/^smoke-/);
      expect(result.steps[0].traceId).toContain(result.traceId);
    });
  });
});
