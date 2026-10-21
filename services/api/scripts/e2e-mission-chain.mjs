#!/usr/bin/env node
/**
 * Bout en bout : un message de chat traverse un DAG de vrais agents.
 *
 * C'est le scénario qui manquait. `e2e-confirmation.mjs` prouve qu'une
 * confirmation humaine survit à un redémarrage ; celui-ci prouve que la chaîne
 * **normale** fonctionne, celle qu'un usage réel emprunte à chaque message :
 *
 *     message de chat
 *     → plan validé (DAG)
 *     → deux agents en parallèle
 *     → un troisième qui dépend des deux et reçoit leurs résultats
 *     → son profil tombe en panne → repli sur un autre agent
 *     → redémarrage du moteur pendant que la mission est en vol
 *     → reprise
 *     → contrôle qualité (verdict analysé par le moteur)
 *     → synthèse finale, lisible par le propriétaire
 *
 * **Ce qui est réel** : l'API Fastify, PostgreSQL, le processus Python du
 * moteur, sa base SQLite, l'ordonnanceur du DAG (`ready`/`blocked`, injection
 * des résultats amont, repli de profil, temporisation de reprise), le runtime
 * ACP de NEXUS avec sa vraie politique de permissions, et de **vrais processus
 * d'agents** qui parlent ACP sur leur entrée et leur sortie standard. Le
 * redémarrage est un vrai SIGTERM suivi d'une relance.
 *
 * **Ce qui est scripté** : deux choses, et elles sont nommées parce qu'on ne
 * peut pas faire autrement sans clé payante ni déterminisme.
 *
 *   1. Le planificateur. Le modèle rend un DAG fixe, donc le scénario éprouve
 *      toujours la même forme de graphe. Le plan passe quand même par la
 *      validation réelle, côté API puis côté moteur.
 *   2. Le modèle **dans** les agents. Les agents, eux, sont réels : voir
 *      `services/agent/scripts/e2e-acp-agent.mjs`. Ils décident par leur
 *      `--mode` au lieu d'appeler une API, ce qui permet de provoquer sur
 *      commande ce qu'aucun fournisseur ne ferait à la demande : une panne de
 *      transport, et une tentative d'écriture hors de l'espace de travail.
 *
 * Ce que ce scénario ne couvre pas : la confirmation humaine durable, qui
 * n'existe que sur le chemin Agent Core et reste couverte par
 * `e2e-confirmation.mjs`. Un agent ACP ne suspend pas une mission en attendant
 * une personne ; sa permission est tranchée par la politique du runtime, et
 * c'est cette politique qui est éprouvée ici, dans les deux sens.
 *
 * Lancement :
 *     DATABASE_URL=postgresql://... pnpm --filter @nexus/api e2e:chain
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
const PASSWORD = "MotDePasseTresSolide!42";

/**
 * Temporisation avant la reprise d'une tâche en échec.
 *
 * Elle est courte pour que le scénario reste rapide, mais pas nulle, et c'est
 * délibéré : c'est elle qui ouvre une fenêtre **déterministe** pendant laquelle
 * la mission est en vol — deux tâches terminées, une en attente de reprise.
 * C'est dans cette fenêtre qu'on arrête le moteur. Sans elle, il faudrait
 * espérer arriver à temps, et un test qui court après une course finit par
 * échouer un jour sur deux pour une raison qui n'est pas celle qu'il surveille.
 */
const RETRY_DELAY_SECONDS = 8;

const steps = [];
let failures = 0;

/**
 * Le moteur en cours, au niveau du module.
 *
 * Parce qu'un échec doit pouvoir le tuer. Sans cette référence, une assertion
 * ratée laissait le processus Python et le serveur Fastify vivants : Node
 * gardait des descripteurs ouverts et ne sortait jamais. Le scénario
 * n'échouait donc pas, il **pendait** — et en intégration continue cela brûle
 * le délai du job au lieu de rapporter la cause. Trouvé en cassant le scénario
 * exprès, pas en le relisant.
 */
let running;

