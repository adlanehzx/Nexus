import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskPlan } from "@nexus/devices";
import { projectAgentRun, LogBuffer, SecurityLog } from "../src/services/observability.js";
import {
  createAccount,
  makeApi,
  registerDevice,
  type Account,
  type ApiHarness,
} from "./harness.js";

/**
 * Supervision dashboard.
 *
 * Verifies administrative authorization gating and ensures that model reasoning/thinking
 * never leaks into projected representations.
 */

let harness: ApiHarness;
let admin: Account;
let member: Account;

beforeEach(async () => {
  harness = await makeApi();
  admin = await createAccount(harness, "alex@example.test");
  member = await createAccount(harness, "member@example.com");
});

afterEach(async () => {
  await harness.close();
});

const SECTIONS = [
  "/api/v1/dashboard/overview",
  "/api/v1/dashboard/devices",
  "/api/v1/dashboard/workers",
  "/api/v1/dashboard/tasks",
  "/api/v1/dashboard/runs",
  "/api/v1/dashboard/observability",
  "/api/v1/dashboard/tools",
  "/api/v1/dashboard/mcp",
  "/api/v1/dashboard/browser",
  "/api/v1/dashboard/mission-control",
  "/api/v1/dashboard/memory",
  "/api/v1/dashboard/notifications",
  "/api/v1/dashboard/security",
  "/api/v1/dashboard/logs",
] as const;

function get(url: string, account?: Account) {
  return harness.app.inject({
    method: "GET",
    url,
    ...(account === undefined ? {} : { headers: account.authorization }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication and authorization
// ─────────────────────────────────────────────────────────────────────────────

describe("administrative guard", () => {
  it("rejects all sections without token", async () => {
    for (const url of SECTIONS) {
      expect((await get(url)).statusCode, url).toBe(401);
    }
  });

  it("rejects all sections for ordinary account", async () => {
    for (const url of SECTIONS) {
      expect((await get(url, member)).statusCode, url).toBe(403);
    }
  });

  it("rejection does not reveal existence of administrative surface", async () => {
    const response = await get("/api/v1/dashboard/overview", member);

    const body = response.json<{ error: { message: string } }>();
    expect(body.error.message).not.toMatch(/administrat/i);
    expect(body.error.message).toBe("The requested resource does not exist.");
  });

  it("opens all sections to administrator", async () => {
    for (const url of SECTIONS) {
      expect((await get(url, admin)).statusCode, url).toBe(200);
    }
  });

  it("first created account is administrator, subsequent accounts are not", async () => {
    const first = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: admin.authorization,
    });
    const second = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: member.authorization,
    });

    expect(first.json<{ data: { role: string } }>().data.role).toBe("ADMIN");
    expect(second.json<{ data: { role: string } }>().data.role).toBe("USER");
  });

  it("privilege revocation takes effect immediately", async () => {
    expect((await get("/api/v1/dashboard/overview", admin)).statusCode).toBe(200);

    await harness.services.users.setRole(admin.userId, "USER");

    expect((await get("/api/v1/dashboard/overview", admin)).statusCode).toBe(403);
  });

  it("no section allows writing", async () => {
    for (const method of ["POST", "DELETE", "PATCH"] as const) {
      const response = await harness.app.inject({
        method,
        url: "/api/v1/dashboard/devices",
        headers: admin.authorization,
        payload: {},
      });
      expect(response.statusCode, method).toBe(404);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning does not leak across boundaries
// ─────────────────────────────────────────────────────────────────────────────

function runWithSecrets(userId: string) {
  return {
    record: {
      runId: "run-1",
      userId,
      conversationId: "conv-1",
      correlationId: "corr-1",
      startTime: "2026-09-03T10:00:00.000Z",
      endTime: "2026-09-03T10:00:12.000Z",
      status: "completed",
      stopReason: "final_answer",
      iterations: 3,
      model: "claude-opus-5",
      response: "I launched the tests, everything passed.",
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 90 },
      toolsUsed: [
        {
          toolCallId: "call-1",
          name: "device.terminal.execute",
          riskLevel: "MEDIUM",
          status: "success",
          durationMs: 4200,
          attempts: 1,
          input: { command: "pnpm", args: ["test"] } as Record<string, unknown>,
        },
      ],
      errors: [],
    },
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "INTERNAL_REASONING_NOT_TO_BE_DISCLOSED" }],
        providerBlocks: { thinking: "PROVIDER_OPAQUE_BLOCK", signature: "sig-xyz" },
      },
      {
        role: "user",
        content: [{ type: "text", text: "RAW_USER_MESSAGE" }],
      },
    ],
    pendingConfirmation: null,
    consecutiveToolFailures: 0,
    toolCallCount: 1,
    callSignatures: ["device.terminal.execute:INTERNAL_SIGNATURE"],
    deadlineAt: 0,
    suspendedAt: null,
  };
}

