import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";
import { PauseSwitch } from "../src/services/pause.js";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { makeApi, type ApiHarness } from "./harness.js";

/**
 * Global pause.
 *
 * Verifies that reading continues while acting stops.
 */

const PASSWORD = "VeryStrongPassword!42";

/**
 * A valid plan.
 */
const TASK = {
  title: "Tidy up",
  originClientDeviceId: "origin-device",
  steps: [
    {
      description: "Execute a command",
      requiredCapabilities: ["shell.exec"],
      tool: "shell.exec",
    },
  ],
};

async function register(harness: ApiHarness): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "alex@example.test", displayName: "Alex", password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

describe("global pause", () => {
  let harness: ApiHarness;
  let token: string;

  beforeEach(async () => {
    harness = await makeApi();
    token = await register(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  const pause = (paused: boolean, reason?: string) =>
    harness.app.inject({
      method: "POST",
      url: "/api/v1/pause",
      headers: { authorization: `Bearer ${token}` },
      payload: { paused, ...(reason === undefined ? {} : { reason }) },
    });

  it("starts running and reports its state", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/pause",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { paused: boolean } }>().data.paused).toBe(false);
  });

  it("carries a reason and a timestamp", async () => {
    const response = await pause(true, "meeting");
    const state = response.json<{ data: { paused: boolean; reason: string; since: string } }>()
      .data;
    expect(state.paused).toBe(true);
    expect(state.reason).toBe("meeting");
    expect(new Date(state.since).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("does not shift the timestamp when pausing again", async () => {
    const first = (await pause(true)).json<{ data: { since: string } }>().data.since;
    const second = (await pause(true, "still")).json<{ data: { since: string } }>().data.since;
    expect(second).toBe(first);
  });

  it("allows reading and prevents acting", async () => {
    await pause(true);

    // Acting: rejected
    const acting = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: `Bearer ${token}` },
      payload: TASK,
    });
    expect(acting.statusCode).toBe(409);
    expect(acting.json<{ error: { code: string } }>().error.code).toBe("SYSTEM_PAUSED");

    // Reading: allowed
    const reading = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reading.statusCode).toBe(200);
  });

  it("rejects a mission while pause is active", async () => {
    await pause(true);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "Do something." },
    });
    expect(response.statusCode).toBe(409);
  });

  it("does not prevent its own resumption", async () => {
    await pause(true, "test");
    const resumed = await pause(false);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ data: { paused: boolean; since: null } }>().data).toMatchObject({
      paused: false,
      reason: null,
      since: null,
    });

    const acting = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: `Bearer ${token}` },
      payload: TASK,
    });
    expect(acting.statusCode).not.toBe(409);
  });

  it("cuts agent tools on the next call without rebuilding the service", async () => {
    const tool: ToolDefinition<Record<string, never>, Record<string, never>> = {
      name: "demo.action",
      description: "Any action with LOW risk.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      riskLevel: "LOW",
      requiredPermissions: [],
      requiresConfirmation: false,
      execute: () => Promise.resolve({}),
    };
    const context = {
      runId: "run-1",
      userId: "user-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      signal: new AbortController().signal,
      idempotencyKey: "key-1",
      attempt: 1,
      onProgress: () => undefined,
    };

    const before = await harness.services.permissions.check(tool, {}, context);
    expect(before.effect).toBe("allow");

    await pause(true);

    const after = await harness.services.permissions.check(tool, {}, context);
    expect(after.effect).toBe("deny");
    if (after.effect === "deny") expect(after.reason).toContain("paused");
  });

  it("requires a user", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/pause",
      payload: { paused: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it("logs pausing and resuming", async () => {
    await pause(true, "meeting");
    await pause(false);
    const kinds = harness.services.securityLog.list({ limit: 20 }).map((event) => event.kind);
    expect(kinds).toContain("system.paused");
    expect(kinds).toContain("system.resumed");
  });
});

describe("pause survives a restart", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-pause-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads back from disk", async () => {
    const store = new RuntimeConfigurationStore(directory);
    await new PauseSwitch({ store }).set(true, "maintenance");

    const afterRestart = new PauseSwitch({ store });
    expect(afterRestart.paused).toBe(false);
    const restored = await afterRestart.restore();
    expect(restored.paused).toBe(true);
    expect(restored.reason).toBe("maintenance");
    expect(afterRestart.paused).toBe(true);
  });

  it("a resume is also persisted", async () => {
    const store = new RuntimeConfigurationStore(directory);
    const switch1 = new PauseSwitch({ store });
    await switch1.set(true);
    await switch1.set(false);

    const restored = await new PauseSwitch({ store }).restore();
    expect(restored.paused).toBe(false);
  });

  it("writes a readable file without secrets", async () => {
    const store = new RuntimeConfigurationStore(directory);
    await new PauseSwitch({ store }).set(true, "meeting");
    const written = JSON.parse(await readFile(join(directory, "pause.json"), "utf8")) as {
      paused: boolean;
      reason: string;
    };
    expect(written).toMatchObject({ paused: true, reason: "meeting" });
  });

  it("without persistence pause only lives in memory and reports so", async () => {
    const volatile = new PauseSwitch();
    await volatile.set(true);
    expect(volatile.paused).toBe(true);
    expect((await new PauseSwitch().restore()).paused).toBe(false);
  });
});
