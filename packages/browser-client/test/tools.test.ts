import { describe, expect, it, vi } from "vitest";
import { ToolExecutor, type ToolContext, type ToolDefinition } from "@nexus/tools";
import { BrowserWorkerClient, createBrowserTools, INTENT_PERMISSIONS } from "../src/index.js";
import type { BrowserEvent, BrowserTask } from "../src/protocol.js";

/**
 * Worker is stubbed with a scripted `fetch`: this is the real external
 * boundary. Client, tools, executor, and validation run for real,
 * and the HTTP contract is verified exactly as emitted onto the wire.
 */

interface Route {
  method: string;
  path: RegExp;
  respond: (body: unknown) => { status?: number; json: unknown };
}

function makeFetch(routes: Route[]) {
  const calls: { method: string; url: string; body: unknown; headers: Headers }[] = [];

  const impl: typeof fetch = (input, init) => {
    // `fetch` accepts three input forms; client emits only one.
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined;
    calls.push({ method, url, body, headers: new Headers(init?.headers) });

    const route = routes.find((r) => r.method === method && r.path.test(url));
    if (route === undefined) {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    const { status = 200, json } = route.respond(body);
    return Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return { impl, calls };
}

function task(overrides: Partial<BrowserTask> = {}): BrowserTask {
  return {
    taskId: "t1",
    sessionId: "bs_1",
    status: "succeeded",
    intent: "read",
    steps: 2,
    startedAt: "2026-09-01T10:00:00Z",
    finishedAt: "2026-09-01T10:00:04Z",
    durationMs: 4000,
    output: "42 euros",
    error: null,
    events: [],
    ...overrides,
  };
}

const session = {
  sessionId: "bs_1",
  ownerId: "user-1",
  status: "open" as const,
  createdAt: "2026-09-01T10:00:00Z",
  expiresAt: "2026-09-01T10:10:00Z",
  currentUrl: null,
  activeTaskId: null,
};

function standardRoutes(finalTask: BrowserTask = task()): Route[] {
  return [
    { method: "POST", path: /\/v1\/sessions$/, respond: () => ({ json: session }) },
    {
      method: "POST",
      path: /\/v1\/sessions\/[^/]+\/tasks$/,
      respond: (body) => ({
        json: task({ ...(body as { taskId: string }), status: "running", output: null }),
      }),
    },
    { method: "GET", path: /\/v1\/tasks\//, respond: () => ({ json: finalTask }) },
    { method: "DELETE", path: /\/v1\/sessions\//, respond: () => ({ status: 204, json: null }) },
    { method: "POST", path: /\/cancel$/, respond: () => ({ json: task({ status: "cancelled" }) }) },
  ];
}

function makeTools(finalTask?: BrowserTask) {
  const { impl, calls } = makeFetch(standardRoutes(finalTask));
  const client = new BrowserWorkerClient({
    baseUrl: "http://browser-worker:8100",
    token: "internal-token",
    fetchImpl: impl,
  });
  const tools = createBrowserTools({ client, allowedDomains: ["flights.test"] });
  return { tools, calls, client };
}

function byName(tools: ToolDefinition<never, unknown>[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  return tool;
}

const context: Omit<ToolContext, "attempt"> = {
  runId: "run-1",
  userId: "user-1",
  conversationId: "conv-1",
  correlationId: "corr-1",
  signal: new AbortController().signal,
  idempotencyKey: "run-1:0:browser.read:abc",
  onProgress: vi.fn(),
};

const executor = new ToolExecutor({ defaultTimeoutMs: 5_000, sleep: () => Promise.resolve() });

describe("tool catalog", () => {
  it("exposes one intent per tool rather than a generic tool", () => {
    const { tools } = makeTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "browser.close_session",
      "browser.interact",
      "browser.login",
      "browser.purchase",
      "browser.read",
    ]);
  });

  it("scales risk level by intent", () => {
    const { tools } = makeTools();
    expect(byName(tools, "browser.read").riskLevel).toBe("SAFE");
    expect(byName(tools, "browser.interact").riskLevel).toBe("MEDIUM");
    expect(byName(tools, "browser.login").riskLevel).toBe("HIGH");
    expect(byName(tools, "browser.purchase").riskLevel).toBe("CRITICAL");
  });

  it("only requests confirmation for mutating or sensitive actions", () => {
    const { tools } = makeTools();
    expect(byName(tools, "browser.read").requiresConfirmation).toBe(false);
    expect(byName(tools, "browser.purchase").requiresConfirmation).toBe(true);
    expect(byName(tools, "browser.login").requiresConfirmation).toBe(true);
    expect(byName(tools, "browser.interact").requiresConfirmation).toBe(true);
  });

  it("requires cumulative permissions", () => {
    const { tools } = makeTools();
    expect(byName(tools, "browser.read").requiredPermissions).toEqual(INTENT_PERMISSIONS.read);
    expect(byName(tools, "browser.purchase").requiredPermissions).toEqual(
      INTENT_PERMISSIONS.purchase,
    );
    // Purchasing entails navigating, reading, interacting, and logging in.
    expect(byName(tools, "browser.purchase").requiredPermissions).toContain("browser.navigate");
  });

  it("only automatically retries read actions", () => {
    const { tools } = makeTools();
    expect(byName(tools, "browser.read").idempotent).toBe(true);
    expect(byName(tools, "browser.purchase").idempotent).toBe(false);
  });
});

describe("execution", () => {
  it("opens a session, runs task, and returns result", async () => {
    const { tools, calls } = makeTools();

    const result = await executor.execute(
      byName(tools, "browser.read"),
      { url: "https://flights.test", instructions: "Find the price" },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as { output: string; sessionId: string; needsHuman: boolean };
      expect(output.output).toBe("42 euros");
      expect(output.sessionId).toBe("bs_1");
      expect(output.needsHuman).toBe(false);
    }

    const create = calls.find((c) => c.url.endsWith("/v1/sessions"));
    expect(create?.body).toMatchObject({ ownerId: "user-1", allowedDomains: ["flights.test"] });

    const run = calls.find((c) => c.url.includes("/tasks"));
    expect(run?.body).toMatchObject({ intent: "read" });
    // URL is merged into instructions
    expect(String((run?.body as { instructions: string }).instructions)).toContain(
      "https://flights.test",
    );
  });

  it("authenticates each call", async () => {
    const { tools, calls } = makeTools();
    await executor.execute(byName(tools, "browser.read"), { instructions: "Read the page" }, context);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer internal-token");
      expect(call.headers.get("x-browser-protocol-version")).toBe("1");
    }
  });

  it("reuses provided session instead of opening a new one", async () => {
    const { tools, calls } = makeTools();

    await executor.execute(
      byName(tools, "browser.read"),
      { instructions: "next", sessionId: "bs_existing" },
      context,
    );

    expect(calls.some((c) => c.url.endsWith("/v1/sessions") && c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.url.includes("bs_existing/tasks"))).toBe(true);
  });

  it("streams progress during browsing", async () => {
    const events: BrowserEvent[] = [
      {
        type: "navigation",
        taskId: "t1",
        sessionId: "bs_1",
        seq: 1,
        ts: "2026-09-01T10:00:01Z",
        url: "https://flights.test/search",
        title: null,
      },
      {
        type: "progress",
        taskId: "t1",
        sessionId: "bs_1",
        seq: 2,
        ts: "2026-09-01T10:00:02Z",
        step: 3,
        maxSteps: 15,
        note: null,
      },
    ];
    const { tools } = makeTools(task({ events }));
    const onProgress = vi.fn();

    await executor.execute(
      byName(tools, "browser.read"),
      { instructions: "Read the page" },
      {
        ...context,
        onProgress,
      },
    );

    const labels = onProgress.mock.calls.map(([p]) => (p as { label?: string }).label);
    expect(labels).toContain("Opening flights.test");
    expect(labels).toContain("Step 3/15");
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ pct: 20 });
  });
});

