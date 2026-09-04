import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
  WORKER_MESSAGE,
  clientEnvelope,
  workerEnvelope,
  type WorkerPayload,
} from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import {
  FakeClientSocket,
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
 * Les deux canaux temps réel.
 *
 * Ce fichier éprouve la propriété centrale du système : **aucun client ne parle
 * à un exécutant**. Un client demande au cœur, le cœur autorise, choisit,
 * dispatche, et les résultats reviennent par le cœur — à *tous* les clients de
 * l'utilisateur, l'appareil d'origine servi en premier.
 */

let harness: ApiHarness;
let account: Account;

/** L'iPhone et le portable : les deux clients qui doivent rester synchronisés. */
let iphone: RegisteredDevice;
let laptop: RegisteredDevice;
let worker: RegisteredDevice;

let sequence = 0;

function clientMessage(type: string, payload: unknown, requestId?: string) {
  sequence += 1;
  return clientEnvelope(type as never, payload as never, {
    id: `c-${String(sequence)}`,
    at: new Date(),
    requestId,
  });
}

function workerMessage(kind: keyof typeof WORKER_MESSAGE, payload: unknown) {
  sequence += 1;
  return workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
    id: `w-${String(sequence)}`,
    at: new Date(),
  });
}

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);

  iphone = await registerDevice(harness, account, {
    name: "iPhone",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
  });
  laptop = await registerDevice(harness, account, {
    name: "Portable",
    role: "BOTH",
    permissions: ["filesystem.read"],
  });
  worker = await registerDevice(harness, account, {
    name: "Poste fixe",
    role: "WORKER",
    permissions: ["filesystem.read", "terminal.execute"],
  });
});

afterEach(async () => {
  await harness.close();
});

/** Connecte un client au canal et rend sa socket. */
async function connectClient(device: RegisteredDevice) {
  const socket = new FakeClientSocket();
  const context = await harness.app.clientChannel.authenticate({
    accessToken: account.accessToken,
    deviceId: device.device.id,
  });
  await harness.app.clientChannel.attach(context, socket);

  return { socket, context };
}

/** Déroule la poignée de main complète d'un exécutant sur le canal worker. */
async function connectWorker(device: RegisteredDevice, connectionId = "w1") {
  const socket = new FakeWorkerSocket();
  harness.app.workerChannel.open(connectionId, socket);

  await harness.app.workerChannel.handle(
    connectionId,
    workerMessage("hello", {
      deviceId: device.device.id,
      workerVersion: "0.1.0",
      platform: "WINDOWS",
    }),
  );

  const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string } | undefined;
  if (challenge === undefined) return { socket, authenticated: false };

  await harness.app.workerChannel.handle(
    connectionId,
    workerMessage("authenticate", {
      deviceId: device.device.id,
      nonce: challenge.nonce,
      signature: signNonce(device.privateKeyPem, challenge.nonce),
      capabilities: ["filesystem.read"],
      requestId: `auth-${connectionId}-${String(sequence)}`,
      timestamp: new Date().toISOString(),
    }),
  );

  const session = socket.last(WORKER_MESSAGE.session);
  if (session === undefined) return { socket, authenticated: false };

  await harness.app.workerChannel.handle(
    connectionId,
    workerMessage("register", {
      capabilities: [
        {
          name: "filesystem.read",
          version: "1",
          description: "Lecture",
          enabled: true,
          metadata: { risk: "SAFE" },
        },
      ],
      health: { activeTasks: 0, maxConcurrentTasks: 2 },
    }),
  );

  return { socket, authenticated: true };
}

describe("authentification du canal client", () => {
  it("accepte un jeton valide et un appareil approuvé", async () => {
    const context = await harness.app.clientChannel.authenticate({
      accessToken: account.accessToken,
      deviceId: iphone.device.id,
    });

    expect(context.userId).toBe(account.userId);
    expect(context.deviceId).toBe(iphone.device.id);
  });

  it("refuse un jeton invalide", async () => {
    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: "pas.un.jeton",
        deviceId: iphone.device.id,
      }),
    ).rejects.toThrow();
  });

  it("refuse un appareil qui appartient à quelqu'un d'autre", async () => {
    // Le jeton dit *qui*, l'appareil dit *d'où*. Sans le second contrôle, un
    // jeton volé permettrait de détourner les événements d'un autre appareil.
    const autre = await createAccount(harness, "autre@exemple.fr");
    const sien = await registerDevice(harness, autre, { name: "Son iPhone", role: "CLIENT" });

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: sien.device.id,
      }),
    ).rejects.toThrow(/n'appartenant pas/);
  });

  it("refuse un appareil non approuvé", async () => {
    const attente = await registerDevice(harness, account, {
      name: "Nouveau",
      role: "CLIENT",
      trust: false,
    });

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: attente.device.id,
      }),
    ).rejects.toThrow(/non approuvé/);
  });

  it("refuse après déconnexion, même avec un jeton encore valide", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: account.authorization,
    });

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: iphone.device.id,
      }),
    ).rejects.toThrow();
  });
});

