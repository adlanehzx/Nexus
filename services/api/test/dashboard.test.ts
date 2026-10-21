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
 * Le tableau de bord de supervision.
 *
 * Deux propriétés dominent ce fichier, et ce sont les deux qui, si elles
 * lâchaient, ne se verraient pas :
 *
 *  1. **la garde d'administration** — un jeton de client ordinaire n'ouvre
 *     aucune des douze sections. Un téléphone perdu ne doit pas exposer
 *     l'infrastructure en plus de la conversation ;
 *  2. **le raisonnement du modèle ne sort pas.** Un run porte son transcript et
 *     les blocs opaques du fournisseur ; la projection ne les lit pas. C'est
 *     vérifié ici avec un run dont chaque champ interdit contient une chaîne
 *     reconnaissable, qu'on cherche ensuite dans la réponse JSON entière.
 */

let harness: ApiHarness;
/** Premier compte créé : c'est lui qui reçoit le rôle d'administrateur. */
let admin: Account;
/** Second compte : un utilisateur ordinaire. */
let membre: Account;

beforeEach(async () => {
  harness = await makeApi();
  admin = await createAccount(harness, "adlan@exemple.fr");
  membre = await createAccount(harness, "membre@exemple.fr");
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
// Authentification et autorisation
// ─────────────────────────────────────────────────────────────────────────────

describe("garde d'administration", () => {
  it("refuse toutes les sections sans jeton", async () => {
    for (const url of SECTIONS) {
      expect((await get(url)).statusCode, url).toBe(401);
    }
  });

  it("refuse toutes les sections à un compte ordinaire", async () => {
    // Il n'existe pas de sous-ensemble « moins sensible » ouvert au client :
    // une vue partielle du système est encore une vue du système.
    for (const url of SECTIONS) {
      expect((await get(url, membre)).statusCode, url).toBe(403);
    }
  });

  it("le refus ne révèle pas l'existence de la surface d'administration", async () => {
    const response = await get("/api/v1/dashboard/overview", membre);

    const body = response.json<{ error: { message: string } }>();
    expect(body.error.message).not.toMatch(/administrat/i);
    expect(body.error.message).toBe("The requested resource does not exist.");
  });

  it("ouvre toutes les sections à l'administrateur", async () => {
    for (const url of SECTIONS) {
      expect((await get(url, admin)).statusCode, url).toBe(200);
    }
  });

  it("le premier compte créé est l'administrateur, les suivants non", async () => {
    const premier = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: admin.authorization,
    });
    const second = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: membre.authorization,
    });

    expect(premier.json<{ data: { role: string } }>().data.role).toBe("ADMIN");
    expect(second.json<{ data: { role: string } }>().data.role).toBe("USER");
  });

  it("un retrait de droits prend effet immédiatement", async () => {
    // Le rôle est lu dans le magasin, pas dans le jeton : inscrit dans le
    // jeton, il resterait valide un quart d'heure après la rétrogradation.
    expect((await get("/api/v1/dashboard/overview", admin)).statusCode).toBe(200);

    await harness.services.users.setRole(admin.userId, "USER");

    expect((await get("/api/v1/dashboard/overview", admin)).statusCode).toBe(403);
  });

  it("aucune section n'écrit", async () => {
    // Superviser et administrer sont deux surfaces. Les réunir mettrait une
    // action destructrice à un clic d'un écran qu'on consulte machinalement.
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
// Le raisonnement ne sort pas
// ─────────────────────────────────────────────────────────────────────────────

/** Un run dont chaque champ interdit porte une chaîne qu'on saura retrouver. */
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
      response: "J'ai lancé les tests, tout passe.",
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
    // Ce que la projection ne doit jamais voir.
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "RAISONNEMENT_INTERNE_A_NE_PAS_DIVULGUER" }],
        providerBlocks: { thinking: "BLOC_OPAQUE_DU_FOURNISSEUR", signature: "sig-xyz" },
      },
      {
        role: "user",
        content: [{ type: "text", text: "MESSAGE_UTILISATEUR_BRUT" }],
      },
    ],
    pendingConfirmation: null,
    consecutiveToolFailures: 0,
    toolCallCount: 1,
    callSignatures: ["device.terminal.execute:SIGNATURE_INTERNE"],
    deadlineAt: 0,
    suspendedAt: null,
  };
}

