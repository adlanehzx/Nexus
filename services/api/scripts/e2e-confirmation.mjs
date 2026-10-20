#!/usr/bin/env node
/**
 * Bout en bout : une tâche déléguée traverse une confirmation humaine **et** un
 * redémarrage du moteur.
 *
 * C'est le seul test qui exerce la chaîne entière avec deux vrais processus :
 *
 *     mission
 *     → tâche Agent Core
 *     → outil à risque
 *     → awaiting_confirmation
 *     → redémarrage du moteur (SIGTERM, puis relance)
 *     → approbation par la surface utilisateur
 *     → reprise
 *     → tâche succeeded
 *     → mission succeeded
 *
 * **Ce qui est réel** : l'API Fastify, PostgreSQL, le processus Python du
 * moteur, sa base SQLite, le HTTP entre les deux, l'authentification de service
 * et les assertions de mission signées. Le redémarrage est un vrai arrêt de
 * processus, pas une réinitialisation d'objet.
 *
 * **Ce qui est simulé** : le modèle. Il est scripté pour réclamer un outil à
 * risque, puis répondre une fois l'accord donné. C'est la seule façon de rendre
 * le scénario déterministe : on ne peut pas demander à un vrai agent de
 * réclamer un outil dangereux sur commande. L'outil, lui, est inoffensif — il
 * rend une chaîne — mais il exige une confirmation, ce qui est tout ce que la
 * chaîne a besoin de voir.
 *
 * Lancement :
 *     DATABASE_URL=postgresql://... pnpm --filter @nexus/api e2e:confirmation
 *
 * Le script vit dans `services/api` et non à la racine : il importe `zod`,
 * `@nexus/config` et les magasins compilés, qui se résolvent depuis les
 * dépendances de ce paquet.
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
const PASSWORD = "MotDePasseTresSolide!42";

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
  if (!condition) throw new Error(`étape échouée : ${label}`);
}

/** Attend qu'une condition devienne vraie, ou abandonne. */
async function until(label, probe, { timeoutMs = 60_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`délai dépassé en attendant : ${label} (dernier état ${JSON.stringify(last)})`);
}

/**
 * Outil à risque, et sans danger.
 *
 * Il exige une confirmation et ne fait rien d'autre que rendre une chaîne.
 * C'est exactement ce qu'il faut : la chaîne à éprouver est la suspension et la
 * reprise, pas l'effet de l'outil — et un outil qui aurait un effet réel
 * rendrait ce test dangereux à relancer.
 */
