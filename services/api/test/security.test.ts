import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_MESSAGE, workerEnvelope } from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import {
  FakeWorkerSocket,
  createAccount,
  makeApi,
  registerDevice,
  settle,
  signNonce,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";

/**
 * Audit de sécurité — scénarios d'attaque.
 *
 * Chaque test de ce fichier reproduit une attaque concrète. Ils sont écrits du
 * point de vue de l'attaquant, avec le moyen qu'il a réellement : une socket
 * ouverte sur le canal exécutant, un identifiant d'appareil public, ou un jeton
 * de worker dérobé.
 *
 * Le modèle de menace est celui du système : NEXUS pilote un portable Windows,
 * un poste fixe et un téléphone Android. Le téléphone est la machine la moins
 * digne de confiance — applications tierces, magasin de clés partagé, appareil
 * qui sort de chez soi. **Un Redmi compromis ne doit pas pouvoir agir sur le
 * poste fixe.**
 */

let harness: ApiHarness;
let account: Account;

let portable: RegisteredDevice;
let redmi: RegisteredDevice;

let sequence = 0;

function workerFrame(kind: keyof typeof WORKER_MESSAGE, payload: unknown) {
  sequence += 1;
  return workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
    id: `w-${String(sequence)}`,
    at: new Date(),
  });
}

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);

  portable = await registerDevice(harness, account, {
    name: "Portable Windows",
    role: "BOTH",
    permissions: ["filesystem.read", "terminal.execute"],
  });
  redmi = await registerDevice(harness, account, {
    name: "Redmi Note 10S",
    role: "WORKER",
    type: "ANDROID",
    platform: "ANDROID",
    permissions: ["android.app.open"],
  });
});

afterEach(async () => {
  await harness.close();
});

/** Ouvre une socket worker **sans s'authentifier**, en annonçant un appareil. */
async function announceOnly(deviceId: string, connectionId = "attaquant") {
  const socket = new FakeWorkerSocket();
  harness.app.workerChannel.open(connectionId, socket);

  await harness.app.workerChannel.handle(
    connectionId,
    workerFrame("hello", { deviceId, workerVersion: "0.1.0", platform: "WINDOWS" }),
  );

  return { socket, connectionId };
}

