import { describe, expect, it } from "vitest";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import { makeHarness, settle, until, waitFor, type BrowserHarness } from "./fixtures.js";

/**
 * Complete chain from core to browser HTTP contract.
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-nav",
      stepId: `step-${String(sequence)}`,
      capability: "browser.navigate",
      tool: "device.browser.navigate",
      arguments: { instructions: "check ticket price" },
      timeoutMs: 30_000,
      riskLevel: "LOW",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

function results(harness: BrowserHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: BrowserHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await waitFor(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core session
// ─────────────────────────────────────────────────────────────────────────────

describe("core session", () => {
  it("authenticates via challenge signature like other workers", async () => {
    const harness = await makeHarness();
    await harness.connect();

    expect(harness.host.isAuthenticated).toBe(true);
    expect(harness.host.state).toBe("ready");
  });

  it("announces its four capabilities to core registry", async () => {
    const harness = await makeHarness();
    await harness.connect();
    await until(async () => {
      const device = await harness.registry.requireDevice(harness.device.id);
      return device.capabilities.length > 0;
    });

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities.map((entry) => entry.name).sort()).toEqual([
      "browser.interact",
      "browser.login",
      "browser.navigate",
      "browser.purchase",
    ]);
  });

  it("announces nothing when Python worker does not respond", async () => {
    const harness = await makeHarness({ seed: (python) => (python.unreachable = true) });
    await harness.connect();
    await settle(30);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities).toEqual([]);
    expect(harness.host.health.isDegraded()).toBe(true);
  });

  it("untrusted device does not obtain a session", async () => {
    const harness = await makeHarness({ trusted: false });
    await harness.host.start();
    await settle(30);

    expect(harness.host.isAuthenticated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step execution from core
// ─────────────────────────────────────────────────────────────────────────────

describe("step execution from core", () => {
  it("traverses entire chain and returns result", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const result = await dispatch(harness);

    expect(result?.ok).toBe(true);
    expect(harness.python.launched).toHaveLength(1);
    expect(harness.python.launched[0]?.intent).toBe("read");
  });

  it("rejects capability not held by this worker", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const result = await dispatch(harness, {
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { command: "whoami" },
      riskLevel: "HIGH",
    });

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("rejects capability removed by local configuration", async () => {
    const harness = await makeHarness({
      config: { declaredCapabilities: ["browser.navigate"] },
    });
    await harness.connect();

    const result = await dispatch(harness, {
      capability: "browser.purchase",
      tool: "device.browser.purchase",
      arguments: { instructions: "purchase the ticket" },
      riskLevel: "CRITICAL",
    });

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("validates arguments before opening browser", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const result = await dispatch(harness, { arguments: { instructions: "" } });

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("CAPABILITY_INPUT_INVALID");
    expect(harness.python.sessions).toEqual([]);
  });

  it("reports progress to core during navigation", async () => {
    const harness = await makeHarness({
      seed: (python) => {
        python.outcome = {
          status: "succeeded",
          output: "$129",
          steps: 2,
          events: [
            {
              type: "progress",
              taskId: "task-nav-step-1",
              sessionId: "sess-1",
              seq: 1,
              ts: new Date().toISOString(),
              step: 1,
              maxSteps: 4,
              note: null,
            },
          ],
        };
      },
    });
    await harness.connect();
    await dispatch(harness);

    const progress = harness.link.sent.filter(
      (envelope) => envelope.type === WORKER_MESSAGE.taskProgress,
    );
    expect(progress.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Browser session isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("browser session isolation", () => {
  it("reuses same session for steps of same task", async () => {
    const harness = await makeHarness();
    await harness.connect();

    await dispatch(harness, { taskId: "task-a" });
    await dispatch(harness, { taskId: "task-a" });

    expect(harness.python.sessions).toHaveLength(1);
    expect(harness.python.launched.map((entry) => entry.sessionId)).toEqual(["sess-1", "sess-1"]);
  });

  it("never uses same session for two different tasks", async () => {
    const harness = await makeHarness();
    await harness.connect();

    await dispatch(harness, { taskId: "task-a" });
    await dispatch(harness, { taskId: "task-b" });

    expect(harness.python.sessions).toHaveLength(2);
    const used = new Set(harness.python.launched.map((entry) => entry.sessionId));
    expect(used.size).toBe(2);
  });

  it("transmits domain lists to Python worker", async () => {
    const harness = await makeHarness({
      config: {
        allowedDomains: ["example.com"],
        prohibitedDomains: ["ads.example.com"],
      },
    });
    await harness.connect();
    await dispatch(harness);

    expect(harness.python.requestedDomains[0]).toEqual({
      allowed: ["example.com"],
      prohibited: ["ads.example.com"],
    });
  });

  it("closes browsers on shutdown", async () => {
    const harness = await makeHarness();
    await harness.connect();
    await dispatch(harness, { taskId: "task-a" });

    await harness.host.stop("test teardown");

    expect(harness.python.closedSessions).toEqual(["sess-1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Core selection
// ─────────────────────────────────────────────────────────────────────────────

describe("core selection", () => {
  it("selector picks browser worker on capability, not name", async () => {
    const harness = await makeHarness();
    await harness.connect();
    await until(async () => {
      const device = await harness.registry.requireDevice(harness.device.id);
      return device.capabilities.length > 0;
    });

    const plan = createTaskPlan({
      userId: "user-example",
      title: "Check price",
      originClientDeviceId: harness.device.id,
      correlationId: "corr-browser",
      steps: [
        {
          id: "s1",
          description: "Check price",
          requiredCapabilities: ["browser.navigate"],
          tool: "device.browser.navigate",
          arguments: { instructions: "ticket price" },
          riskLevel: "LOW",
        },
      ],
    });

    const chosen = await harness.selector.select({
      userId: "user-example",
      requiredCapabilities: ["browser.navigate"],
    });

    expect(chosen.device.id).toBe(harness.device.id);
    expect(plan.steps).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Cancellation
// ───────────────────────────────────────────────────────────────────────────────

describe("cancellation", () => {
  it("propagates cancellation from core to browser", async () => {
    const harness = await makeHarness({
      seed: (python) => {
        python.outcome = { status: "running", hangUntilCancelled: true };
      },
    });
    await harness.connect();

    const envelope = dispatchEnvelope({ taskId: "task-long", stepId: "step-long" });
    harness.link.deliver(envelope);
    await waitFor(() => harness.python.launched.length > 0);

    harness.link.deliver(
      workerEnvelope(
        WORKER_MESSAGE.taskCancel,
        { taskId: "task-long", stepId: "step-long", reason: "user aborted" },
        { id: "env-cancel", at: new Date() },
      ),
    );

    await waitFor(() => harness.python.cancelled.length > 0);
    expect(harness.python.cancelled[0]).toContain("task-long");
  });

  it("returns cancelled step to core rather than silent success", async () => {
    const harness = await makeHarness({
      seed: (python) => {
        python.outcome = { status: "running", hangUntilCancelled: true };
      },
    });
    await harness.connect();

    harness.link.deliver(dispatchEnvelope({ taskId: "task-x", stepId: "step-x" }));
    await waitFor(() => harness.python.launched.length > 0);

    harness.link.deliver(
      workerEnvelope(
        WORKER_MESSAGE.taskCancel,
        { taskId: "task-x", stepId: "step-x", reason: "stop" },
        { id: "env-cancel-2", at: new Date() },
      ),
    );

    await waitFor(() => results(harness).some((entry) => entry.stepId === "step-x"));
    const result = results(harness).find((entry) => entry.stepId === "step-x");

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBeTruthy();
  });
});