describe("human guardrails", () => {
  it("yields control instead of bypassing CAPTCHA", async () => {
    const { tools } = makeTools(
      task({
        status: "needs_human",
        output: null,
        error: {
          code: "BROWSER_HUMAN_INTERVENTION_REQUIRED",
          message: "The site requires human verification.",
          retryable: false,
        },
      }),
    );

    const result = await executor.execute(
      byName(tools, "browser.login"),
      { instructions: "log in" },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as { needsHuman: boolean; output: string };
      expect(output.needsHuman).toBe(true);
      expect(output.output).toContain("human verification");
    }
  });
});

describe("failures", () => {
  it("reports an actionable error when task fails", async () => {
    const { tools } = makeTools(
      task({
        status: "failed",
        output: null,
        error: { code: "BROWSER_TASK_FAILED", message: "page not found", retryable: true },
      }),
    );

    const result = await executor.execute(
      byName(tools, "browser.read"),
      { instructions: "Read the page" },
      context,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BROWSER_TASK_FAILED");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("handles unreachable worker as a retryable failure", async () => {
    const client = new BrowserWorkerClient({
      baseUrl: "http://browser-worker:8100",
      token: "x",
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const tools = createBrowserTools({ client });

    const result = await executor.execute(
      byName(tools, "browser.read"),
      { instructions: "Read the page" },
      context,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BROWSER_WORKER_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("validates arguments before calling the worker", async () => {
    const { tools, calls } = makeTools();

    const result = await executor.execute(
      byName(tools, "browser.read"),
      { url: 42, instructions: "Read the page" },
      context,
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
