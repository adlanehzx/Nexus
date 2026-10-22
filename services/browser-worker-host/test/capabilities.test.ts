import { describe, expect, it } from "vitest";
import type { CapabilityContext, LocalCapabilityRegistry } from "@nexus/worker-core";
import { BrowserWorkerClient } from "@nexus/browser-client";
import { assembleBrowserHost } from "../src/assemble.js";
import { BROWSER_INTENTS, browseInputSchema } from "../src/capabilities/browse.js";
import { BROWSER_TOKEN, FakeBrowserWorker, testConfig } from "./fixtures.js";

/**
 * Browser capabilities tested in isolation.
 */

interface Rig {
  registry: LocalCapabilityRegistry;
  python: FakeBrowserWorker;
  sessions: ReturnType<typeof assembleBrowserHost>["sessions"];
}

function rig(overrides: Parameters<typeof testConfig>[0] = {}): Rig {
  const config = testConfig(overrides);
  const python = new FakeBrowserWorker(BROWSER_TOKEN);
  const client = new BrowserWorkerClient({
    baseUrl: config.browserWorkerUrl,
    token: config.browserWorkerToken,
    fetchImpl: python.fetch,
  });
  const assembled = assembleBrowserHost({ config, client });
  return { registry: assembled.capabilities, python, sessions: assembled.sessions };
}

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    taskId: "task-1",
    stepId: "step-1",
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    onProgress: () => undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability declaration
// ─────────────────────────────────────────────────────────────────────────────