const demoTool = {
  name: "demo.sensitive_action",
  description: "Action de démonstration qui exige un accord humain.",
  inputSchema: z.object({ note: z.string() }),
  outputSchema: z.object({ done: z.literal(true) }),
  riskLevel: "HIGH",
  requiredPermissions: [],
  requiresConfirmation: true,
  summarize: (input) => `Action de démonstration : ${input.note}`,
  execute: () => Promise.resolve({ done: true }),
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL est requis");

  process.stdout.write("\nBout en bout : confirmation humaine et redémarrage du moteur\n\n");

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

  // Le modèle : un appel d'outil à risque, puis la réponse finale une fois
  // l'accord donné. Deux tours, et c'est tout le déterminisme dont on a besoin.
  const llm = new ScriptedLLMProvider([
    {
      kind: "tool_calls",
      calls: [{ id: "call-1", name: demoTool.name, arguments: { note: "ranger les mails" } }],
    },
    { kind: "final", text: "Action confirmée puis exécutée." },
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
  report("API démarrée", true, `127.0.0.1:${API_PORT}`);

  const engineDir = await mkdtemp(join(tmpdir(), "nexus-e2e-"));
  const publicKeyPath = join(engineDir, "api-public.pem");
  await writeFile(publicKeyPath, signingKeys.publicKeyPem);
  // Fichiers factices : le moteur refuse de démarrer son worker sans runtime
  // ACP déclaré, alors que notre mission n'a aucune tâche ACP.
  const acpRunner = join(engineDir, "runner.js");
  const acpRegistry = join(engineDir, "profiles.json");
  await writeFile(acpRunner, "// jamais exécuté : aucune tâche ACP dans ce scénario\n");
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
  report("moteur démarré", true, `pid ${engine.pid}`);

  // Un compte réel : c'est lui qui possédera la mission, et c'est son jeton qui
  // approuvera la confirmation depuis la surface utilisateur.
  const account = await register(`e2e-${Date.now()}@exemple.test`);
  const grant = await services.missionGrants.issue({
    userId: account.userId,
    service: "mission-engine",
    missionExternalKey: MISSION_KEY,
  });
  report("compte et assertion de mission prêts", true);

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
      title: "Confirmation de bout en bout",
      workspace: engineDir,
      owner: {
        user_id: account.userId,
        assertion: grant.token,
        expires_at: grant.expiresAt.toISOString(),
      },
      tasks: [
        {
          key: "deleguee",
          agent_kind: "agent-core",
          instruction: "Effectue l'action de démonstration.",
          depends_on: [],
        },
      ],
    },
  });
  assert("mission soumise au moteur", submitted.status === 201, `HTTP ${submitted.status}`);
  const missionId = submitted.body.mission_id;

  const suspended = await until("tâche en attente de confirmation", async () => {
    const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
    const task = mission.body?.tasks?.[0];
    return task?.state === "awaiting_confirmation" ? task : undefined;
  });
  assert("tâche suspendue sur une confirmation", true, `état ${suspended.state}`);

  // Le run qui attend l'accord, vu depuis l'API.
  const runId = await until("run Agent Core en attente", async () => {
    const row = await prisma.agentRunSnapshot.findFirst({
      where: { userId: account.userId, missionExternalKey: MISSION_KEY },
    });
    return row?.status === "waiting_for_confirmation" ? row.id : undefined;
  });
  report("run Agent Core en attente d'accord", true, runId);

  // ── Le redémarrage. C'est le cœur du test : l'attente doit survivre à un
  //    arrêt de processus, parce qu'elle est en base et non en mémoire.
  await stopEngine(engine);
  report("moteur arrêté", true, "SIGTERM");
  engine = await startEngine(engineEnv);
  report("moteur relancé", true, `pid ${engine.pid}`);

  const afterRestart = await engineRequest("GET", `/v1/missions/${missionId}`);
  assert(
    "attente retrouvée après redémarrage",
    afterRestart.body?.tasks?.[0]?.state === "awaiting_confirmation",
    `état ${afterRestart.body?.tasks?.[0]?.state}`,
  );

  // ── L'approbation, par la surface utilisateur : c'est bien la personne qui
  //    tranche, avec son propre jeton, comme depuis le tableau de bord.
  const approved = await apiRequest("POST", `/api/v1/agent-core/runs/${runId}/confirmation`, {
    token: account.accessToken,
    body: { decision: "approved" },
  });
  assert(
    "confirmation approuvée par le propriétaire",
    approved.status === 200,
    `HTTP ${approved.status}`,
  );

  const finished = await until(
    "tâche reprise et terminée",
    async () => {
      const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
      const task = mission.body?.tasks?.[0];
      return task?.state === "succeeded" ? mission.body : undefined;
    },
    { timeoutMs: 90_000 },
  );
  assert("tâche succeeded après reprise", true);
  assert("mission succeeded", finished.state === "succeeded", `état ${finished.state}`);

  const result = JSON.parse(finished.tasks[0].result_json ?? "{}");
  assert(
    "réponse finale rendue par la tâche",
    typeof result.response === "string" && result.response.includes("Action confirmée"),
    JSON.stringify(result.response),
  );

  // Les assertions de la mission sont retirées à sa clôture.
  const grants = await services.missionGrants.listByMission(MISSION_KEY);
  assert(
    "assertions retirées à la clôture",
    grants.length > 0 && grants.every((item) => item.status !== "ACTIVE"),
    grants.map((item) => item.status).join(","),
  );

  await stopEngine(engine);
  await app.close();
  await cleanup(prisma, account.userId);
  await prisma.$disconnect();

  process.stdout.write(`\n${steps.length} étapes, ${failures} échec(s)\n`);
  process.exitCode = failures === 0 ? 0 : 1;

  // ── helpers liés au contexte ──────────────────────────────────────────────

  async function register(email) {
    const response = await apiRequest("POST", "/api/v1/auth/register", {
      body: { email, displayName: "E2E", password: PASSWORD },
    });
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(
        `inscription refusée : HTTP ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
    return {
      userId: response.body.data.user.id,
      accessToken: response.body.data.tokens.accessToken,
    };
  }
}

/**
 * Journal muet.
 *
 * Fastify veut un logger complet ; ce scenario veut un rapport lisible, pas
 * trois cents lignes de traces HTTP. Les methodes rendent `undefined` plutot
 * que d'avoir un corps vide, ce que le lint refuse a juste titre : une fonction
 * vide par accident ressemble a une fonction vide par intention.
 */
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
  // Le flux est consomme sans etre relaye : sans lecteur, le tube se remplit et
  // finirait par bloquer le processus enfant.
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    // On ne relaie que ce qui aide à diagnostiquer : le reste est du bruit
    // uvicorn qui noierait les étapes.
    if (/error|Traceback|refus/i.test(text)) process.stderr.write(`    [moteur] ${text}`);
  });

  await until(
    "moteur prêt",
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

/** Ne supprime que ce que cette exécution a créé. */
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