describe("messages malformés", () => {
  it("ignore une trame illisible sans fermer la connexion", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(context, { pas: "une enveloppe" });
    await harness.app.clientChannel.handle(context, "du texte");
    await harness.app.clientChannel.handle(context, null);

    expect(socket.closed).toBeUndefined();
    expect(socket.sent).toHaveLength(0);
  });

  it("ignore un type inconnu — un client plus récent ne doit pas tomber", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(context, clientMessage("client.telepathie", {}));

    expect(socket.closed).toBeUndefined();
    expect(socket.sent).toHaveLength(0);
  });

  it("répond par un accusé négatif sur une charge utile invalide", async () => {
    // Type connu, charge utile fausse : erreur de programmation ou
    // falsification. Le client doit le savoir.
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.messageSend, { texte: "mauvais champ" }, "r1"),
    );

    expect(socket.acks[0]).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
  });

  it("corrèle l'accusé à la demande", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "demande-42"),
    );

    expect(socket.ofType(SERVER_TO_CLIENT.ack)[0]?.requestId).toBe("demande-42");
  });
});

describe("demandes client", () => {
  it("liste les appareils de l'utilisateur", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.deviceList, { workersOnly: true }, "r1"),
    );

    const ack = socket.acks[0] as { ok: boolean; data: { devices: { id: string }[] } };
    expect(ack.ok).toBe(true);
    // L'iPhone est CLIENT : il n'est pas un exécutant.
    expect(ack.data.devices.map((d) => d.id)).not.toContain(iphone.device.id);
    expect(ack.data.devices.map((d) => d.id)).toContain(worker.device.id);
  });

  it("crée une conversation et impose l'appareil d'origine", async () => {
    const { socket, context } = await connectClient(laptop);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(
        CLIENT_TO_SERVER.messageSend,
        // Le client tente de se déclarer comme l'iPhone.
        { conversationId: null, text: "Bonjour", originClientDeviceId: iphone.device.id },
        "r1",
      ),
    );

    const ack = socket.acks[0] as { ok: boolean; data: { conversationId: string } };
    expect(ack.ok).toBe(true);

    const messages = await harness.services.conversations.listMessages(ack.data.conversationId, {
      limit: 10,
    });

    // C'est la connexion authentifiée qui décide, pas la charge utile.
    expect(messages.items[0]?.originClientDeviceId).toBe(laptop.device.id);
  });

  it("refuse une conversation d'un autre utilisateur", async () => {
    const autre = await createAccount(harness, "autre@exemple.fr");
    const conversation = await harness.services.conversations.create({
      userId: autre.userId,
      title: "Privé",
    });

    const { socket, context } = await connectClient(iphone);
    await harness.app.clientChannel.handle(
      context,
      clientMessage(
        CLIENT_TO_SERVER.messageSend,
        { conversationId: conversation.id, text: "intrusion" },
        "r1",
      ),
    );

    expect(socket.acks[0]?.ok).toBe(false);
  });

  it("refuse d'annuler la tâche d'un autre utilisateur", async () => {
    const autre = await createAccount(harness, "autre@exemple.fr");
    const sien = await registerDevice(harness, autre, { name: "Son iPhone", role: "CLIENT" });

    const plan = createTaskPlan({
      userId: autre.userId,
      title: "Sa tâche",
      originClientDeviceId: sien.device.id,
      correlationId: "c",
      steps: [{ description: "x", requiredCapabilities: ["filesystem.read"], tool: "t" }],
    });
    await harness.services.taskStore.save(plan);

    const { socket, context } = await connectClient(iphone);
    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.taskCancel, { taskId: plan.id, reason: "x" }, "r1"),
    );

    expect(socket.acks[0]).toMatchObject({ ok: false });
  });
});

