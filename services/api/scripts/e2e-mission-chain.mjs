#!/usr/bin/env node
/**
 * End-to-end: a chat message travels through a DAG of real agents.
 *
 *     chat message
 *     → validated plan (DAG)
 *     → two parallel agents
 *     → third agent depending on both and receiving their results
 *     → primary profile crashes → fallback to secondary agent
 *     → engine restart mid-flight
 *     → resumption
 *     → quality review
 *     → final synthesis visible to owner
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@nexus/config";
import { generateSigningKeyPair, MISSION_ENGINE_AUDIENCE, TokenService } from "@nexus/auth";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import { MissionControlClient } from "@nexus/mission-control-client";
import { buildApp } from "../dist/app.js";
import { ServiceContainer } from "../dist/services/container.js";
import { PrismaUserStore } from "../dist/services/persistence/prisma-user-store.js";
import { PrismaConversationStore } from "../dist/services/persistence/prisma-conversation-store.js";
import { PrismaAgentRunClaimStore } from "../dist/services/persistence/prisma-agent-run-claim-store.js";
import { PrismaMissionGrantRegistry } from "../dist/services/persistence/prisma-mission-grant-registry.js";
import { PrismaAgentRunStore } from "../dist/services/persistence/prisma-agent-run-store.js";

const API_PORT = Number(process.env.E2E_CHAIN_API_PORT ?? 3022);
const ENGINE_PORT = Number(process.env.E2E_CHAIN_ENGINE_PORT ?? 18122);
const PASSWORD = "VeryStrongPassword!42";

/** Delay before retrying a failed task, opening deterministic in-flight window. */
const RETRY_DELAY_SECONDS = 8;

const steps = [];
let failures = 0;

let running;

function report(label, ok, detail = "") {
  steps.push({ label, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? "✓" : "✗"} ${label.padEnd(52)} ${detail}\n`);
}

function assert(label, condition, detail = "") {
  report(label, Boolean(condition), detail);
  if (!condition) throw new Error(`step failed: ${label} (${detail})`);
}

async function until(label, probe, { timeoutMs = 90_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout exceeded waiting for: ${label} (last state ${JSON.stringify(last)})`);
}

/** DAG returned by planner. */
const PLAN = {
  title: "End-to-end chain",
  tasks: [
    {
      key: "collect",
      profile: "alpha",
      depends_on: [],
      instruction: "Collect items and write a note in workspace.",
    },
    {
      key: "explore",
      profile: "foreign",
      depends_on: [],
      instruction: "Attempt to write outside of workspace.",
    },
    {
      key: "analyze",
      profile: "fragile",
      depends_on: ["collect", "explore"],
      instruction: "Compare both upstream results and conclude.",
    },
  ],
};

