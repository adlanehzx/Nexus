#!/usr/bin/env node
/**
 * End-to-end: delegated task across human confirmation and engine restart.
 *
 *     mission
 *     → Agent Core task
 *     → sensitive tool
 *     → awaiting_confirmation
 *     → engine restart (SIGTERM, then restart)
 *     → approval via user surface
 *     → resumption
 *     → task succeeded
 *     → mission succeeded
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { parseConfig } from "@nexus/config";
import { generateSigningKeyPair, MISSION_ENGINE_AUDIENCE, TokenService } from "@nexus/auth";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import { buildApp } from "../dist/app.js";
import { ServiceContainer } from "../dist/services/container.js";
import { PrismaUserStore } from "../dist/services/persistence/prisma-user-store.js";
import { PrismaConversationStore } from "../dist/services/persistence/prisma-conversation-store.js";
import { PrismaAgentRunClaimStore } from "../dist/services/persistence/prisma-agent-run-claim-store.js";
import { PrismaMissionGrantRegistry } from "../dist/services/persistence/prisma-mission-grant-registry.js";
import { PrismaAgentRunStore } from "../dist/services/persistence/prisma-agent-run-store.js";

const API_PORT = Number(process.env.E2E_API_PORT ?? 3021);
const ENGINE_PORT = Number(process.env.E2E_ENGINE_PORT ?? 18121);
const MISSION_KEY = `e2e-confirmation-${Date.now()}`;
const PASSWORD = "VeryStrongPassword!42";

const steps = [];
let failures = 0;

function report(label, ok, detail = "") {
  steps.push({ label, ok, detail });
  const mark = ok ? "✓" : "✗";
  if (!ok) failures += 1;
  process.stdout.write(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function assert(label, condition, detail = "") {
  report(label, Boolean(condition), detail);
  if (!condition) throw new Error(`step failed: ${label}`);
}

/** Waits for a condition to become true, or aborts. */
async function until(label, probe, { timeoutMs = 60_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout exceeded waiting for: ${label} (last state ${JSON.stringify(last)})`);
}

/**
 * Sensitive demonstration tool requiring confirmation.
 */
const demoTool = {
  name: "demo.sensitive_action",
  description: "Demonstration action requiring human confirmation.",
  inputSchema: z.object({ note: z.string() }),
  outputSchema: z.object({ done: z.literal(true) }),
  riskLevel: "HIGH",
  requiredPermissions: [],
  requiresConfirmation: true,
  summarize: (input) => `Demonstration action: ${input.note}`,
  execute: () => Promise.resolve({ done: true }),
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  process.stdout.write("\nEnd-to-end: human confirmation and engine restart\n\n");

  const signingKeys = generateSigningKeyPair();
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    REDIS_URL: "redis://localhost:6379",
    AUTH_SIGNING_KEY: signingKeys.privateKeyPem,
    API_PORT: String(API_PORT),
  });

  const { createDatabaseClient } = await import("@nexus/database");
  const prisma = createDatabaseClient({ url: databaseUrl });

  // Scripted model calling sensitive tool, then returning final answer upon approval.
  const llm = new ScriptedLLMProvider([
    {
      kind: "tool_calls",
      calls: [{ id: "call-1", name: demoTool.name, arguments: { note: "organize emails" } }],
    },
    { kind: "final", text: "Action confirmed then executed." },
  ]);

  const services = new ServiceContainer({
    tokenPrivateKeyPem: signingKeys.privateKeyPem,
    prisma,
    users: new PrismaUserStore(prisma),
    conversations: new PrismaConversationStore(prisma),
    agentRunClaims: new PrismaAgentRunClaimStore(prisma),
    missionGrantRegistry: new PrismaMissionGrantRegistry(prisma),
    runStore: new PrismaAgentRunStore(prisma),
    llmProvider: llm,
    scrypt: { cost: 2 ** 14, blockSize: 8, parallelization: 1 },
  });
  services.toolRegistry.register(demoTool, { replace: true });

  const app = await buildApp({
    config,
    logger: silentLogger(),
    services,
    prisma,
    rateLimitStore: "memory",
    websocket: false,
  });
  await app.listen({ host: "127.0.0.1", port: API_PORT });
  report("API started", true, `127.0.0.1:${API_PORT}`);

  const engineDir = await mkdtemp(join(tmpdir(), "nexus-e2e-"));
  const publicKeyPath = join(engineDir, "api-public.pem");
  await writeFile(publicKeyPath, signingKeys.publicKeyPem);
  const acpRunner = join(engineDir, "runner.js");
  const acpRegistry = join(engineDir, "profiles.json");
  await writeFile(acpRunner, "// never executed: no ACP tasks in this scenario\n");
  await writeFile(acpRegistry, "{}\n");

  const engineEnv = {
    ...process.env,
    NEXUS_ENGINE_DATABASE: join(engineDir, "engine.db"),
    NEXUS_ENGINE_API_URL: `http://127.0.0.1:${API_PORT}`,
    NEXUS_ENGINE_API_PUBLIC_KEY_FILE: publicKeyPath,
    NEXUS_ENGINE_ACP_RUNNER: acpRunner,
    NEXUS_ENGINE_ACP_REGISTRY: acpRegistry,
    NEXUS_ENGINE_PROFILES_FILE: join(engineDir, "configured.json"),
    NEXUS_ENGINE_RUNTIME_SETTINGS_FILE: join(engineDir, "runtime.json"),
    NEXUS_ENGINE_WORKER_ENABLED: "true",
    NEXUS_ENGINE_WORKER_CONCURRENCY: "1",
  };

  let engine = await startEngine(engineEnv);
  report("engine started", true, `pid ${engine.pid}`);

  const account = await register(`e2e-${Date.now()}@example.test`);
  const grant = await services.missionGrants.issue({
    userId: account.userId,
    service: "mission-engine",
    missionExternalKey: MISSION_KEY,
  });
  report("account and mission assertion ready", true);

  const serviceToken = () =>
    new TokenService({ privateKeyPem: signingKeys.privateKeyPem }).issueServiceToken({
      service: "nexus-api",
      audience: MISSION_ENGINE_AUDIENCE,
    }).token;

  const submitted = await engineRequest("POST", "/v1/missions", {
    token: serviceToken(),
    headers: { "Idempotency-Key": MISSION_KEY },
    body: {
      external_key: MISSION_KEY,
      title: "End to end confirmation",
      workspace: engineDir,
      owner: {
        user_id: account.userId,
        assertion: grant.token,
        expires_at: grant.expiresAt.toISOString(),
      },
      tasks: [
        {
          key: "delegated",
          agent_kind: "agent-core",
          instruction: "Perform demonstration action.",
          depends_on: [],
        },
      ],
    },
  });
  assert("mission submitted to engine", submitted.status === 201, `HTTP ${submitted.status}`);
  const missionId = submitted.body.mission_id;

  const suspended = await until("task awaiting confirmation", async () => {
    const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
    const task = mission.body?.tasks?.[0];
    return task?.state === "awaiting_confirmation" ? task : undefined;
  });
  assert("task suspended on confirmation", true, `state ${suspended.state}`);

  const runId = await until("Agent Core run awaiting", async () => {
    const row = await prisma.agentRunSnapshot.findFirst({
      where: { userId: account.userId, missionExternalKey: MISSION_KEY },
    });
    return row?.status === "waiting_for_confirmation" ? row.id : undefined;
  });
  report("Agent Core run awaiting confirmation", true, runId);

  // Restart engine to verify persistent state across restarts.
  await stopEngine(engine);
  report("engine stopped", true, "SIGTERM");
  engine = await startEngine(engineEnv);
  report("engine restarted", true, `pid ${engine.pid}`);

  const afterRestart = await engineRequest("GET", `/v1/missions/${missionId}`);
  assert(
    "awaiting state preserved after restart",
    afterRestart.body?.tasks?.[0]?.state === "awaiting_confirmation",
    `state ${afterRestart.body?.tasks?.[0]?.state}`,
  );

  const approved = await apiRequest("POST", `/api/v1/agent-core/runs/${runId}/confirmation`, {
    token: account.accessToken,
    body: { decision: "approved" },
  });
  assert(
    "confirmation approved by owner",
    approved.status === 200,
    `HTTP ${approved.status}`,
  );

  const finished = await until(
    "task resumed and finished",
    async () => {
      const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
      const task = mission.body?.tasks?.[0];
      return task?.state === "succeeded" ? mission.body : undefined;
    },
    { timeoutMs: 90_000 },
  );
  assert("task succeeded after resumption", true);
  assert("mission succeeded", finished.state === "succeeded", `state ${finished.state}`);

  const result = JSON.parse(finished.tasks[0].result_json ?? "{}");
  assert(
    "final response returned by task",
    typeof result.response === "string" && result.response.includes("Action confirmed"),
    JSON.stringify(result.response),
  );

  const grants = await services.missionGrants.listByMission(MISSION_KEY);
  assert(
    "assertions retired on closure",
    grants.length > 0 && grants.every((item) => item.status !== "ACTIVE"),
    grants.map((item) => item.status).join(","),
  );

  await stopEngine(engine);
  await app.close();
  await cleanup(prisma, account.userId);
  await prisma.$disconnect();

  process.stdout.write(`\n${steps.length} steps, ${failures} failure(s)\n`);
  process.exitCode = failures === 0 ? 0 : 1;

  async function register(email) {
    const response = await apiRequest("POST", "/api/v1/auth/register", {
      body: { email, displayName: "E2E", password: PASSWORD },
    });
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(
        `registration refused: HTTP ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
    return {
      userId: response.body.data.user.id,
      accessToken: response.body.data.tokens.accessToken,
    };
  }
}

function silentLogger() {
  const noop = () => undefined;
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    level: "silent",
    child: () => logger,
  };
  return logger;
}

async function apiRequest(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function engineRequest(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${ENGINE_PORT}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function startEngine(env) {
  const child = spawn(
    ".venv/bin/python",
    [
      "-c",
      `import uvicorn; uvicorn.run("nexus_engine.api:app", host="127.0.0.1", port=${ENGINE_PORT}, log_level="warning")`,
    ],
    {
      cwd: new URL("../../mission-engine", import.meta.url).pathname,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (/error|Traceback|refus/i.test(text)) process.stderr.write(`    [engine] ${text}`);
  });

  await until(
    "engine ready",
    async () => {
      const health = await engineRequest("GET", "/v1/health/ready").catch(() => undefined);
      return health?.status === 200;
    },
    { timeoutMs: 45_000 },
  );
  return child;
}

async function stopEngine(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function cleanup(prisma, userId) {
  await prisma.agentCoreRunClaim.deleteMany({ where: { userId } });
  await prisma.missionGrant.deleteMany({ where: { userId } });
  await prisma.agentRunSnapshot.deleteMany({ where: { userId } });
  const conversations = await prisma.conversation.findMany({ where: { userId } });
  for (const conversation of conversations) {
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  }
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.authCredential.deleteMany({ where: { userId } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

main().catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
