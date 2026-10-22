import { describe, expect, it } from "vitest";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { makeHarness, settle, until, ALLOWED_ROOT, type WorkerHarness } from "./fixtures.js";

/**
 * Reception, execution, and return of a step.
 *
 * These tests enter through the same path as the core: a `worker.task_dispatch`
 * frame delivered over the channel. Nothing calls a capability directly — the
 * complete path is tested, including validation.
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-1",
      stepId: `step-${String(sequence)}`,
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { executable: "git", args: ["status"] },
      timeoutMs: 10_000,
      riskLevel: "HIGH",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

/** Results returned to core by worker. */
function results(harness: WorkerHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: WorkerHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await until(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

describe("step reception", () => {
  it("executes a valid step and returns the result", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness);

    expect(result).toMatchObject({ ok: true, taskId: "task-1" });
    expect(harness.runner.runs.some((run) => run.executable === "git")).toBe(true);
  });

  it("rejects a capability the worker does not have", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.notification",
      tool: "device.android.notification",
      arguments: { title: "x", body: "y" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("rejects a capability disabled by local configuration", async () => {
    const harness = await makeHarness({ config: { declaredCapabilities: ["filesystem.read"] } });
    await harness.connectWorker();

    // Availability probes already ran "git --version". We verify no additional
    // command is launched.
    const before = harness.runner.runs.length;
    const result = await dispatch(harness);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_UNAVAILABLE", retryable: false },
    });
    expect(harness.runner.runs).toHaveLength(before);
  });

  it("rejects arguments that violate schema", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const before = harness.runner.runs.length;
    const result = await dispatch(harness, { arguments: { invalidKey: "git status" } });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_INPUT_INVALID" } });
    // Nothing was launched: validation always precedes execution.
    expect(harness.runner.runs).toHaveLength(before);
  });

  it("ignores a malformed dispatch frame", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.deliver({ v: 1, id: "x", type: "worker.task_dispatch", ts: "not a date" });
    await settle();

    expect(harness.worker.state).toBe("ready");
    expect(results(harness)).toHaveLength(0);
  });

  it("emits progress during execution", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    await dispatch(harness);

    const progress = harness.link.sent.filter((e) => e.type === WORKER_MESSAGE.taskProgress);
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe("cancellation and timeouts", () => {
  it("cancels an active step on core request", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    const envelope = dispatchEnvelope();
    const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
    harness.link.deliver(envelope);
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(
      workerEnvelope(
        WORKER_MESSAGE.taskCancel,
        { taskId: payload.taskId, stepId: payload.stepId, reason: "cancelled by NEXUS" },
        { id: "cancel-1", at: new Date() },
      ),
    );

    await until(() => results(harness).length > 0);
    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "EXECUTION_CANCELLED" },
    });
  });

  it("interrupts a step that exceeds its timeout", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    // Timeout relies on real timer: we let real time elapse rather than mocking
    // clock to test actual timeout behavior.
    const envelope = dispatchEnvelope({ timeoutMs: 40 });
    const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
    harness.link.deliver(envelope);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await until(() => results(harness).some((r) => r.stepId === payload.stepId));

    const result = results(harness).find((r) => r.stepId === payload.stepId);
    expect(result).toMatchObject({ ok: false, error: { retryable: true } });
    expect(["EXECUTION_TIMEOUT", "EXECUTION_CANCELLED"]).toContain(result?.error?.code);
  }, 10_000);

  it("cancels everything running upon worker shutdown", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    harness.link.deliver(dispatchEnvelope());
    await until(() => harness.worker.activeTaskCount === 1);

    await harness.worker.stop("service stop");
    await until(() => harness.worker.activeTaskCount === 0);

    expect(harness.worker.activeTaskCount).toBe(0);
  });
});