/** Poignée de main complète et légitime. */
async function authenticate(device: RegisteredDevice, connectionId: string) {
  const socket = new FakeWorkerSocket();
  harness.app.workerChannel.open(connectionId, socket);

  await harness.app.workerChannel.handle(
    connectionId,
    workerFrame("hello", {
      deviceId: device.device.id,
      workerVersion: "0.1.0",
      platform: "WINDOWS",
    }),
  );

  const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string };

  await harness.app.workerChannel.handle(
    connectionId,
    workerFrame("authenticate", {
      deviceId: device.device.id,
      nonce: challenge.nonce,
      signature: signNonce(device.privateKeyPem, challenge.nonce),
      capabilities: [],
      requestId: `auth-${connectionId}-${String(sequence)}`,
      timestamp: new Date().toISOString(),
    }),
  );

  return { socket, connectionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — Trames post-poignée-de-main sur une connexion non authentifiée
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 — une connexion non authentifiée n'écrit rien", () => {
  it("ne peut pas réécrire les capacités d'un appareil", async () => {
    // L'identifiant d'appareil est **public** : il figure dans l'interface, dans
    // les événements, et dans le fichier d'état du démon Windows. Il ne doit
    // donc jamais suffire à modifier quoi que ce soit.
    const { connectionId } = await announceOnly(portable.device.id);

    await harness.app.workerChannel.handle(
      connectionId,
      workerFrame("register", {
        capabilities: [
          {
            name: "terminal.execute",
            version: "1",
            description: "capacité injectée",
            enabled: true,
            metadata: {},
          },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 99 },
      }),
    );

    const device = await harness.services.deviceRegistry.requireDevice(portable.device.id);
    expect(device.capabilities).toEqual([]);
  });

  it("ne peut pas déclarer un appareil en ligne", async () => {
    // Marquer un appareil éteint comme disponible ferait dispatcher des étapes
    // vers le vide, et masquerait une panne réelle sur le tableau de bord.
    const { connectionId } = await announceOnly(redmi.device.id);

    await harness.app.workerChannel.handle(
      connectionId,
      workerFrame("heartbeat", {
        health: { activeTasks: 0, maxConcurrentTasks: 8 },
        requestId: "hb-attaquant",
        timestamp: new Date().toISOString(),
      }),
    );

    const device = await harness.services.deviceRegistry.requireDevice(redmi.device.id);
    expect(device.health.maxConcurrentTasks).not.toBe(8);
  });

  it("la connexion est fermée, pas simplement ignorée", async () => {
    // Ignorer en silence laisserait l'attaquant réessayer indéfiniment sur la
    // même socket.
    const { socket, connectionId } = await announceOnly(portable.device.id);

    await harness.app.workerChannel.handle(
      connectionId,
      workerFrame("register", { capabilities: [], health: { activeTasks: 0 } }),
    );

    expect(socket.closed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 — Résultat d'étape forgé
// ─────────────────────────────────────────────────────────────────────────────

describe("C2 — un exécutant ne répond que pour ses propres étapes", () => {
  it("un Redmi compromis ne peut pas forger le résultat d'une étape du portable", async () => {
    // Le scénario complet : le téléphone est la machine la moins sûre de la
    // flotte. S'il peut prétendre avoir exécuté une étape confiée au poste fixe,
    // il injecte des données arbitraires dans la boucle de l'agent — et la
    // frontière entre appareils ne vaut plus rien.
    const laptop = await authenticate(portable, "portable");

    await harness.app.workerChannel.handle(
      "portable",
      workerFrame("register", {
        capabilities: [
          {
            name: "filesystem.read",
            version: "1",
            description: "Lecture",
            enabled: true,
            metadata: {},
          },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 2 },
      }),
    );

    const attacker = await authenticate(redmi, "redmi");
    expect(attacker.socket.last(WORKER_MESSAGE.session)).toBeDefined();

    const plan = createTaskPlan({
      userId: account.userId,
      title: "Lire un fichier",
      originClientDeviceId: portable.device.id,
      correlationId: "corr-c2",
      steps: [
        {
          id: "s1",
          description: "Lire",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE",
        },
      ],
    });

    const running = harness.services.coordinator.execute(plan, {
      userPermissions: ["filesystem.read"],
    });

    await until(() => laptop.socket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);
    const dispatch = laptop.socket.last(WORKER_MESSAGE.taskDispatch) as {
      taskId: string;
      stepId: string;
    };

    // Le Redmi, authentifié pour lui-même, répond pour l'étape du portable.
    await harness.app.workerChannel.handle(
      "redmi",
      workerFrame("taskResult", {
        taskId: dispatch.taskId,
        stepId: dispatch.stepId,
        ok: true,
        result: { content: "CONTENU FORGE PAR L'ATTAQUANT" },
        sensitiveResult: false,
        error: null,
        durationMs: 1,
      }),
    );

    await settle(40);

    // Le résultat forgé ne doit pas avoir résolu l'étape : elle est toujours en
    // vol, en attente du vrai exécutant.
    const executed = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve("toujours-en-vol"), 50)),
    ]);

    expect(executed).toBe("toujours-en-vol");

    // Et la connexion fautive est fermée.
    expect(attacker.socket.closed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — Détachement provoqué depuis une connexion non authentifiée
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 — une connexion non authentifiée ne détache personne", () => {
  it("annoncer puis raccrocher ne met pas l'appareil hors ligne", async () => {
    // Coût de l'attaque : une socket et un identifiant public. Effet : toutes
    // les sessions de l'appareil révoquées, ses étapes en vol abandonnées.
    const legitimate = await authenticate(portable, "portable");
    expect(legitimate.socket.last(WORKER_MESSAGE.session)).toBeDefined();
    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);

    await announceOnly(portable.device.id, "attaquant");
    await harness.app.workerChannel.close("attaquant", "socket fermée");
    await settle();

    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);

    const device = await harness.services.deviceRegistry.requireDevice(portable.device.id);
    expect(device.status).not.toBe("OFFLINE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bornage des challenges
// ─────────────────────────────────────────────────────────────────────────────

describe("challenges", () => {
  it("une seule socket ne peut pas en réclamer indéfiniment", async () => {
    // Chaque `worker.hello` fait générer et retenir un nonce pendant une minute.
    // Sans plafond, une socket suffit à faire enfler la mémoire du cœur.
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("flood", socket);

    for (let index = 0; index < 40; index += 1) {
      await harness.app.workerChannel.handle(
        "flood",
        workerFrame("hello", {
          deviceId: portable.device.id,
          workerVersion: "0.1.0",
          platform: "WINDOWS",
        }),
      );
    }

    expect(socket.ofType(WORKER_MESSAGE.challenge).length).toBeLessThan(40);
    expect(socket.closed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H3 — Approbation d'une confirmation appartenant à quelqu'un d'autre
// ─────────────────────────────────────────────────────────────────────────────

describe("H3 — une confirmation n'est tranchée que par son propriétaire", () => {
  /** Met une demande en attente pour `account`, et rend son identifiant. */
  function pendingConfirmation(userId: string, confirmationId = "conf-cible") {
    const decided = harness.services.confirmationBroker.request({
      confirmationId,
      userId,
      action: "docker.execute",
      description: "Lancer un conteneur privilégié",
      riskLevel: "CRITICAL",
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    return { confirmationId, decided };
  }

  it("un autre compte ne peut pas approuver par l'API REST", async () => {
    // L'identifiant de confirmation voyage jusqu'à **tous** les clients de la
    // victime : il n'a jamais été un secret. S'il suffit à approuver, une action
    // CRITICAL s'exécute sur les machines de quelqu'un d'autre.
    const intrus = await createAccount(harness, "intrus@exemple.fr");
    const { confirmationId, decided } = pendingConfirmation(account.userId);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/v1/confirmations/${confirmationId}/respond`,
      headers: intrus.authorization,
      payload: { decision: "approved" },
    });

    // Refus indiscernable d'une demande absente : distinguer les deux
    // permettrait de sonder l'existence des confirmations d'autrui.
    expect(response.json<{ data: { accepted: boolean } }>().data.accepted).toBe(false);

    // Et la demande attend toujours.
    expect(harness.services.confirmationBroker.pendingIds(account.userId)).toContain(
      confirmationId,
    );
    void decided;
  });

  it("un autre compte ne peut pas approuver par le canal temps réel", async () => {
    const intrus = await createAccount(harness, "intrus2@exemple.fr");
    const { confirmationId } = pendingConfirmation(account.userId, "conf-ws");

    const accepted = await harness.services.confirmationBroker.respondAndRecord(
      confirmationId,
      "approved",
      intrus.userId,
    );

    expect(accepted).toBe(false);
    expect(harness.services.confirmationBroker.pendingIds(account.userId)).toContain(
      confirmationId,
    );
  });

  it("le propriétaire, lui, tranche", async () => {
    const { confirmationId, decided } = pendingConfirmation(account.userId, "conf-propre");

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/v1/confirmations/${confirmationId}/respond`,
      headers: account.authorization,
      payload: { decision: "approved" },
    });

    expect(response.json<{ data: { accepted: boolean } }>().data.accepted).toBe(true);
    await expect(decided).resolves.toBe("approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H4 — Annulation de l'exécution d'un autre compte
// ─────────────────────────────────────────────────────────────────────────────

describe("H4 — une exécution ne s'annule que par son propriétaire", () => {
  it("un autre compte ne peut pas arrêter une tâche", async () => {
    // `agent.cancel` sur le canal temps réel ne consultait aucun magasin : il
    // passait l'identifiant au superviseur sans rien vérifier. Un identifiant
    // deviné suffisait à interrompre le travail de quelqu'un d'autre.
    const intrus = await createAccount(harness, "intrus3@exemple.fr");

    const plan = createTaskPlan({
      userId: account.userId,
      title: "Longue tâche",
      originClientDeviceId: portable.device.id,
      correlationId: "corr-h4",
      steps: [
        {
          id: "s1",
          description: "Travailler",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
        },
      ],
    });

    harness.services.supervisor.start(plan, ["filesystem.read"]);

    expect(harness.services.supervisor.cancel(plan.id, intrus.userId)).toBe(false);
    expect(harness.services.supervisor.runningIds(account.userId)).toContain(plan.id);

    // Le propriétaire, lui, y arrive.
    expect(harness.services.supervisor.cancel(plan.id, account.userId)).toBe(true);
  });

  it("la route REST refuse aussi", async () => {
    const intrus = await createAccount(harness, "intrus4@exemple.fr");

    const plan = createTaskPlan({
      userId: account.userId,
      title: "Tâche privée",
      originClientDeviceId: portable.device.id,
      correlationId: "corr-h4b",
      steps: [
        {
          id: "s1",
          description: "Travailler",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
        },
      ],
    });
    await harness.services.taskStore.save(plan);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${plan.id}/cancel`,
      headers: intrus.authorization,
      payload: { reason: "malveillant" },
    });

    // La route vérifie déjà la propriété du plan et refuse avant d'atteindre le
    // superviseur. La garde du superviseur est la **seconde** barrière, celle
    // qui protège le chemin WebSocket — lequel ne consultait aucun magasin.
    //
    // Le code est 403 alors que le message dit « n'existe pas » : le statut
    // distingue donc encore « existe mais pas à vous » de « n'existe pas ».
    // C'est une fuite d'énumération mineure, relevée dans l'audit.
    expect(response.statusCode).toBe(403);
  });
});
