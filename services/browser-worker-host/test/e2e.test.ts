import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DeviceRegistry,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  WorkerGateway,
  type WorkerConnection,
} from "@nexus/devices";
import { LoopbackLink, MemoryWorkerLogger } from "@nexus/worker-core";
import { BrowserWorkerClient } from "@nexus/browser-client";
import { WORKER_MESSAGE, workerEnvelope, type Envelope } from "@nexus/protocol";
import { assembleBrowserHost } from "../src/assemble.js";
import { BrowserWorkerHost } from "../src/worker.js";
import { TestSigner, generateDeviceKeys, testConfig, waitFor } from "./fixtures.js";

/**
 * End-to-end with the **real Python worker**.
 *
 * Launches `uvicorn` in a separate process and drives it from a real `WorkerGateway`
 * through the host. Runs real HTTP, serialization, service token, sessions,
 * intent policies, and the complete NEXUS chain.
 */

const PYTHON = process.env.NEXUS_WORKER_PYTHON;
const TOKEN = "e2e-token-sufficiently-long-for-worker";
const PORT = 8142;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

const workerDir = fileURLToPath(new URL("../../browser-worker", import.meta.url));

const suite = PYTHON === undefined ? describe.skip : describe;

let python: ChildProcess | undefined;

/** Minimal session request as expected by Python worker. */
function createSessionRequest() {
  return {
    ownerId: "user-example",
    allowedDomains: [],
    prohibitedDomains: [],
    headless: true,
    ttlSeconds: 60,
    metadata: {},
  };
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/v1/health`);
      if (response.ok) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Python worker did not start: ${String(last)}`);
}

suite("end-to-end with real Python worker", () => {
  beforeAll(async () => {
    python = spawn(
      PYTHON!,
      ["-m", "uvicorn", "app.main:build", "--factory", "--port", String(PORT)],
      {
        cwd: workerDir,
        env: {
          ...process.env,
          BROWSER_WORKER_AUTH_TOKEN: TOKEN,
          BROWSER_WORKER_LOG_LEVEL: "WARNING",
          BROWSER_WORKER_ALLOW_PRIVATE_HOSTS: "true",
        },
        stdio: "ignore",
      },
    );
    await waitForHealth();
  }, 90_000);

  afterAll(() => {
    python?.kill();
  });

  it("Python worker responds and host sees it as healthy", async () => {
    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
    const health = await client.health();

    expect(health.status).toBe("ok");
    expect(health.protocolVersion).toBeGreaterThan(0);
  });

  it("rejects an invalid service token", async () => {
    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: "bad-token-but-long-enough" });
    await expect(client.createSession(createSessionRequest())).rejects.toThrow();
  });

  it("traverses the core -> gateway -> host -> Python worker chain", async () => {
    const registry = new DeviceRegistry();
    const credentials = new InMemoryCredentialProvider();
    const sessions = new DeviceSessionService({ registry });
    const router = new EventRouter({ registry });
    const gateway = new WorkerGateway({ registry, sessions, credentials, router });

    const keys = generateDeviceKeys();
    const config = testConfig({
      browserWorkerUrl: BASE_URL,
      browserWorkerToken: TOKEN,
      deviceId: "device-browser-e2e",
    });

    const device = await registry.registerDevice({
      id: config.deviceId,
      userId: "user-example",
      name: "Browser worker",
      type: "BROWSER_WORKER",
      platform: "WEB",
      role: "WORKER",
      grantedPermissions: ["browser.navigate"],
    });
    credentials.set(device.id, keys.publicKeyPem);
    await registry.trustDevice(device.id);

    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
    const assembled = assembleBrowserHost({ config, client });
    const link = new LoopbackLink();

    const connection: WorkerConnection = {
      connectionId: "conn-e2e",
      deviceId: device.id,
      send: (envelope: Envelope) => {
        link.deliver(envelope);
      },
      close: () => {
        link.drop("closed");
      },
    };
    link.outbound = (envelope) => gateway.handleMessage(connection, envelope);

    const host = new BrowserWorkerHost({
      config,
      capabilities: assembled.capabilities,
      client,
      sessions: assembled.sessions,
      link,
      signer: new TestSigner(keys.privateKeyPem),
      logger: new MemoryWorkerLogger(),
    });

    await host.start();
    await waitFor(() => host.isAuthenticated);

    await waitFor(async () => {
      const current = await registry.requireDevice(device.id);
      return current.capabilities.length > 0;
    });
    const current = await registry.requireDevice(device.id);
    expect(current.capabilities.map((entry) => entry.name)).toContain("browser.navigate");

    const opened = await client.createSession({
      ownerId: device.id,
      allowedDomains: [],
      prohibitedDomains: [],
      headless: true,
      ttlSeconds: 60,
      metadata: {},
    });
    expect(opened.sessionId).toBeTruthy();
    await client.closeSession(opened.sessionId);

    await host.stop("test teardown");
  }, 60_000);

  it("leads a task to a terminal state without hanging", async () => {
    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
    const session = await client.createSession({
      ownerId: "user-example",
      allowedDomains: [],
      prohibitedDomains: [],
      headless: true,
      ttlSeconds: 60,
      metadata: {},
    });

    const started = await client.runTask({
      taskId: "t-terminal",
      sessionId: session.sessionId,
      instructions: "Go to http://169.254.169.254/latest/meta-data/",
      intent: "read",
      maxSteps: 1,
    });

    const finished = await client.waitForTask(started.taskId, {
      pollIntervalMs: 200,
      maxWaitMs: 30_000,
    });

    expect(["succeeded", "failed", "cancelled", "timeout", "needs_human"]).toContain(
      finished.status,
    );
    expect(finished.intent).toBe("read");

    await client.closeSession(session.sessionId);
  }, 45_000);
});

export const DISPATCH_REFERENCE = workerEnvelope(
  WORKER_MESSAGE.taskDispatch,
  {
    taskId: "reference",
    stepId: "s1",
    capability: "browser.navigate",
    tool: "device.browser.navigate",
    arguments: { instructions: "reference" },
    timeoutMs: 1_000,
    riskLevel: "LOW",
    requestId: "r1",
  },
  { id: "ref", at: new Date(0) },
);