const FORBIDDEN = [
  "INTERNAL_REASONING_NOT_TO_BE_DISCLOSED",
  "PROVIDER_OPAQUE_BLOCK",
  "RAW_USER_MESSAGE",
  "INTERNAL_SIGNATURE",
  "providerBlocks",
  "callSignatures",
];

describe("model reasoning does not cross boundaries", () => {
  it("projection exposes only what was authorized", () => {
    const view = projectAgentRun(runWithSecrets("u1"));

    expect(Object.keys(view).sort()).toEqual(
      [
        "conversationId",
        "correlationId",
        "durationMs",
        "endedAt",
        "errors",
        "iterations",
        "metrics",
        "missionExternalKey",
        "replayOfRunId",
        "response",
        "runId",
        "startedAt",
        "status",
        "stopReason",
        "tools",
        "userId",
      ].sort(),
    );
  });

  it("no forbidden field survives projection", () => {
    const serialized = JSON.stringify(projectAgentRun(runWithSecrets("u1")));

    for (const item of FORBIDDEN) {
      expect(serialized).not.toContain(item);
    }
  });

  it("route returns the same and nothing more", async () => {
    await harness.services.runStore.save(runWithSecrets(admin.userId) as never);

    const response = await get("/api/v1/dashboard/runs", admin);

    expect(response.statusCode).toBe(200);
    for (const item of FORBIDDEN) {
      expect(response.body, item).not.toContain(item);
    }
  });

  it("what is authorized is indeed present", async () => {
    await harness.services.runStore.save(runWithSecrets(admin.userId) as never);

    const response = await get("/api/v1/dashboard/runs/run-1", admin);
    const run = response.json<{
      data: {
        status: string;
        response: string | null;
        tools: { tool: string; action: string; status: string }[];
        metrics: { model: string; inputTokens: number; toolCalls: number };
      };
    }>().data;

    expect(run.status).toBe("completed");
    expect(run.response).toContain("tests");
    expect(run.tools[0]?.tool).toBe("device.terminal.execute");
    expect(run.tools[0]?.action).toContain("pnpm");
    expect(run.metrics.model).toBe("claude-opus-5");
    expect(run.metrics.toolCalls).toBe(1);
  });

  it("action summary is redacted", async () => {
    const run = runWithSecrets(admin.userId);
    run.record.toolsUsed[0]!.input = { command: "curl", token: "sk-abcdefghijklmnopqrstuv" };
    await harness.services.runStore.save(run as never);

    const response = await get("/api/v1/dashboard/runs", admin);

    expect(response.body).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("a run from another account remains invisible", async () => {
    await harness.services.runStore.save(runWithSecrets(member.userId) as never);

    const list = await get("/api/v1/dashboard/runs", admin);
    expect(list.json<{ data: { runs: unknown[] } }>().data.runs).toEqual([]);

    expect((await get("/api/v1/dashboard/runs/run-1", admin)).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

describe("overview", () => {
  it("counts devices, workers, tasks, and runs", async () => {
    await registerDevice(harness, admin, { name: "Laptop", role: "BOTH" });
    await registerDevice(harness, admin, { name: "iPhone", role: "CLIENT", type: "IPHONE" });

    const response = await get("/api/v1/dashboard/overview", admin);
    const data = response.json<{
      data: {
        devices: { total: number; online: number };
        workers: { total: number; connected: number };
        health: { name: string; level: string }[];
      };
    }>().data;

    expect(data.devices.total).toBe(2);
    expect(data.workers.total).toBe(1);
    expect(data.workers.connected).toBe(0);
  });

  it("distinguishes unconfigured from broken", async () => {
    const response = await get("/api/v1/dashboard/overview", admin);
    const health = response.json<{ data: { health: { name: string; level: string }[] } }>().data
      .health;

    expect(health.find((entry) => entry.name === "MCP")?.level).toBe("unconfigured");
    expect(health.find((entry) => entry.name === "Browser Use")?.level).toBe("unconfigured");
    expect(health.find((entry) => entry.name === "API")?.level).toBe("ok");
  });

  it("blends recent activities from all sources", async () => {
    harness.services.securityLog.record({
      kind: "device.trusted",
      userId: admin.userId,
      summary: 'Device "Laptop" approved',
    });

    const response = await get("/api/v1/dashboard/overview", admin);
    const activity = response.json<{ data: { recentActivity: { kind: string }[] } }>().data
      .recentActivity;

    expect(activity.some((entry) => entry.kind === "security")).toBe(true);
  });
});

describe("devices", () => {
  it("returns everything the page requests", async () => {
    const registered = await registerDevice(harness, admin, {
      name: "Windows Laptop",
      role: "BOTH",
      permissions: ["terminal.execute"],
    });
    await harness.services.deviceRegistry.updateCapabilities(registered.device.id, [
      {
        name: "terminal.execute",
        version: "1",
        description: "Executes a command",
        enabled: true,
        metadata: {},
      },
    ]);
    await harness.services.deviceRegistry.updateHeartbeat(registered.device.id, {
      cpuLoad: 0.4,
      activeTasks: 1,
      maxConcurrentTasks: 2,
    });

    const response = await get(`/api/v1/dashboard/devices/${registered.device.id}`, admin);
    const device = response.json<{
      data: {
        role: string;
        platform: string;
        status: string;
        trust: string;
        capabilities: { name: string }[];
        lastHeartbeatAt: string | null;
        health: { cpuLoad: number | null; activeTasks: number };
        grantedPermissions: string[];
      };
    }>().data;

    expect(device.role).toBe("BOTH");
    expect(device.platform).toBe("WINDOWS");
    expect(device.status).toBe("ONLINE");
    expect(device.trust).toBe("TRUSTED");
    expect(device.capabilities.map((c) => c.name)).toEqual(["terminal.execute"]);
    expect(device.lastHeartbeatAt).not.toBeNull();
    expect(device.health.cpuLoad).toBe(0.4);
    expect(device.health.activeTasks).toBe(1);
    expect(device.grantedPermissions).toEqual(["terminal.execute"]);
  });

  it("does not return another account's device", async () => {
    const other = await registerDevice(harness, member, {
      name: "Member Workstation",
      role: "BOTH",
    });

    expect((await get(`/api/v1/dashboard/devices/${other.device.id}`, admin)).statusCode).toBe(404);
  });
});

describe("workers", () => {
  it("distinguishes declared role from actually open channel", async () => {
    await registerDevice(harness, admin, { name: "Desktop Workstation", role: "WORKER" });

    const response = await get("/api/v1/dashboard/workers", admin);
    const workers = response.json<{
      data: { workers: { name: string; connected: boolean; acceptingTasks: boolean }[] };
    }>().data.workers;

    expect(workers).toHaveLength(1);
    expect(workers[0]?.connected).toBe(false);
    expect(workers[0]?.acceptingTasks).toBe(false);
  });

  it("excludes pure clients", async () => {
    await registerDevice(harness, admin, { name: "iPhone", role: "CLIENT", type: "IPHONE" });

    const response = await get("/api/v1/dashboard/workers", admin);
    expect(response.json<{ data: { workers: unknown[] } }>().data.workers).toEqual([]);
  });
});

describe("tasks", () => {
  async function seedPlan() {
    const device = await registerDevice(harness, admin, { name: "Laptop", role: "BOTH" });
    const plan = createTaskPlan({
      userId: admin.userId,
      title: "Run tests",
      originClientDeviceId: device.device.id,
      correlationId: "corr-1",
      steps: [
        {
          id: "s1",
          description: "Execute pnpm test",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          riskLevel: "SAFE",
        },
      ],
    });
    await harness.services.taskStore.save(plan);
    return { plan, device };
  }

  it("returns plan, its steps, and its progress", async () => {
    const { plan } = await seedPlan();

    const response = await get(`/api/v1/dashboard/tasks/${plan.id}`, admin);
    const task = response.json<{
      data: {
        title: string;
        progressPercent: number;
        steps: { description: string; tool: string; requiredCapabilities: string[] }[];
        executions: unknown[];
      };
    }>().data;

    expect(task.title).toBe("Run tests");
    expect(task.progressPercent).toBe(0);
    expect(task.steps[0]?.tool).toBe("device.terminal.execute");
    expect(task.steps[0]?.requiredCapabilities).toEqual(["terminal.execute"]);
    expect(task.executions).toEqual([]);
  });

  it("names the selected worker rather than returning an id", async () => {
    const { plan, device } = await seedPlan();

    await harness.services.taskStore.saveExecution({
      id: "exec-1",
      taskId: plan.id,
      stepId: "s1",
      deviceId: device.device.id,
      attempt: 1,
      status: "succeeded",
      startedAt: "2026-09-03T10:00:00.000Z",
      completedAt: "2026-09-03T10:00:05.000Z",
      durationMs: 5000,
      input: null,
      result: { ok: true },
      error: null,
    });

    const response = await get(`/api/v1/dashboard/tasks/${plan.id}`, admin);
    const executions = response.json<{
      data: { executions: { deviceName: string | null; durationMs: number | null }[] };
    }>().data.executions;

    expect(executions[0]?.deviceName).toBe("Laptop");
    expect(executions[0]?.durationMs).toBe(5000);
  });

  it("does not return another account's task", async () => {
    const device = await registerDevice(harness, member, { name: "Workstation", role: "BOTH" });
    const plan = createTaskPlan({
      userId: member.userId,
      title: "Private",
      originClientDeviceId: device.device.id,
      correlationId: "corr-2",
      steps: [
        {
          id: "s1",
          description: "x",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
        },
      ],
    });
    await harness.services.taskStore.save(plan);

    expect((await get(`/api/v1/dashboard/tasks/${plan.id}`, admin)).statusCode).toBe(404);
  });
});

describe("infrastructure sections", () => {
  it("honestly reports unconfigured MCP", async () => {
    const response = await get("/api/v1/dashboard/mcp", admin);
    const data = response.json<{ data: { configured: boolean; servers: unknown[] } }>().data;

    expect(data.configured).toBe(false);
    expect(data.servers).toEqual([]);
  });

  it("honestly reports unconfigured browser worker", async () => {
    const response = await get("/api/v1/dashboard/browser", admin);
    const data = response.json<{ data: { configured: boolean; reachable: boolean } }>().data;

    expect(data.configured).toBe(false);
    expect(data.reachable).toBe(false);
  });

  it("lists tool catalog with what is authorized", async () => {
    const response = await get("/api/v1/dashboard/tools", admin);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { tools: unknown[] } }>().data.tools).toEqual([]);
  });
});

describe("memory", () => {
  it("counts by layer, origin, and sensitivity", async () => {
    await harness.services.memoryService.remember({
      userId: admin.userId,
      content: "Always reply in concise English",
      layer: "PREFERENCE",
    });
    await harness.services.memoryService.remember({
      userId: admin.userId,
      content: "Lives in London",
      origin: "AGENT",
    });

    const response = await get("/api/v1/dashboard/memory", admin);
    const data = response.json<{
      data: {
        total: number;
        byLayer: Record<string, number>;
        byOrigin: Record<string, number>;
      };
    }>().data;

    expect(data.total).toBe(2);
    expect(data.byLayer.PREFERENCE).toBe(1);
    expect(data.byOrigin.AGENT).toBe(1);
  });
});

describe("security", () => {
  it("lists events produced by the rest of the API", async () => {
    const device = await registerDevice(harness, admin, { name: "Laptop", role: "BOTH" });

    const response = await get("/api/v1/dashboard/security", admin);
    const data = response.json<{
      data: {
        events: { kind: string; summary: string }[];
        byKind: Record<string, number>;
        trust: { trusted: number };
      };
    }>().data;

    expect(data.byKind["device.registered"]).toBe(1);
    expect(data.byKind["device.trusted"]).toBe(1);
    expect(data.trust.trusted).toBe(1);
    expect(data.events.some((event) => event.summary.includes(device.device.name))).toBe(true);
  });

  it("logs login failure without the attempted address", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "unknown@example.com", password: "wrong password" },
    });

    const response = await get("/api/v1/dashboard/security", admin);
    expect(response.body).not.toContain("unknown@example.com");
    expect(response.body).not.toContain("wrong password");
    expect(
      response.json<{ data: { byKind: Record<string, number> } }>().data.byKind[
        "auth.login_failed"
      ],
    ).toBe(1);
  });

  it("reports memory refusal without the refused content", async () => {
    await harness.app
      .inject({
        method: "POST",
        url: "/api/v1/memory",
        headers: admin.authorization,
        payload: { content: "My password is Tr0ub4dor3xy" },
      })
      .catch(() => undefined);

    const response = await get("/api/v1/dashboard/security", admin);

    expect(response.body).not.toContain("Tr0ub4dor3xy");
    expect(
      response.json<{ data: { byKind: Record<string, number> } }>().data.byKind["memory.refused"],
    ).toBe(1);
  });
});

describe("logs", () => {
  it("returns stored lines, newest first", async () => {
    harness.services.logs.write(
      JSON.stringify({ level: "info", time: "2026-09-03T10:00:00.000Z", msg: "first" }),
    );
    harness.services.logs.write(
      JSON.stringify({ level: "error", time: "2026-09-03T10:00:01.000Z", msg: "second" }),
    );

    const response = await get("/api/v1/dashboard/logs", admin);
    const entries = response.json<{ data: { entries: { message: string }[] } }>().data.entries;

    expect(entries.map((entry) => entry.message)).toEqual(["second", "first"]);
  });

  it("filters by level", async () => {
    harness.services.logs.write(JSON.stringify({ level: "debug", msg: "noise" }));
    harness.services.logs.write(JSON.stringify({ level: "error", msg: "incident" }));

    const response = await get("/api/v1/dashboard/logs?level=error", admin);
    const entries = response.json<{ data: { entries: { message: string }[] } }>().data.entries;

    expect(entries.map((entry) => entry.message)).toEqual(["incident"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observability stores
// ─────────────────────────────────────────────────────────────────────────────

describe("log buffer", () => {
  it("understands the actual format of this repository", () => {
    const buffer = new LogBuffer();
    buffer.write(
      JSON.stringify({
        level: "warn",
        time: "2026-09-03T10:00:00.000Z",
        msg: "warning",
        correlationId: "corr-9",
      }),
    );

    const entry = buffer.list()[0];
    expect(entry?.level).toBe("warn");
    expect(entry?.at).toBe("2026-09-03T10:00:00.000Z");
    expect(entry?.correlationId).toBe("corr-9");
  });

  it("also understands default pino format", () => {
    const buffer = new LogBuffer();
    buffer.write(JSON.stringify({ level: 50, time: 1_756_890_000_000, msg: "error" }));

    expect(buffer.list()[0]?.level).toBe("error");
  });

  it("redacts secrets on entry", () => {
    const buffer = new LogBuffer();
    buffer.write(JSON.stringify({ level: "info", msg: "call", token: "sk-abcdefghijklmnopqrst" }));

    expect(JSON.stringify(buffer.list())).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("never throws on unreadable line", () => {
    const buffer = new LogBuffer();

    expect(() => {
      buffer.write("not json");
    }).not.toThrow();
    expect(buffer.size).toBe(0);
  });

  it("remains bounded", () => {
    const buffer = new LogBuffer({ max: 3 });
    for (let index = 0; index < 10; index += 1) {
      buffer.write(JSON.stringify({ level: "info", msg: `line ${String(index)}` }));
    }

    expect(buffer.size).toBe(3);
    expect(buffer.list()[0]?.message).toBe("line 9");
  });
});

describe("security log", () => {
  it("bounds summary and redacts context", () => {
    const log = new SecurityLog();
    log.record({
      kind: "auth.login",
      userId: "u1",
      summary: "x".repeat(400),
      context: { apiKey: "sk-abcdefghijklmnopqrst" },
    });

    const event = log.list()[0];
    expect(event?.summary.length).toBeLessThan(300);
    expect(JSON.stringify(event?.context)).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("remains bounded", () => {
    const log = new SecurityLog({ max: 2 });
    for (let index = 0; index < 5; index += 1) {
      log.record({ kind: "auth.login", summary: `login ${String(index)}` });
    }

    expect(log.size).toBe(2);
  });
});