describe("canal worker", () => {
  it("authentifie un exécutant sur un challenge signé", async () => {
    const { socket, authenticated } = await connectWorker(worker);

    expect(authenticated).toBe(true);
    expect(socket.ofType(WORKER_MESSAGE.registered)).toHaveLength(1);

    const device = await harness.services.deviceRegistry.requireDevice(worker.device.id);
    expect(device.authenticated).toBe(true);
    expect(device.status).toBe("ONLINE");
  });

  it("refuse et ferme sur une signature invalide", async () => {
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-mauvais", socket);

    await harness.app.workerChannel.handle(
      "w-mauvais",
      workerMessage("hello", {
        deviceId: worker.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string };
    await harness.app.workerChannel.handle(
      "w-mauvais",
      workerMessage("authenticate", {
        deviceId: worker.device.id,
        nonce: challenge.nonce,
        signature: "c2lnbmF0dXJlLWZhdXNzZQ",
        capabilities: [],
        requestId: "auth-faux",
        timestamp: new Date().toISOString(),
      }),
    );

    // Laisser réessayer en boucle sur la même socket transformerait le refus en
    // simple ralentissement.
    expect(socket.closed?.code).toBe(4401);
    expect(socket.ofType(WORKER_MESSAGE.session)).toHaveLength(0);
  });

  it("refuse un exécutant révoqué", async () => {
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${worker.device.id}/revoke`,
      headers: account.authorization,
    });

    const { authenticated } = await connectWorker(worker, "w-revoque");
    expect(authenticated).toBe(false);
  });

  it("refuse un exécutant non approuvé", async () => {
    const attente = await registerDevice(harness, account, {
      name: "Nouveau poste",
      role: "WORKER",
      trust: false,
    });

    const { authenticated } = await connectWorker(attente, "w-attente");
    expect(authenticated).toBe(false);
  });

  it("refuse le rejeu d'une trame d'authentification", async () => {
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-rejeu", socket);

    await harness.app.workerChannel.handle(
      "w-rejeu",
      workerMessage("hello", {
        deviceId: worker.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );
    const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string };

    const frame = workerMessage("authenticate", {
      deviceId: worker.device.id,
      nonce: challenge.nonce,
      signature: signNonce(worker.privateKeyPem, challenge.nonce),
      capabilities: [],
      requestId: "auth-unique",
      timestamp: new Date().toISOString(),
    });

    await harness.app.workerChannel.handle("w-rejeu", frame);
    expect(socket.ofType(WORKER_MESSAGE.session)).toHaveLength(1);

    // Rejeu de la même trame, sur une nouvelle socket.
    const rejeu = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-rejeu-2", rejeu);
    await harness.app.workerChannel.handle("w-rejeu-2", frame);

    expect(rejeu.closed?.code).toBe(4401);
    expect(rejeu.ofType(WORKER_MESSAGE.session)).toHaveLength(0);
  });

  it("libère l'exécutant à la fermeture du canal", async () => {
    await connectWorker(worker);
    await harness.app.workerChannel.close("w1", "socket fermée");

    const device = await harness.services.deviceRegistry.requireDevice(worker.device.id);
    expect(device.status).toBe("OFFLINE");
  });

  it("permet une reconnexion après coupure", async () => {
    await connectWorker(worker, "w-a");
    await harness.app.workerChannel.close("w-a", "coupure");

    const { authenticated } = await connectWorker(worker, "w-b");
    expect(authenticated).toBe(true);

    const device = await harness.services.deviceRegistry.requireDevice(worker.device.id);
    expect(device.status).toBe("ONLINE");
  });

  it("ignore une trame worker illisible", async () => {
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-illisible", socket);

    await harness.app.workerChannel.handle("w-illisible", { n: "importe quoi" });

    expect(socket.closed).toBeUndefined();
    expect(socket.sent).toHaveLength(0);
  });
});

describe("cloisonnement des canaux", () => {
  it("un client ne peut pas émettre une trame du canal worker", async () => {
    // Un `worker.task_result` forgé depuis un téléphone ferait croire au cœur
    // qu'une étape a réussi. Les deux canaux ont des types disjoints.
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      workerMessage("taskResult", {
        taskId: "t",
        stepId: "s",
        ok: true,
        result: null,
        error: null,
        durationMs: 1,
      }),
    );

    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toBeUndefined();
  });

  it("un exécutant ne peut pas émettre une demande client", async () => {
    const { socket } = await connectWorker(worker);
    const before = socket.sent.length;

    await harness.app.workerChannel.handle(
      "w1",
      clientMessage(CLIENT_TO_SERVER.taskCancel, { taskId: "t", reason: "x" }),
    );

    // La passerelle ignore ce qui n'est pas du canal worker.
    expect(socket.sent).toHaveLength(before);
  });
});

describe("synchronisation entre l'iPhone et le portable", () => {
  it("les deux clients reçoivent le même événement de tâche", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const laptopSocket = (await connectClient(laptop)).socket;
    await connectWorker(worker);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Lire un fichier",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Lire",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    expect(created.statusCode).toBe(202);
    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskCreated).length > 0);
    await settle(40);

    // Une tâche lancée depuis l'iPhone est visible sur le portable.
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskCreated)).toHaveLength(1);
    expect(laptopSocket.ofType(SERVER_TO_CLIENT.taskCreated)).toHaveLength(1);
  });

  it("préserve l'appareil d'origine dans tous les événements", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const laptopSocket = (await connectClient(laptop)).socket;
    await connectWorker(worker);

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Lire un fichier",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Lire",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    await until(() => laptopSocket.ofType(SERVER_TO_CLIENT.taskCreated).length > 0);

    // Le portable sait que la demande vient de l'iPhone, et peut l'afficher
    // comme telle plutôt que de la sonner.
    const onLaptop = laptopSocket.ofType(SERVER_TO_CLIENT.taskCreated)[0]?.payload as {
      originClientDeviceId: string;
    };
    const onPhone = iphoneSocket.ofType(SERVER_TO_CLIENT.taskCreated)[0]?.payload as {
      originClientDeviceId: string;
    };

    expect(onLaptop.originClientDeviceId).toBe(iphone.device.id);
    expect(onPhone.originClientDeviceId).toBe(iphone.device.id);
  });

  it("livre au retour ce qu'un client déconnecté a manqué", async () => {
    // L'iPhone est éteint pendant la tâche ; il doit converger au rallumage.
    const laptopSocket = (await connectClient(laptop)).socket;
    await connectWorker(worker);

    await harness.services.notifications.create({
      userId: account.userId,
      title: "Pendant l'absence",
      body: "quelque chose est arrivé",
      originClientDeviceId: laptop.device.id,
    });

    await until(() => laptopSocket.ofType(SERVER_TO_CLIENT.notificationCreated).length > 0);

    // L'iPhone se connecte maintenant.
    const late = await connectClient(iphone);
    await settle(20);

    expect(late.socket.ofType(SERVER_TO_CLIENT.notificationCreated)).toHaveLength(1);
  });

  it("ne diffuse rien à un exécutant pur", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    await connectWorker(worker);

    await harness.services.notifications.create({
      userId: account.userId,
      title: "Pour les clients",
      body: "x",
    });
    await settle(20);

    // Le poste fixe est WORKER : il exécute, il ne reçoit pas les notifications
    // de l'utilisateur.
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.notificationCreated)).toHaveLength(1);
    expect(harness.app.clientChannel.connectedDeviceIds).not.toContain(worker.device.id);
  });

  it("ne descend pas les événements internes d'exécutant vers les clients", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    await connectWorker(worker);
    await settle(20);

    // `worker.connected` décrit la topologie de la flotte : les clients voient
    // `device.updated`, pas le détail du canal d'exécution.
    expect(iphoneSocket.sent.map((m) => m.type)).not.toContain("worker.connected");
    expect(iphoneSocket.sent.map((m) => m.type)).toContain(SERVER_TO_CLIENT.deviceUpdated);
  });
});

describe("routage vers l'exécutant et retour", () => {
  it("achemine une étape jusqu'au worker et rend son résultat", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const workerSocket = (await connectWorker(worker)).socket;

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Lire un fichier",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Lire",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);

    const dispatch = workerSocket.last(
      WORKER_MESSAGE.taskDispatch,
    ) as WorkerPayload<"worker.task_dispatch">;
    expect(dispatch.capability).toBe("filesystem.read");

    // Le worker répond, comme il le ferait sur le fil.
    await harness.app.workerChannel.handle(
      "w1",
      workerMessage("taskResult", {
        taskId: dispatch.taskId,
        stepId: dispatch.stepId,
        ok: true,
        result: { content: "bonjour" },
        sensitiveResult: false,
        error: null,
        durationMs: 12,
      }),
    );

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted).length > 0);
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted)).toHaveLength(1);
  });

  it("échoue proprement quand aucun exécutant ne déclare la capacité", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    await connectWorker(worker);

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Commande shell",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Lancer",
            requiredCapabilities: ["terminal.execute"],
            tool: "device.terminal.execute",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskFailed).length > 0);
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskFailed)).toHaveLength(1);
  });

  it("annule une tâche depuis le canal client", async () => {
    const { context } = await connectClient(iphone);
    const workerSocket = (await connectWorker(worker)).socket;

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Lire un fichier",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Lire",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    const taskId = created.json<{ data: { id: string } }>().data.id;
    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);

    const socket = new FakeClientSocket();
    await harness.app.clientChannel.attach(context, socket);
    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.taskCancel, { taskId, reason: "changé d'avis" }, "r1"),
    );

    expect(socket.acks[0]).toMatchObject({ ok: true, data: { cancelled: true } });
  });

  it("mène deux tâches de front", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const workerSocket = (await connectWorker(worker)).socket;

    const bodies = [1, 2].map((n) => ({
      title: `Lecture ${String(n)}`,
      originClientDeviceId: iphone.device.id,
      steps: [
        {
          description: `Lire ${String(n)}`,
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE" as const,
        },
      ],
    }));

    await Promise.all(
      bodies.map((payload) =>
        harness.app.inject({
          method: "POST",
          url: "/api/v1/tasks",
          headers: account.authorization,
          payload,
        }),
      ),
    );

    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length >= 2);

    const dispatches = workerSocket
      .ofType(WORKER_MESSAGE.taskDispatch)
      .map((m) => m.payload as WorkerPayload<"worker.task_dispatch">);

    // Deux tâches distinctes, deux étapes distinctes : rien n'est confondu.
    expect(new Set(dispatches.map((d) => d.taskId)).size).toBe(2);

    for (const dispatch of dispatches) {
      await harness.app.workerChannel.handle(
        "w1",
        workerMessage("taskResult", {
          taskId: dispatch.taskId,
          stepId: dispatch.stepId,
          ok: true,
          result: null,
          sensitiveResult: false,
          error: null,
          durationMs: 5,
        }),
      );
    }

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted).length >= 2);
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted)).toHaveLength(2);
  });
});

describe("confirmations", () => {
  it("achemine la demande aux deux clients, et l'un ou l'autre peut trancher", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const laptopClient = await connectClient(laptop);
    const workerSocket = (await connectWorker(worker)).socket;

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Lecture sensible",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Lire un fichier sensible",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            // HIGH dépasse le seuil : une confirmation est exigée.
            riskLevel: "HIGH",
          },
        ],
      },
    });

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.confirmationRequired).length > 0);

    // Les deux clients l'ont reçue.
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.confirmationRequired)).toHaveLength(1);
    expect(laptopClient.socket.ofType(SERVER_TO_CLIENT.confirmationRequired)).toHaveLength(1);

    const demande = iphoneSocket.ofType(SERVER_TO_CLIENT.confirmationRequired)[0]?.payload as {
      confirmationId: string;
    };

    // La demande part de l'iPhone ; le portable l'approuve. La demande vit au
    // centre, pas dans le client qui l'a affichée.
    await harness.app.clientChannel.handle(
      laptopClient.context,
      clientMessage(
        CLIENT_TO_SERVER.confirmationRespond,
        { confirmationId: demande.confirmationId, decision: "approved" },
        "r1",
      ),
    );

    expect(laptopClient.socket.acks[0]).toMatchObject({ ok: true, data: { accepted: true } });
    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);
    expect(workerSocket.ofType(WORKER_MESSAGE.taskDispatch)).toHaveLength(1);
  });

  it("n'exécute rien si l'utilisateur refuse", async () => {
    const iphoneClient = await connectClient(iphone);
    const workerSocket = (await connectWorker(worker)).socket;

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Lecture sensible",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Lire",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "HIGH",
          },
        ],
      },
    });

    await until(() => iphoneClient.socket.ofType(SERVER_TO_CLIENT.confirmationRequired).length > 0);
    const demande = iphoneClient.socket.ofType(SERVER_TO_CLIENT.confirmationRequired)[0]
      ?.payload as { confirmationId: string };

    await harness.app.clientChannel.handle(
      iphoneClient.context,
      clientMessage(
        CLIENT_TO_SERVER.confirmationRespond,
        { confirmationId: demande.confirmationId, decision: "rejected" },
        "r1",
      ),
    );

    await settle(60);
    expect(workerSocket.ofType(WORKER_MESSAGE.taskDispatch)).toHaveLength(0);
  });

  it("une réponse en double n'est pas une erreur", async () => {
    // Deux clients peuvent répondre presque en même temps. Le second ne doit pas
    // voir un message d'échec alors que tout s'est bien passé.
    const iphoneClient = await connectClient(iphone);
    await connectWorker(worker);

    await harness.app.clientChannel.handle(
      iphoneClient.context,
      clientMessage(
        CLIENT_TO_SERVER.confirmationRespond,
        { confirmationId: "inexistante", decision: "approved" },
        "r1",
      ),
    );

    expect(iphoneClient.socket.acks[0]).toMatchObject({ ok: true, data: { accepted: false } });
  });
});
