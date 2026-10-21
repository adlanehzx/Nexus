import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BrowserWorkerClient, BrowserWorkerError } from "../src/index.js";

/**
 * Real TypeScript <-> Python communication.
 *
 * Spawns the real FastAPI worker in a separate process and controls it with the
 * real client: HTTP, serialization, authentication, error codes.
 * Contract tests compare schemas, while this suite verifies live runtime behavior.
 *
 * Activation:
 *   NEXUS_WORKER_PYTHON=/path/to/python pnpm --filter @nexus/browser-client test
 *
 * Skipped if this environment variable is absent.
 */

const PYTHON = process.env.NEXUS_WORKER_PYTHON;
const TOKEN = "integration-token-sufficiently-long";
const PORT = 8137;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

const workerDir = fileURLToPath(new URL("../../../services/browser-worker", import.meta.url));

let worker: ChildProcess | undefined;
let client: BrowserWorkerClient;

const suite = PYTHON === undefined ? describe.skip : describe;

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/v1/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Worker failed to start: ${String(lastError)}`);
}

suite("TypeScript <-> Python communication", () => {
  beforeAll(async () => {
    worker = spawn(
      PYTHON!,
      [
        "-m",
        "uvicorn",
        "app.main:build",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
      ],
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

    client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
  }, 90_000);

  afterAll(() => {
    worker?.kill();
  });

  it("reads worker health and protocol version", async () => {
    const health = await client.health();

    expect(health.protocolVersion).toBe(1);
    expect(["ok", "degraded"]).toContain(health.status);
    // Zod schema validates Pydantic response shape and types
    expect(typeof health.openSessions).toBe("number");
  });

  it("creates, retrieves, and closes a session", async () => {
    const session = await client.createSession({
      ownerId: "user-integration",
      allowedDomains: ["example.test"],
    });

    expect(session.sessionId).toMatch(/^bs_/);
    expect(session.ownerId).toBe("user-integration");
    expect(session.status).toBe("open");

    const fetched = await client.getSession(session.sessionId);
    expect(fetched.sessionId).toBe(session.sessionId);

    await client.closeSession(session.sessionId);
    await expect(client.getSession(session.sessionId)).rejects.toBeInstanceOf(BrowserWorkerError);
  });

  it("rejects an invalid token", async () => {
    const intruder = new BrowserWorkerClient({ baseUrl: BASE_URL, token: "wrong-token-long" });

    await expect(intruder.createSession({ ownerId: "u" })).rejects.toThrow();
  });

  it("returns error codes recognized by TypeScript", async () => {
    // Error contract crosses boundary to distinguish retryable from fatal
    try {
      await client.getSession("bs_nonexistent");
      expect.unreachable("should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserWorkerError);
      expect((error as BrowserWorkerError).code).toBe("BROWSER_SESSION_NOT_FOUND");
    }
  });

  it("rejects an unknown session when running a task", async () => {
    await expect(
      client.runTask({
        taskId: "t-integration",
        sessionId: "bs_nonexistent",
        instructions: "Read the home page",
        intent: "read",
      }),
    ).rejects.toBeInstanceOf(BrowserWorkerError);
  });

  it("enforces session concurrency limits", async () => {
    const opened: string[] = [];
    try {
      for (let i = 0; i < 5; i += 1) {
        opened.push((await client.createSession({ ownerId: "user-limit" })).sessionId);
      }
      const extra = await client.createSession({ ownerId: "user-limit" });
      opened.push(extra.sessionId);
      expect.unreachable("limit should have been enforced");
    } catch (error) {
      expect((error as BrowserWorkerError).code).toBe("BROWSER_SESSION_BUSY");
    } finally {
      for (const id of opened) await client.closeSession(id).catch(() => undefined);
    }
  });
});