function report(label, ok, detail = "") {
  steps.push({ label, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? "✓" : "✗"} ${label.padEnd(52)} ${detail}\n`);
}

function assert(label, condition, detail = "") {
  report(label, Boolean(condition), detail);
  if (!condition) throw new Error(`étape échouée : ${label} (${detail})`);
}

async function until(label, probe, { timeoutMs = 90_000, intervalMs = 300 } = {}) {
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
 * Le DAG que le planificateur rendra.
 *
 * Trois tâches planifiées, choisies pour ce qu'elles obligent l'ordonnanceur à
 * faire : deux sans dépendance (donc parallélisables), une qui dépend des deux
 * (donc bloquée, puis nourrie de leurs deux résultats) et dont le profil
 * primaire tombe en panne (donc repliée). L'API ajoute ensuite d'office le
 * contrôle qualité et la synthèse finale — on ne les écrit pas ici, et c'est
 * justement ce qu'on veut vérifier.
 */
const PLAN = {
  title: "Chaîne de bout en bout",
  tasks: [
    {
      key: "collecte",
      profile: "alpha",
      depends_on: [],
      instruction: "Rassemble les éléments et écris une note dans l'espace de travail.",
    },
    {
      key: "exploration",
      profile: "etranger",
      depends_on: [],
      instruction: "Tente d'écrire en dehors de l'espace de travail.",
    },
    {
      key: "analyse",
      profile: "fragile",
      depends_on: ["collecte", "exploration"],
      instruction: "Confronte les deux résultats amont et conclus.",
    },
  ],
};

/** Les agents, par clé de profil : un mode du binaire d'agent, et un marqueur. */
const AGENTS = {
  alpha: { mode: "succeed", marker: "alpha" },
  etranger: { mode: "refuse-outside", marker: "etranger" },
  fragile: { mode: "crash", marker: "fragile" },
  revue: { mode: "review", marker: "revue" },
  synthese: { mode: "succeed", marker: "synthese" },
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL est requis");

  process.stdout.write("\nBout en bout : un message de chat traverse un DAG de vrais agents\n\n");

  const work = await mkdtemp(join(tmpdir(), "nexus-e2e-chain-"));
  const signingKeys = generateSigningKeyPair();

  // ── Le registre ACP et les agents ────────────────────────────────────────
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
  report("registre ACP écrit", true, `${Object.keys(AGENTS).length} agents réels`);

  // Le moteur lit ce fichier au démarrage et synchronise ses profils : pas
  // besoin de les enregistrer un par un en HTTP pour que la mission soit
  // routable.
  const profilesPath = join(work, "profils-configures.json");
  await writeFile(
    profilesPath,
    `${JSON.stringify(Object.fromEntries(Object.keys(AGENTS).map((key) => [key, `profil_${key}`])))}\n`,
  );

  // Réglages du moteur. Les priorités nomment explicitement qui relit et qui
  // synthétise : les valeurs par défaut désignent des profils de production
  // (`claude`, `codex`) qui n'existent pas ici, et le choix retomberait alors
  // sur le premier profil par ordre alphabétique — un détail qui déciderait du
  // scénario sans qu'il le dise.
  await writeFile(
    join(work, "reglages.json"),
    `${JSON.stringify({
      task_timeout_seconds: 120,
      max_attempts: 3,
      retry_delay_seconds: RETRY_DELAY_SECONDS,
      context_budget_chars: 60_000,
      quality_review: true,
      research_priority: ["alpha"],
      review_priority: ["revue"],
      synthesis_priority: ["synthese"],
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
    NEXUS_ENGINE_RUNTIME_SETTINGS_FILE: join(work, "reglages.json"),
    NEXUS_ENGINE_WORKER_ENABLED: "true",
    // Deux exécutants : sans quoi les deux tâches sans dépendance se
    // suivraient, et le parallélisme du DAG ne serait pas exercé.
    NEXUS_ENGINE_WORKER_CONCURRENCY: "2",
  };

  let engine = await startEngine(engineEnv);
  report("moteur démarré", true, `pid ${engine.pid}`);

  const ready = await engineRequest("GET", "/v1/health/ready");
  assert(
    "profils routables vus par le moteur",
    ready.body?.profiles?.length === Object.keys(AGENTS).length,
    (ready.body?.profiles ?? []).join(", "),
  );

  // ── L'API ────────────────────────────────────────────────────────────────
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    REDIS_URL: "redis://localhost:6379",
    AUTH_SIGNING_KEY: signingKeys.privateKeyPem,
    API_PORT: String(API_PORT),
  });

  const { createDatabaseClient } = await import("@nexus/database");
  const prisma = createDatabaseClient({ url: databaseUrl });
  // Forcer le chargement du moteur Prisma avant de changer de répertoire : il
  // se résout par rapport au répertoire courant.
  await prisma.$queryRaw`SELECT 1`;

  // Les espaces de travail des missions sont créés sous le répertoire courant.
  // On se place dans le dossier temporaire pour qu'une exécution n'écrive
  // jamais dans l'arbre des sources.
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
    // Le moteur vérifie l'identité du service sur toute route de mutation :
    // sans ce jeton, la soumission de mission serait refusée en 401. La
    // fermeture en émet un frais à chaque appel, comme en production — un
    // jeton de service vit deux minutes.
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
  report("API démarrée", true, `127.0.0.1:${API_PORT}`);

  const owner = await register(`e2e-chain-${Date.now()}@exemple.test`);
  const stranger = await register(`e2e-chain-autre-${Date.now()}@exemple.test`);
  report("deux comptes réels", true, "propriétaire et tiers");

  // ── Le message de chat : c'est le seul geste du scénario ─────────────────
  const submitted = await apiRequest("POST", "/api/v1/orchestrator/messages", {
    token: owner.accessToken,
    body: { message: "Analyse la situation et rends une conclusion vérifiable." },
  });
  assert(
    "message de chat accepté",
    submitted.status === 202,
    `HTTP ${submitted.status} ${JSON.stringify(submitted.body?.error ?? "")}`,
  );
  const missionId = submitted.body.data.missionId;
  assert(
    "plan validé et étendu par l'API",
    submitted.body.data.totalTasks === PLAN.tasks.length + 2,
    `${submitted.body.data.totalTasks} tâches (3 planifiées + revue + synthèse)`,
  );
  assert("planificateur appelé une fois", llm.callCount === 1, `${llm.callCount} appel(s)`);

  // ── Le redémarrage, dans la fenêtre ouverte par la temporisation ─────────
  const inFlight = await until("mission en vol, une tâche en attente de reprise", async () => {
    const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
    const tasks = mission.body?.tasks ?? [];
    const waiting = tasks.find(
      (task) => task.task_key === "analyse" && task.state === "retry_wait",
    );
    const done = tasks.filter((task) => task.state === "succeeded").length;
    return waiting !== undefined && done >= 2 ? { done } : undefined;
  });
  report("mission en vol", true, `${inFlight.done} tâches terminées, analyse en reprise`);

  await stopEngine(engine);
  report("moteur arrêté en pleine mission", true, "SIGTERM");
  engine = await startEngine(engineEnv);
  report("moteur relancé", true, `pid ${engine.pid}`);

  // ── La mission doit se terminer malgré le redémarrage ────────────────────
  const finished = await until(
    "mission terminée",
    async () => {
      const mission = await engineRequest("GET", `/v1/missions/${missionId}`);
      const state = mission.body?.state;
      return state === "succeeded" || state === "failed" ? mission.body : undefined;
    },
    { timeoutMs: 180_000 },
  );
  assert("mission réussie après redémarrage", finished.state === "succeeded", finished.state);

  const byKey = new Map(finished.tasks.map((task) => [task.task_key, task]));
  const responseOf = (key) => {
    const raw = byKey.get(key)?.result_json;
    if (typeof raw !== "string") return "";
    const parsed = JSON.parse(raw);
    return typeof parsed.response === "string" ? parsed.response : "";
  };

  // ── Les agents ont bien tourné, chacun le sien ───────────────────────────
  assert(
    "agent de collecte",
    responseOf("collecte").includes("MARQUEUR=alpha"),
    byKey.get("collecte")?.profile_key,
  );
  assert(
    "permission accordée dans l'espace de travail",
    responseOf("collecte").includes("PERMISSION=autorisee"),
    "politique du runtime",
  );
  assert(
    "permission refusée hors de l'espace de travail",
    responseOf("exploration").includes("PERMISSION=refusee"),
    "le runtime a refusé un chemin étranger",
  );

  // ── Le repli de profil ───────────────────────────────────────────────────
  const analyse = byKey.get("analyse");
  assert(
    "repli de profil après panne du primaire",
    analyse?.profile_key !== "fragile" && responseOf("analyse").includes("MARQUEUR="),
    `fragile → ${analyse?.profile_key}`,
  );
  assert(
    "la panne a bien été vécue",
    (analyse?.attempts?.length ?? 0) >= 2,
    `${analyse?.attempts?.length ?? 0} tentative(s)`,
  );

  // ── Le passage des résultats ─────────────────────────────────────────────
  const analyseResponse = responseOf("analyse");
  assert(
    "les deux amont ont été injectés",
    analyseResponse.includes("AMONT=collecte+exploration"),
    analyseResponse.match(/AMONT=[^ ]*/)?.[0] ?? "aucun",
  );
  assert(
    "leur contenu a circulé, pas seulement leurs clés",
    analyseResponse.includes("alpha") && analyseResponse.includes("etranger"),
    analyseResponse.match(/MARQUEURS_AMONT=[^ ]*/)?.[0] ?? "aucun",
  );

  // ── Le contrôle qualité ──────────────────────────────────────────────────
  //
  // Ce scénario ne suppose **pas** quel agent relit. Le profil du contrôle
  // qualité est choisi par le routeur d'agents, qui arbitre sur la santé et les
  // statistiques : une priorité configurée est une préférence, pas une
  // assignation. Ma première version exigeait ici un verdict JSON, ce qui
  // revenait à exiger que le routeur choisisse l'agent relecteur — et le
  // scénario échouait pour une raison qui n'était pas celle qu'il surveille.
  //
  // Ce qui se vérifie à ce niveau est donc la **forme du graphe** : le contrôle
  // a eu lieu, et un verdict illisible n'étend pas le graphe. L'analyse stricte
  // du verdict, elle, est couverte là où elle vit — côté moteur, par
  // `test_invalid_quality_review_cannot_expand_task_graph`.
  const review = byKey.get("nexus_quality_review_1");
  assert("contrôle qualité exécuté", review?.state === "succeeded", review?.profile_key);
  assert(
    "un verdict illisible n'étend pas le graphe",
    byKey.get("nexus_correction_1") === undefined,
    // Le moteur échoue **ouvert** par conception : le synthétiseur reçoit quand
    // même la relecture, mais une réponse malformée ne peut pas fabriquer un
    // graphe de tâches infini.
    `${String(finished.tasks.length)} tâches, aucune correction`,
  );

  // ── La synthèse finale, telle que le chat la verra ───────────────────────
  const synthesis = responseOf("nexus_final_synthesis");
  assert(
    "synthèse finale produite",
    // `MARQUEUR=` sans sa valeur : c'est la preuve qu'un vrai agent a répondu,
    // sans supposer **lequel** — le routeur en décide, comme pour la relecture.
    /MARQUEUR=[a-z]+/.test(synthesis),
    byKey.get("nexus_final_synthesis")?.profile_key,
  );
  assert(
    "la synthèse a reçu l'analyse et la revue",
    synthesis.includes("AMONT=analyse+nexus_quality_review_1"),
    synthesis.match(/AMONT=[^ ]*/)?.[0] ?? "aucun",
  );

  const seen = await apiRequest("GET", `/api/v1/orchestrator/missions/${missionId}`, {
    token: owner.accessToken,
  });
  assert(
    "réponse visible par le propriétaire",
    seen.status === 200 &&
      seen.body.data.state === "succeeded" &&
      typeof seen.body.data.response === "string" &&
      // La réponse rendue au chat est celle de la synthèse : on vérifie qu'elle
      // vient bien d'un agent, pas qu'elle vient d'un agent nommé.
      /MARQUEUR=[a-z]+/.test(seen.body.data.response),
    `HTTP ${seen.status}, état ${seen.body?.data?.state}`,
  );
  assert(
    "tâches comptées comme terminées",
    seen.body.data.completedTasks === seen.body.data.totalTasks,
    `${seen.body.data.completedTasks}/${seen.body.data.totalTasks}`,
  );

  // La propriété n'est pas une convention de nommage : un tiers ne voit rien.
  const refused = await apiRequest("GET", `/api/v1/orchestrator/missions/${missionId}`, {
    token: stranger.accessToken,
  });
  assert("mission invisible pour un tiers", refused.status === 404, `HTTP ${refused.status}`);

  // Les assertions de propriété sont retirées à la clôture de la mission.
  const grants = await services.missionGrants.listByMission(finished.external_key);
  assert(
    "assertions de mission retirées à la clôture",
    grants.length > 0 && grants.every((grant) => grant.status !== "ACTIVE"),
    grants.map((grant) => grant.status).join(","),
  );

  await stopEngine(engine);
  await app.close();
  for (const account of [owner, stranger]) await cleanup(prisma, account.userId);
  await prisma.$disconnect();

  process.stdout.write(`\n${steps.length} étapes, ${failures} échec(s)\n\n`);
  process.exitCode = failures === 0 ? 0 : 1;

  async function register(email) {
    const response = await apiRequest("POST", "/api/v1/auth/register", {
      body: { email, displayName: "E2E", password: PASSWORD },
    });
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`inscription refusée : HTTP ${response.status}`);
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
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

main().catch(async (error) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.stdout.write(`\n${steps.length} étapes, ${Math.max(failures, 1)} échec(s)\n\n`);
  if (running !== undefined) await stopEngine(running).catch(() => undefined);
  // Sortie explicite : l'API écoute encore, et attendre que Node se vide tout
  // seul reviendrait à ne jamais sortir.
  process.exit(1);
});