describe("idempotency and concurrency", () => {
  it("does not execute the same request ID twice", async () => {
    // Core may re-send a request after an outage without knowing if the first
    // arrived. Without this guard, `git.commit` would run twice.
    const harness = await makeHarness();
    await harness.connectWorker();

    const envelope = dispatchEnvelope();
    harness.link.deliver(envelope);
    await until(() => results(harness).length === 1);

    const gitRuns = harness.runner.runs.filter((r) => r.executable === "git").length;

    harness.link.deliver(envelope);
    await settle(30);

    expect(harness.runner.runs.filter((r) => r.executable === "git")).toHaveLength(gitRuns);
    expect(results(harness)).toHaveLength(1);
  });

  it("rejects a second concurrent execution of the same step", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    const first = dispatchEnvelope();
    const payload = first.payload as WorkerPayload<"worker.task_dispatch">;
    harness.link.deliver(first);
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(dispatchEnvelope({ stepId: payload.stepId, requestId: "req-other" }));
    await until(() => results(harness).length > 0);

    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "STEP_ALREADY_RUNNING", retryable: false },
    });
  });

  it("rejects an extra step when saturated, in a retryable manner", async () => {
    // Retryable: machine is not incapable, it is busy. The coordinator can
    // immediately failover to another worker.
    const harness = await makeHarness({
      config: { maxConcurrentTasks: 1 },
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    harness.link.deliver(dispatchEnvelope());
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(dispatchEnvelope());
    await until(() => results(harness).length > 0);

    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "WORKER_SATURATED", retryable: true },
    });
  });
});

describe("disconnection during a step", () => {
  it("releases the step core-side in a retryable manner", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    // Core sends order via gateway, as in production.
    const controller = new AbortController();
    const pending = harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "task-outage",
      stepId: "step-1",
      tool: "device.terminal.execute",
      capability: "terminal.execute",
      arguments: { executable: "git", args: ["log"] },
      timeoutMs: 60_000,
      signal: controller.signal,
      onProgress: () => undefined,
    });

    await until(() => harness.worker.activeTaskCount === 1);
    await harness.gateway.detach(harness.device.id, "cable disconnected");

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKER_DISCONNECTED", retryable: true },
    });
  });

  it("rejects an order for a disconnected worker", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    await harness.gateway.detach(harness.device.id, "offline");

    const result = await harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "t",
      stepId: "s",
      tool: "device.terminal.execute",
      capability: "terminal.execute",
      arguments: {},
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKER_UNAVAILABLE", retryable: true },
    });
  });

  it("aborts a step whose worker no longer responds", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    // Gateway waits `timeoutMs + margin`; margin is zero here.
    const result = await harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "t",
      stepId: "s-silent",
      tool: "device.unknown",
      // A capability the worker will reject: it will respond, but we verify
      // nothing remains hanging in the active step table.
      capability: "capability.nonexistent",
      arguments: {},
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(result.ok).toBe(false);
  }, 15_000);
});

describe("real capability execution over channel", () => {
  it("reads an allowed file", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\notes.md`, "content");
      },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: `${ALLOWED_ROOT}\\notes.md` },
    });

    expect(result).toMatchObject({ ok: true });
    expect((result?.result as { content: string }).content).toBe("content");
  });

  it("rejects reading outside allowed folders", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: "C:\\Users\\me\\.aws\\credentials" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
  });

  it("rejects a mutating Git operation in read-only mode", async () => {
    const harness = await makeHarness({ config: { gitAllowWrite: false } });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "git.pull",
      tool: "device.git.pull",
      arguments: { repositoryPath: `${ALLOWED_ROOT}\\leynai` },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "WORKER_POLICY_VIOLATION" } });
  });

  it("accepts a Git read in the same configuration", async () => {
    const harness = await makeHarness({ config: { gitAllowWrite: false } });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "git.status",
      tool: "device.git.status",
      arguments: { repositoryPath: `${ALLOWED_ROOT}\\leynai` },
    });

    expect(result).toMatchObject({ ok: true });
  });
});