describe("capability declaration", () => {
  it("exposes one capability per intent rather than a generic capability", () => {
    const { registry } = rig();

    expect(registry.names).toEqual([
      "browser.interact",
      "browser.login",
      "browser.navigate",
      "browser.purchase",
    ]);
  });

  it("graduates risk from read to purchase", () => {
    const risks = Object.fromEntries(
      BROWSER_INTENTS.map((spec) => [spec.capability, spec.riskLevel]),
    );

    expect(risks).toEqual({
      "browser.navigate": "LOW",
      "browser.interact": "MEDIUM",
      "browser.login": "HIGH",
      "browser.purchase": "CRITICAL",
    });
  });

  it("exposes no code execution or disk access capabilities", () => {
    const { registry } = rig();

    for (const name of registry.names) {
      expect(name).toMatch(/^browser\.(navigate|interact|login|purchase)$/);
    }
    expect(registry.names).not.toContain("browser.evaluate");
    expect(registry.names).not.toContain("terminal.execute");
    expect(registry.names).not.toContain("filesystem.read");
  });

  it("respects allowlist from configuration", () => {
    const { registry } = rig({ declaredCapabilities: ["browser.navigate"] });

    expect(registry.declare().map((entry) => entry.name)).toEqual(["browser.navigate"]);
    expect(() => registry.require("browser.purchase")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Argument validation
// ─────────────────────────────────────────────────────────────────────────────

describe("argument validation", () => {
  it("rejects empty or excessively large instructions", () => {
    expect(browseInputSchema.safeParse({ instructions: "" }).success).toBe(false);
    expect(browseInputSchema.safeParse({ instructions: "x".repeat(4_001) }).success).toBe(false);
    expect(browseInputSchema.safeParse({ instructions: "check the price" }).success).toBe(true);
  });

  it("rejects an invalid URL", () => {
    const parsed = browseInputSchema.safeParse({
      instructions: "read the page",
      url: "javascript:alert(1)",
    });
    expect(parsed.success).toBe(false);
  });

  it("caps maximum steps", () => {
    expect(browseInputSchema.safeParse({ instructions: "go", maxSteps: 51 }).success).toBe(false);
    expect(browseInputSchema.safeParse({ instructions: "go", maxSteps: 0 }).success).toBe(false);
  });

  it("rejects invalid arguments prior to network calls", async () => {
    const { registry, python } = rig();

    expect(() => registry.validateInput("browser.navigate", { instructions: "" })).toThrow();
    await Promise.resolve();
    expect(python.launched).toEqual([]);
    expect(python.sessions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

describe("execution", () => {
  it("transmits intent corresponding to capability", async () => {
    const { registry, python } = rig();

    for (const spec of BROWSER_INTENTS) {
      const capability = registry.require(spec.capability);
      await capability.execute({ instructions: "do something" } as never, context());
    }

    expect(python.launched.map((entry) => entry.intent)).toEqual([
      "read",
      "interact",
      "login",
      "purchase",
    ]);
  });

  it("prefixes instructions with starting URL", async () => {
    const { registry, python } = rig();
    const capability = registry.require("browser.navigate");

    await capability.execute(
      { instructions: "check the ticket price", url: "https://example.com/flights" } as never,
      context(),
    );

    expect(python.launched[0]?.instructions).toBe(
      "Go to https://example.com/flights, then: check the ticket price",
    );
  });

  it("caps steps to configuration even if caller requests more", async () => {
    const { registry, python } = rig({ maxSteps: 5 });
    const capability = registry.require("browser.navigate");

    await capability.execute({ instructions: "search", maxSteps: 50 } as never, context());

    expect(python.launched).toHaveLength(1);
  });

  it("returns result, steps, and visited URL", async () => {
    const { registry, python } = rig();
    python.outcome = {
      status: "succeeded",
      output: "The ticket costs $129",
      steps: 4,
      events: [
        {
          type: "navigation",
          taskId: "task-1-step-1",
          sessionId: "sess-1",
          seq: 1,
          ts: new Date().toISOString(),
          url: "https://example.com/flights",
          title: null,
        },
      ],
    };

    const capability = registry.require("browser.navigate");
    const result = (await capability.execute(
      { instructions: "ticket price" } as never,
      context(),
    )) as { output: string; steps: number; visitedUrl: string | null; sessionId: string };

    expect(result.output).toBe("The ticket costs $129");
    expect(result.steps).toBe(4);
    expect(result.visitedUrl).toBe("https://example.com/flights");
    expect(result.sessionId).toBe("sess-1");
  });

  it("reports progress without exposing full reasoning chain", async () => {
    const { registry, python } = rig();
    const long = "I am thinking carefully about what step to take next ".repeat(10);
    python.outcome = {
      status: "succeeded",
      output: "done",
      events: [
        {
          type: "thinking",
          taskId: "task-1-step-1",
          sessionId: "sess-1",
          seq: 1,
          ts: new Date().toISOString(),
          text: long,
        },
        {
          type: "progress",
          taskId: "task-1-step-1",
          sessionId: "sess-1",
          seq: 2,
          ts: new Date().toISOString(),
          step: 2,
          maxSteps: 10,
          note: null,
        },
      ],
    };

    const progress: { percent?: number; label?: string }[] = [];
    const capability = registry.require("browser.navigate");
    await capability.execute(
      { instructions: "go" } as never,
      context({
        onProgress: (entry: { percent?: number; label?: string }) => progress.push(entry),
      }),
    );

    const thinking = progress.find((entry) => entry.label?.startsWith("I am thinking") === true);
    expect(thinking?.label?.length).toBeLessThanOrEqual(120);
    expect(progress).toContainEqual({ label: "Step 2/10", percent: 20 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

describe("errors", () => {
  it("does not bypass human verification", async () => {
    const { registry, python } = rig();
    python.outcome = {
      status: "needs_human",
      error: { code: "BROWSER_NEEDS_HUMAN", message: "The site requires a code", retryable: false },
    };

    const capability = registry.require("browser.login");
    await expect(
      capability.execute({ instructions: "log in" } as never, context()),
    ).rejects.toMatchObject({ code: "BROWSER_NEEDS_HUMAN", retryable: false });
  });

  it("propagates navigation failure with worker error code", async () => {
    const { registry, python } = rig();
    python.outcome = {
      status: "failed",
      error: { code: "BROWSER_DOMAIN_BLOCKED", message: "domain blocked", retryable: false },
    };

    const capability = registry.require("browser.navigate");
    await expect(
      capability.execute({ instructions: "go" } as never, context()),
    ).rejects.toMatchObject({ code: "BROWSER_TASK_FAILED", retryable: false });
  });

  it("distinguishes unreachable worker from failed task", async () => {
    const { registry, python } = rig();
    python.unreachable = true;

    const capability = registry.require("browser.navigate");
    await expect(
      capability.execute({ instructions: "go" } as never, context()),
    ).rejects.toMatchObject({ code: "BROWSER_WORKER_UNREACHABLE", retryable: true });
  });

  it("does not announce capabilities when Python worker does not respond", async () => {
    const { registry, python } = rig();
    python.unreachable = true;
    await registry.probeAll();

    expect(registry.declare()).toEqual([]);
  });

  it("announces capabilities again when Python worker recovers", async () => {
    const { registry, python } = rig();
    python.unreachable = true;
    await registry.probeAll();

    python.unreachable = false;
    await registry.probeAll();

    expect(registry.declare()).toHaveLength(4);
  });
});