/** Agents by profile key: mode of agent binary and marker. */
const AGENTS = {
  alpha: { mode: "succeed", marker: "alpha" },
  foreign: { mode: "refuse-outside", marker: "foreign" },
  fragile: { mode: "crash", marker: "fragile" },
  review: { mode: "review", marker: "review" },
  synthesis: { mode: "succeed", marker: "synthesis" },
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  process.stdout.write("\nEnd-to-end: chat message travels through DAG of real agents\n\n");

  const work = await mkdtemp(join(tmpdir(), "nexus-e2e-chain-"));
  const signingKeys = generateSigningKeyPair();

  // ── ACP registry and agents ──────────────────────────────────────────────
  const agentBinary = new URL("../../agent/scripts/e2e-acp-agent.mjs", import.meta.url).pathname;
  const registryPath = join(work, "acp-registry.json");
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        profiles: Object.fromEntries(
          Object.entries(AGENTS).map(([key, agent]) => [
            `profil_${key}`,
            {
              name: `e2e-${key}`,
              command: process.execPath,
              args: [agentBinary, "--mode", agent.mode, "--marker", agent.marker],
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  report("ACP registry written", true, `${Object.keys(AGENTS).length} real agents`);

  const profilesPath = join(work, "configured-profiles.json");
  await writeFile(
    profilesPath,
    `${JSON.stringify(Object.fromEntries(Object.keys(AGENTS).map((key) => [key, `profil_${key}`])))}\n`,
  );

  await writeFile(
    join(work, "runtime-settings.json"),
    `${JSON.stringify({
      task_timeout_seconds: 120,
      max_attempts: 3,
      retry_delay_seconds: RETRY_DELAY_SECONDS,
      context_budget_chars: 60_000,
      quality_review: true,
      research_priority: ["alpha"],
      review_priority: ["review"],
      synthesis_priority: ["synthesis"],
    })}\n`,
  );

  const publicKeyPath = join(work, "api-public.pem");
  await writeFile(publicKeyPath, signingKeys.publicKeyPem);

  const engineEnv = {
    ...process.env,
    NEXUS_ENGINE_DATABASE: join(work, "engine.db"),
    NEXUS_ENGINE_API_URL: `http://127.0.0.1:${API_PORT}`,
    NEXUS_ENGINE_API_PUBLIC_KEY_FILE: publicKeyPath,
    NEXUS_ENGINE_ACP_RUNNER: new URL("../../agent/dist/cli.js", import.meta.url).pathname,
    NEXUS_ENGINE_ACP_REGISTRY: registryPath,
    NEXUS_ENGINE_PROFILES_FILE: profilesPath,
    NEXUS_ENGINE_RUNTIME_SETTINGS_FILE: join(work, "runtime-settings.json"),
    NEXUS_ENGINE_WORKER_ENABLED: "true",
    NEXUS_ENGINE_WORKER_CONCURRENCY: "2",
  };

  let engine = await startEngine(engineEnv);
  report("engine started", true, `pid ${engine.pid}`);

  const ready = await engineRequest("GET", "/v1/health/ready");
  assert(
    "routable profiles seen by engine",
    ready.body?.profiles?.length === Object.keys(AGENTS).length,
    (ready.body?.profiles ?? []).join(", "),
  );

  // ── API setup ────────────────────────────────────────────────────────────
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    REDIS_URL: "redis://localhost:6379",
    AUTH_SIGNING_KEY: signingKeys.privateKeyPem,
    API_PORT: String(API_PORT),
  });

  const { createDatabaseClient } = await import("@nexus/database");
  const prisma = createDatabaseClient({ url: databaseUrl });
  await prisma.$queryRaw`SELECT 1`;

  process.chdir(work);
  await mkdir(join(work, ".nexus-workspaces"), { recursive: true });

  const llm = new ScriptedLLMProvider([{ kind: "final", text: JSON.stringify(PLAN) }]);

  const services = new ServiceContainer({
    tokenPrivateKeyPem: signingKeys.privateKeyPem,
    prisma,
    users: new PrismaUserStore(prisma),
    conversations: new PrismaConversationStore(prisma),
    agentRunClaims: new PrismaAgentRunClaimStore(prisma),
    missionGrantRegistry: new PrismaMissionGrantRegistry(prisma),
    runStore: new PrismaAgentRunStore(prisma),
    llmProvider: llm,
    missionControl: new MissionControlClient({
      baseUrl: `http://127.0.0.1:${ENGINE_PORT}`,
      serviceToken: () =>
        new TokenService({ privateKeyPem: signingKeys.privateKeyPem }).issueServiceToken({
          service: "nexus-api",
          audience: MISSION_ENGINE_AUDIENCE,
        }).token,
    }),
    scrypt: { cost: 2 ** 14, blockSize: 8, parallelization: 1 },
  });

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

  const owner = await register(`e2e-chain-${Date.now()}@example.test`);
  const stranger = await register(`e2e-chain-stranger-${Date.now()}@example.test`);
  report("two real accounts", true, "owner and third-party");

  // ── Chat message dispatch ────────────────────────────────────────────────
  const submitted = await apiRequest("POST", "/api/v1/orchestrator/messages", {
    token: owner.accessToken,
    body: { message: "Analyze the situation and produce a verifiable conclusion." },
  });
  assert(
    "chat message accepted",
    submitted.status === 202,
    `HTTP ${submitted.status} ${JSON.stringify(submitted.body?.error ?? "")}`,
  );
  const missionId = submitted.body.data.missionId;
  assert(
    "plan validated and expanded by API",
    submitted.body.data.totalTasks === PLAN.tasks.length + 2,
    `${submitted.body.data.totalTasks} tasks (3 planned + review + synthesis)`,
  );
  assert("planner called once", llm.callCount === 1, `${llm.callCount} call(s)`);

  // ── Engine restart during in-flight retry window ─────────────────────────
  const inFlight = await until("mission in flight, one task awaiting retry", async () => {
    const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
    const tasks = mission.body?.tasks ?? [];
    const waiting = tasks.find(
      (task) => task.task_key === "analyze" && task.state === "retry_wait",
    );
    const done = tasks.filter((task) => task.state === "succeeded").length;
    return waiting !== undefined && done >= 2 ? { done } : undefined;
  });
  report("mission in flight", true, `${inFlight.done} tasks completed, analyze retrying`);

  await stopEngine(engine);
  report("engine stopped mid-mission", true, "SIGTERM");
  engine = await startEngine(engineEnv);
  report("engine restarted", true, `pid ${engine.pid}`);

  // ── Completion verification ──────────────────────────────────────────────
  const finished = await until(
    "mission finished",
    async () => {
      const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
      const state = mission.body?.state;
      return state === "succeeded" || state === "failed" ? mission.body : undefined;
    },
    { timeoutMs: 180_000 },
  );
  assert("mission succeeded after restart", finished.state === "succeeded", finished.state);

  const byKey = new Map(finished.tasks.map((task) => [task.task_key, task]));
  const responseOf = (key) => {
    const raw = byKey.get(key)?.result_json;
    if (typeof raw !== "string") return "";
    const parsed = JSON.parse(raw);
    return typeof parsed.response === "string" ? parsed.response : "";
  };

  // ── Agent executions ─────────────────────────────────────────────────────
  assert(
    "collection agent",
    responseOf("collect").includes("MARKER=alpha"),
    byKey.get("collect")?.profile_key,
  );
  assert(
    "permission granted inside workspace",
    responseOf("collect").includes("PERMISSION=allowed"),
    "runtime policy",
  );
  assert(
    "permission denied outside workspace",
    responseOf("explore").includes("PERMISSION=rejected"),
    "runtime rejected foreign path",
  );

  // ── Profile fallback ─────────────────────────────────────────────────────
  const analyze = byKey.get("analyze");
  assert(
    "profile fallback after primary failure",
    analyze?.profile_key !== "fragile" && responseOf("analyze").includes("MARKER="),
    `fragile → ${analyze?.profile_key}`,
  );
  assert(
    "failure occurred before fallback",
    (analyze?.attempts?.length ?? 0) >= 2,
    `${analyze?.attempts?.length ?? 0} attempt(s)`,
  );

  // ── Upstream results passing ─────────────────────────────────────────────
  const analyzeResponse = responseOf("analyze");
  assert(
    "both upstream injected",
    analyzeResponse.includes("UPSTREAM=collect+explore"),
    analyzeResponse.match(/UPSTREAM=[^ ]*/)?.[0] ?? "none",
  );
  assert(
    "content circulated, not just keys",
    analyzeResponse.includes("alpha") && analyzeResponse.includes("foreign"),
    analyzeResponse.match(/UPSTREAM_MARKERS=[^ ]*/)?.[0] ?? "none",
  );

  // ── Quality review ───────────────────────────────────────────────────────
  const review = byKey.get("nexus_quality_review_1");
  assert("quality review executed", review?.state === "succeeded", review?.profile_key);
  assert(
    "unparseable verdict does not expand graph",
    byKey.get("nexus_correction_1") === undefined,
    `${String(finished.tasks.length)} tasks, no correction`,
  );

  // ── Final synthesis ──────────────────────────────────────────────────────
  const synthesis = responseOf("nexus_final_synthesis");
  assert(
    "final synthesis produced",
    /MARKER=[a-z]+/.test(synthesis),
    byKey.get("nexus_final_synthesis")?.profile_key,
  );
  assert(
    "synthesis received analyze and review",
    synthesis.includes("UPSTREAM=analyze+nexus_quality_review_1"),
    synthesis.match(/UPSTREAM=[^ ]*/)?.[0] ?? "none",
  );

  const seen = await apiRequest("GET", `/api/v1/orchestrator/missions/${missionId}`, {
    token: owner.accessToken,
  });
  assert(
    "response visible to owner",
    seen.status === 200 &&
      seen.body.data.state === "succeeded" &&
      typeof seen.body.data.response === "string" &&
      /MARKER=[a-z]+/.test(seen.body.data.response),
    `HTTP ${seen.status}, state ${seen.body?.data?.state}`,
  );
  assert(
    "tasks counted as completed",
    seen.body.data.completedTasks === seen.body.data.totalTasks,
    `${seen.body.data.completedTasks}/${seen.body.data.totalTasks}`,
  );

  const refused = await apiRequest("GET", `/api/v1/orchestrator/missions/${missionId}`, {
    token: stranger.accessToken,
  });
  assert("mission invisible to third-party", refused.status === 404, `HTTP ${refused.status}`);

  const grants = await services.missionGrants.listByMission(finished.external_key);
  assert(
    "mission assertions retired on closure",
    grants.length > 0 && grants.every((grant) => grant.status !== "ACTIVE"),
    grants.map((grant) => grant.status).join(","),
  );

  await stopEngine(engine);
  await app.close();
  for (const account of [owner, stranger]) await cleanup(prisma, account.userId);
  await prisma.$disconnect();

  process.stdout.write(`\n${steps.length} steps, ${failures} failure(s)\n\n`);
  process.exitCode = failures === 0 ? 0 : 1;

  async function register(email) {
    const response = await apiRequest("POST", "/api/v1/auth/register", {
      body: { email, displayName: "E2E", password: PASSWORD },
    });
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`registration refused: HTTP ${response.status}`);
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

async function request(port, method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
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

const apiRequest = (method, path, options) => request(API_PORT, method, path, options);
const engineRequest = (method, path, options) => request(ENGINE_PORT, method, path, options);

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
  running = child;
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
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

main().catch(async (error) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.stdout.write(`\n${steps.length} steps, ${Math.max(failures, 1)} failure(s)\n\n`);
  if (running !== undefined) await stopEngine(running).catch(() => undefined);
  process.exit(1);
});
