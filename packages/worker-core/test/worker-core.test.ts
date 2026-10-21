import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Backoff } from "../src/backoff.js";
import { LocalCapabilityRegistry, type LocalCapability } from "../src/capabilities.js";
import { LoopbackLink } from "../src/link.js";
import { MemoryWorkerLogger } from "../src/logging.js";
import { TaskRunner, maskSecretFields, toWireError, withTimeout } from "../src/task-runner.js";
import { CapabilityUnavailableError, ExecutionTimeoutError } from "../src/errors.js";
import type { WorkerPayload } from "@nexus/protocol";

/**
 * Worker core common runtime tests.
 */

function capability(overrides: Partial<LocalCapability<never, unknown>> = {}) {
  return {
    name: "test.echo",
    description: "Echoes received input.",
    inputSchema: z.object({ value: z.string() }),
    riskLevel: "SAFE" as const,
    execute: (input: { value: string }) => Promise.resolve({ echoed: input.value }),
    ...overrides,
  } as unknown as LocalCapability<never, unknown>;
}

describe("capability registry", () => {
  it("advertises registered capabilities", async () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability());
    await registry.probeAll();

    expect(registry.declare().map((entry) => entry.name)).toEqual(["test.echo"]);
  });

  it("rejects duplicate registration", () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability());
    expect(() => registry.register(capability())).toThrow(CapabilityUnavailableError);
  });

  it("omits capabilities when dynamic probe fails", async () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability({ probe: () => Promise.reject(new Error("absent")) }));
    await registry.probeAll();

    expect(registry.declare()).toEqual([]);
  });

  it("reports invalid field path upon input validation failure", () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability());

    expect(() => registry.validateInput("test.echo", { other: 1 })).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_INPUT_INVALID",
        context: expect.objectContaining({
          issues: expect.arrayContaining([expect.stringContaining("value")]),
        }),
      }),
    );
  });

  it("carries risk level in advertised metadata", async () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability({ riskLevel: "HIGH" }));
    await registry.probeAll();

    expect(registry.declare()[0]?.metadata).toEqual({ risk: "HIGH" });
  });
});

describe("redaction of declared secret arguments", () => {
  it("masks fields designated by the capability", () => {
    const masked = maskSecretFields({ selector: "field", text: "MyPassword" }, ["text"]);
    expect(masked).toEqual({ selector: "field", text: "[REDACTED]" });
  });

  it("leaves payload intact without secret field declaration", () => {
    const input = { text: "visible" };
    expect(maskSecretFields(input, undefined)).toBe(input);
    expect(maskSecretFields(input, [])).toBe(input);
  });

  it("ignores missing fields gracefully", () => {
    expect(maskSecretFields({ a: 1 }, ["text"])).toEqual({ a: 1 });
  });

  it("leaves non-object values unchanged", () => {
    expect(maskSecretFields("text", ["text"])).toBe("text");
    expect(maskSecretFields([1, 2], ["text"])).toEqual([1, 2]);
  });
});

describe("wire errors", () => {
  it("respects error code and retryable flag from AppError", () => {
    const wire = toWireError(new ExecutionTimeoutError("test.echo", 1_000));
    expect(wire).toMatchObject({ code: "EXECUTION_TIMEOUT", retryable: true });
  });

  it("redacts raw message of unexpected errors", () => {
    const wire = toWireError(new Error("ENOENT: /home/example/.ssh/id_ed25519"));

    expect(wire.code).toBe("WORKER_INTERNAL_ERROR");
    expect(wire.message).not.toContain("id_ed25519");
    expect(wire.retryable).toBe(false);
  });
});

describe("execution timeout", () => {
  it("passes fast promises", async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, () => undefined, "x")).resolves.toBe(42);
  });

  it("triggers cooperative abort before rejecting", async () => {
    const onTimeout = vi.fn();
    const pending = withTimeout(new Promise(() => undefined), 20, onTimeout, "test.echo");

    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});

describe("step execution", () => {
  function makeRunner(overrides: Partial<LocalCapability<never, unknown>> = {}) {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability(overrides));

    const results: WorkerPayload<"worker.task_result">[] = [];
    const logger = new MemoryWorkerLogger();

    const runner = new TaskRunner({
      capabilities: registry,
      logger,
      sendProgress: () => Promise.resolve(),
      sendResult: (payload) => {
        results.push(payload);
        return Promise.resolve();
      },
      maxConcurrentTasks: 1,
      defaultTimeoutMs: 5_000,
    });

    return { runner, results, logger, registry };
  }

  function dispatch(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
    return {
      taskId: "t1",
      stepId: "s1",
      capability: "test.echo",
      tool: "device.test.echo",
      arguments: { value: "hello" },
      timeoutMs: 1_000,
      riskLevel: "SAFE",
      requestId: "r1",
      ...overrides,
    };
  }

  it("executes and returns result", async () => {
    const { runner, results } = makeRunner();
    await runner.handleDispatch(dispatch());

    expect(results[0]).toMatchObject({ ok: true, result: { echoed: "hello" } });
  });

  it("flags sensitive output when declared by capability", async () => {
    const { runner, results } = makeRunner({ sensitiveResult: true });
    await runner.handleDispatch(dispatch());

    expect(results[0]?.sensitiveResult).toBe(true);
  });

  it("does not log secret arguments", async () => {
    const { runner, logger } = makeRunner({ secretArguments: ["value"] });
    await runner.handleDispatch(dispatch({ arguments: { value: "SecretPass2026" } }));

    expect(logger.text).not.toContain("SecretPass2026");
    expect(logger.text).toContain("REDACTED");
  });

  it("deduplicates redundant requests with same requestId", async () => {
    const { runner, results } = makeRunner();
    await runner.handleDispatch(dispatch());
    await runner.handleDispatch(dispatch());

    expect(results).toHaveLength(1);
  });

  it("never throws unhandled exceptions: all outcomes yield a result", async () => {
    const { runner, results } = makeRunner();
    await expect(
      runner.handleDispatch(dispatch({ capability: "unknown.capability" })),
    ).resolves.toBeUndefined();

    expect(results[0]).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });
});

describe("exponential backoff", () => {
  it("grows and caps at maximum delay", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 8_000, jitter: 0, random: () => 0.5 });
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
  });

  it("resets to initial delay following connection", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0, random: () => 0.5 });
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});

describe("in-memory loopback link", () => {
  it("routes envelopes bidirectionally", async () => {
    const link = new LoopbackLink();
    const received: unknown[] = [];
    link.onMessage((envelope) => received.push(envelope));

    await link.connect();
    await link.send({
      v: 1,
      id: "1",
      type: "worker.hello",
      ts: new Date().toISOString(),
      payload: {},
    });
    link.deliver({ incoming: true });

    expect(link.sent).toHaveLength(1);
    expect(received).toEqual([{ incoming: true }]);
  });

  it("signals close only once", async () => {
    const link = new LoopbackLink();
    const reasons: string[] = [];
    link.onClose((reason) => reasons.push(reason));

    await link.connect();
    await link.close("test");
    await link.close("test");

    expect(reasons).toEqual(["test"]);
  });
});

describe("runtime portability", () => {
  it("imports no node-specific APIs", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const source = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
    const offenders: string[] = [];

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;

        const content = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        if (/from "node:|require\("node:/.test(content)) offenders.push(entry);
        if (/\bprocess\.(stdout|stderr|env)\b/.test(content)) offenders.push(`${entry} (process)`);
      }
    };

    walk(source);
    expect(offenders).toEqual([]);
  });
});