const INTERDITS = [
  "RAISONNEMENT_INTERNE_A_NE_PAS_DIVULGUER",
  "BLOC_OPAQUE_DU_FOURNISSEUR",
  "MESSAGE_UTILISATEUR_BRUT",
  "SIGNATURE_INTERNE",
  "providerBlocks",
  "callSignatures",
];

describe("le raisonnement du modèle ne franchit pas la frontière", () => {
  it("la projection n'expose que ce qui a été autorisé", () => {
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

  it("aucun champ interdit ne survit à la projection", () => {
    const serialise = JSON.stringify(projectAgentRun(runWithSecrets("u1")));

    for (const interdit of INTERDITS) {
      expect(serialise).not.toContain(interdit);
    }
  });

  it("la route rend la même chose, et rien de plus", async () => {
    await harness.services.runStore.save(runWithSecrets(admin.userId) as never);

    const response = await get("/api/v1/dashboard/runs", admin);

    expect(response.statusCode).toBe(200);
    for (const interdit of INTERDITS) {
      expect(response.body, interdit).not.toContain(interdit);
    }
  });

  it("ce qui est autorisé, lui, est bien là", async () => {
    // La règle n'est pas « ne rien montrer » : statut, action, outil,
    // progression, résultat, erreur et métriques doivent sortir.
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

  it("le résumé d'action est rédigé", async () => {
    // La trace du run rédige déjà ses arguments ; on rédige une seconde fois à
    // la sortie, parce que ce chemin-là est public.
    const run = runWithSecrets(admin.userId);
    run.record.toolsUsed[0]!.input = { command: "curl", token: "sk-abcdefghijklmnopqrstuv" };
    await harness.services.runStore.save(run as never);

    const response = await get("/api/v1/dashboard/runs", admin);

    expect(response.body).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("un run d'un autre compte reste invisible", async () => {
    await harness.services.runStore.save(runWithSecrets(membre.userId) as never);

    const liste = await get("/api/v1/dashboard/runs", admin);
    expect(liste.json<{ data: { runs: unknown[] } }>().data.runs).toEqual([]);

    // Le rôle d'administrateur ouvre la supervision de l'infrastructure ; il n'a
    // jamais eu vocation à donner accès aux conversations d'autrui.
    expect((await get("/api/v1/dashboard/runs/run-1", admin)).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

describe("vue d'ensemble", () => {
  it("compte appareils, exécutants, tâches et runs", async () => {
    await registerDevice(harness, admin, { name: "Portable", role: "BOTH" });
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

  it("distingue « non configuré » de « en panne »", async () => {
    // Un serveur MCP qu'on n'a jamais branché n'est pas en panne. L'afficher en
    // rouge enverrait chercher un incident qui n'existe pas.
    const response = await get("/api/v1/dashboard/overview", admin);
    const health = response.json<{ data: { health: { name: string; level: string }[] } }>().data
      .health;

    expect(health.find((entry) => entry.name === "MCP")?.level).toBe("unconfigured");
    expect(health.find((entry) => entry.name === "Browser Use")?.level).toBe("unconfigured");
    expect(health.find((entry) => entry.name === "API")?.level).toBe("ok");
  });

  it("mêle les activités récentes de toutes les sources", async () => {
    harness.services.securityLog.record({
      kind: "device.trusted",
      userId: admin.userId,
      summary: "Appareil « Portable » approuvé",
    });

    const response = await get("/api/v1/dashboard/overview", admin);
    const activity = response.json<{ data: { recentActivity: { kind: string }[] } }>().data
      .recentActivity;

    expect(activity.some((entry) => entry.kind === "security")).toBe(true);
  });
});

describe("appareils", () => {
  it("rend tout ce que la page demande", async () => {
    const registered = await registerDevice(harness, admin, {
      name: "Portable Windows",
      role: "BOTH",
      permissions: ["terminal.execute"],
    });
    await harness.services.deviceRegistry.updateCapabilities(registered.device.id, [
      {
        name: "terminal.execute",
        version: "1",
        description: "Exécute une commande",
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

  it("ne rend pas l'appareil d'un autre compte", async () => {
    const autre = await registerDevice(harness, membre, { name: "Poste du membre", role: "BOTH" });

    expect((await get(`/api/v1/dashboard/devices/${autre.device.id}`, admin)).statusCode).toBe(404);
  });
});

describe("exécutants", () => {
  it("distingue le rôle déclaré du canal réellement ouvert", async () => {
    // Un exécutant appairé mais déconnecté n'exécutera rien. Afficher son rôle
    // sans son état de connexion ferait croire l'inverse.
    await registerDevice(harness, admin, { name: "Poste fixe", role: "WORKER" });

    const response = await get("/api/v1/dashboard/workers", admin);
    const workers = response.json<{
      data: { workers: { name: string; connected: boolean; acceptingTasks: boolean }[] };
    }>().data.workers;

    expect(workers).toHaveLength(1);
    expect(workers[0]?.connected).toBe(false);
    expect(workers[0]?.acceptingTasks).toBe(false);
  });

  it("exclut les clients purs", async () => {
    await registerDevice(harness, admin, { name: "iPhone", role: "CLIENT", type: "IPHONE" });

    const response = await get("/api/v1/dashboard/workers", admin);
    expect(response.json<{ data: { workers: unknown[] } }>().data.workers).toEqual([]);
  });
});

describe("tâches", () => {
  async function seedPlan() {
    const device = await registerDevice(harness, admin, { name: "Portable", role: "BOTH" });
    const plan = createTaskPlan({
      userId: admin.userId,
      title: "Lancer les tests",
      originClientDeviceId: device.device.id,
      correlationId: "corr-1",
      steps: [
        {
          id: "s1",
          description: "Exécuter pnpm test",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          riskLevel: "SAFE",
        },
      ],
    });
    await harness.services.taskStore.save(plan);
    return { plan, device };
  }

  it("rend le plan, ses étapes et sa progression", async () => {
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

    expect(task.title).toBe("Lancer les tests");
    expect(task.progressPercent).toBe(0);
    expect(task.steps[0]?.tool).toBe("device.terminal.execute");
    expect(task.steps[0]?.requiredCapabilities).toEqual(["terminal.execute"]);
    expect(task.executions).toEqual([]);
  });

  it("nomme l'exécutant retenu plutôt que de rendre un identifiant", async () => {
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

    expect(executions[0]?.deviceName).toBe("Portable");
    expect(executions[0]?.durationMs).toBe(5000);
  });

  it("ne rend pas la tâche d'un autre compte", async () => {
    const device = await registerDevice(harness, membre, { name: "Poste", role: "BOTH" });
    const plan = createTaskPlan({
      userId: membre.userId,
      title: "Privée",
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

describe("sections d'infrastructure", () => {
  it("annonce honnêtement un MCP non configuré", async () => {
    const response = await get("/api/v1/dashboard/mcp", admin);
    const data = response.json<{ data: { configured: boolean; servers: unknown[] } }>().data;

    expect(data.configured).toBe(false);
    expect(data.servers).toEqual([]);
  });

  it("annonce honnêtement un worker navigateur non configuré", async () => {
    const response = await get("/api/v1/dashboard/browser", admin);
    const data = response.json<{ data: { configured: boolean; reachable: boolean } }>().data;

    expect(data.configured).toBe(false);
    expect(data.reachable).toBe(false);
  });

  it("liste le catalogue d'outils avec ce qui est autorisé", async () => {
    const response = await get("/api/v1/dashboard/tools", admin);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { tools: unknown[] } }>().data.tools).toEqual([]);
  });
});

describe("mémoire", () => {
  it("compte par couche, origine et sensibilité", async () => {
    await harness.services.memoryService.remember({
      userId: admin.userId,
      content: "Réponds toujours en français",
      layer: "PREFERENCE",
    });
    await harness.services.memoryService.remember({
      userId: admin.userId,
      content: "Habite à Lyon",
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

describe("sécurité", () => {
  it("recense les événements produits par le reste de l'API", async () => {
    // Les événements ne sont pas fabriqués par le tableau de bord : ils sont
    // émis là où l'action a lieu, et il les lit.
    const device = await registerDevice(harness, admin, { name: "Portable", role: "BOTH" });

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

  it("journalise un échec de connexion sans l'adresse essayée", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "inconnu@exemple.fr", password: "mauvais mot de passe" },
    });

    const response = await get("/api/v1/dashboard/security", admin);
    expect(response.body).not.toContain("inconnu@exemple.fr");
    expect(response.body).not.toContain("mauvais mot de passe");
    expect(
      response.json<{ data: { byKind: Record<string, number> } }>().data.byKind[
        "auth.login_failed"
      ],
    ).toBe(1);
  });

  it("remonte un refus de mémorisation sans le contenu refusé", async () => {
    await harness.app
      .inject({
        method: "POST",
        url: "/api/v1/memory",
        headers: admin.authorization,
        payload: { content: "Mon mot de passe est Tr0ub4dor3xy" },
      })
      .catch(() => undefined);

    const response = await get("/api/v1/dashboard/security", admin);

    expect(response.body).not.toContain("Tr0ub4dor3xy");
    expect(
      response.json<{ data: { byKind: Record<string, number> } }>().data.byKind["memory.refused"],
    ).toBe(1);
  });
});

describe("journaux", () => {
  it("rend les lignes retenues, les plus récentes d'abord", async () => {
    harness.services.logs.write(
      JSON.stringify({ level: "info", time: "2026-09-03T10:00:00.000Z", msg: "première" }),
    );
    harness.services.logs.write(
      JSON.stringify({ level: "error", time: "2026-09-03T10:00:01.000Z", msg: "seconde" }),
    );

    const response = await get("/api/v1/dashboard/logs", admin);
    const entries = response.json<{ data: { entries: { message: string }[] } }>().data.entries;

    expect(entries.map((entry) => entry.message)).toEqual(["seconde", "première"]);
  });

  it("filtre par niveau", async () => {
    harness.services.logs.write(JSON.stringify({ level: "debug", msg: "bruit" }));
    harness.services.logs.write(JSON.stringify({ level: "error", msg: "incident" }));

    const response = await get("/api/v1/dashboard/logs?level=error", admin);
    const entries = response.json<{ data: { entries: { message: string }[] } }>().data.entries;

    expect(entries.map((entry) => entry.message)).toEqual(["incident"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Magasins d'observabilité
// ─────────────────────────────────────────────────────────────────────────────

describe("tampon de journaux", () => {
  it("comprend le format réel de ce dépôt", () => {
    // Le logger configure `formatters.level` et `timestamp: isoTime` : le niveau
    // est un **libellé** et l'heure une chaîne ISO. Ne reconnaître que le format
    // par défaut ferait tomber toutes les lignes en `info`, silencieusement.
    const buffer = new LogBuffer();
    buffer.write(
      JSON.stringify({
        level: "warn",
        time: "2026-09-03T10:00:00.000Z",
        msg: "attention",
        correlationId: "corr-9",
      }),
    );

    const entry = buffer.list()[0];
    expect(entry?.level).toBe("warn");
    expect(entry?.at).toBe("2026-09-03T10:00:00.000Z");
    expect(entry?.correlationId).toBe("corr-9");
  });

  it("comprend aussi le format par défaut de pino", () => {
    const buffer = new LogBuffer();
    buffer.write(JSON.stringify({ level: 50, time: 1_756_890_000_000, msg: "erreur" }));

    expect(buffer.list()[0]?.level).toBe("error");
  });

  it("rédige les secrets à l'entrée", () => {
    // Une ligne peut transporter un jeton dans un champ innocemment nommé.
    const buffer = new LogBuffer();
    buffer.write(JSON.stringify({ level: "info", msg: "appel", token: "sk-abcdefghijklmnopqrst" }));

    expect(JSON.stringify(buffer.list())).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("ne lève jamais sur une ligne illisible", () => {
    // Cette destination est appelée depuis le gestionnaire d'erreurs : une
    // exception y transformerait un incident en panne.
    const buffer = new LogBuffer();

    expect(() => {
      buffer.write("pas du json");
    }).not.toThrow();
    expect(buffer.size).toBe(0);
  });

  it("reste borné", () => {
    const buffer = new LogBuffer({ max: 3 });
    for (let index = 0; index < 10; index += 1) {
      buffer.write(JSON.stringify({ level: "info", msg: `ligne ${String(index)}` }));
    }

    expect(buffer.size).toBe(3);
    expect(buffer.list()[0]?.message).toBe("ligne 9");
  });
});

describe("journal de sécurité", () => {
  it("borne le résumé et rédige le contexte", () => {
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

  it("reste borné", () => {
    const log = new SecurityLog({ max: 2 });
    for (let index = 0; index < 5; index += 1) {
      log.record({ kind: "auth.login", summary: `connexion ${String(index)}` });
    }

    expect(log.size).toBe(2);
  });
});
