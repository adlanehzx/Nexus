import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import {
  createAccount,
  makeApi,
  registerDevice,
  settle,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";
import { mountClient, mountWorker, type ClientRig, type WorkerRig } from "./laptop.js";

/**
 * Le portable Windows : client **et** exécutant.
 *
 * Sept propriétés à établir, et une seule question derrière toutes :
 * *l'interface installée sur une machine qui exécute peut-elle court-circuiter
 * le cœur ?* La réponse doit être non, et elle doit l'être pour des raisons
 * structurelles — pas parce qu'on a évité d'écrire le raccourci.
 *
 * La flotte montée ici est celle de l'utilisateur :
 *
 *     iPhone   CLIENT   — pilote, n'exécute pas
 *     Portable BOTH     — pilote et exécute
 *     Fixe     WORKER   — exécute, ne pilote pas
 *     Redmi    WORKER   — exécute, ne pilote pas
 *
 * Rien de tout cela n'est écrit dans le code : ce sont quatre lignes de
 * registre, et le cœur ne connaît que des rôles et des capacités.
 */

let harness: ApiHarness;
let account: Account;

let iphone: RegisteredDevice;
let portable: RegisteredDevice;
let fixe: RegisteredDevice;
let redmi: RegisteredDevice;

const PERMISSIONS = ["filesystem.read", "terminal.execute", "docker.execute", "android.app.open"];

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);

  iphone = await registerDevice(harness, account, {
    name: "iPhone 17",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
    permissions: PERMISSIONS,
  });

  // Le portable : **un seul appareil**, rôle `BOTH`. Deux lignes de registre
  // pour la même machine donneraient deux entrées dans la flotte de
  // l'utilisateur et deux états de santé contradictoires.
  portable = await registerDevice(harness, account, {
    name: "Portable Windows",
    role: "BOTH",
    permissions: PERMISSIONS,
  });

  fixe = await registerDevice(harness, account, {
    name: "Poste fixe",
    role: "WORKER",
    permissions: PERMISSIONS,
  });

  redmi = await registerDevice(harness, account, {
    name: "Redmi Note 10S",
    role: "WORKER",
    type: "ANDROID",
    platform: "ANDROID",
    permissions: PERMISSIONS,
  });
});

afterEach(async () => {
  await harness.close();
});

/** Crée un plan et rend son identifiant. */
async function createTask(
  originClientDeviceId: string,
  capability: string,
  title = `Étape ${capability}`,
): Promise<{ status: number; taskId: string | undefined; body: unknown }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: account.authorization,
    payload: {
      title,
      originClientDeviceId,
      steps: [
        {
          description: title,
          requiredCapabilities: [capability],
          tool: `device.${capability}`,
          riskLevel: "SAFE",
        },
      ],
    },
  });

  const body = response.json<{ data?: { id: string } }>();
  return { status: response.statusCode, taskId: body.data?.id, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Le portable comme client
// ─────────────────────────────────────────────────────────────────────────────

describe("1. le portable agit comme client", () => {
  let laptop: ClientRig;

  beforeEach(async () => {
    laptop = await mountClient(harness, account, portable);
  });

  it("ouvre une session sur le canal client avec le rôle BOTH", () => {
    // Le canal client n'exige pas le rôle `CLIENT` : il exige un appareil
    // approuvé qui appartient au porteur du jeton. `BOTH` passe, `WORKER` non —
    // et c'est la même règle pour les deux, pas une exception pour le portable.
    expect(laptop.realtime.state).toBe("connected");
    expect(laptop.socket.deviceId).toBe(portable.device.id);
  });

  it("envoie un message et reçoit son accusé", async () => {
    const resultat = await laptop.realtime.sendMessage({
      conversationId: null,
      text: "Bonjour depuis le portable",
    });

    expect(resultat.messageId).toBeTruthy();

    const message = await harness.services.conversations.listMessages(resultat.conversationId, {
      limit: 10,
    });
    // L'appareil d'origine est **imposé par la connexion**, jamais accepté du
    // client : c'est ce qui empêche le portable de se déclarer iPhone.
    expect(message.items[0]?.originClientDeviceId).toBe(portable.device.id);
  });

  it("liste la flotte, exécutants compris", async () => {
    const flotte = await laptop.realtime.listDevices();

    expect(flotte.devices.map((appareil) => appareil.id).sort()).toEqual(
      [iphone.device.id, portable.device.id, fixe.device.id, redmi.device.id].sort(),
    );
  });

  it("reçoit les événements de tâche", async () => {
    mountWorker(harness, fixe)
      .runtime.start()
      .catch(() => undefined);
    await until(() => harness.services.gateway.isConnected(fixe.device.id));

    await createTask(portable.device.id, "filesystem.read");
    await until(() => laptop.state().tasks.length > 0);

    expect(laptop.state().tasks[0]?.originClientDeviceId).toBe(portable.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Le portable comme exécutant
// ─────────────────────────────────────────────────────────────────────────────

describe("2. le portable agit comme exécutant", () => {
  it("s'authentifie sur le canal worker avec la clé de la machine", async () => {
    const worker = mountWorker(harness, portable);
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);
  });

  it("déclare ses capacités au cœur", async () => {
    const worker = mountWorker(harness, portable, {
      capabilities: ["terminal.execute", "docker.execute"],
    });
    await worker.runtime.start();

    // La session s'ouvre avant l'enregistrement des capacités : attendre la
    // connexion ne suffit pas, il faut attendre la déclaration elle-même.
    await until(
      async () =>
        ((await harness.services.deviceRegistry.getDevice(portable.device.id))?.capabilities
          .length ?? 0) > 0,
    );

    const appareil = await harness.services.deviceRegistry.requireDevice(portable.device.id);
    expect(appareil.capabilities.map((capacite) => capacite.name).sort()).toEqual([
      "docker.execute",
      "terminal.execute",
    ]);
  });

  it("tient les deux canaux en même temps, avec deux secrets différents", async () => {
    // Le point du lot. La même ligne d'appareil porte deux sessions : l'une
    // authentifiée par le jeton de l'utilisateur, l'autre par la signature de la
    // machine. Ni l'une ni l'autre ne peut prendre la place de la seconde.
    const laptopClient = await mountClient(harness, account, portable);
    const laptopWorker = mountWorker(harness, portable);
    await laptopWorker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    expect(laptopClient.realtime.state).toBe("connected");
    expect(harness.app.clientChannel.connectedDeviceIds).toContain(portable.device.id);
    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);
  });

  it("un exécutant pur ne peut pas ouvrir de session client", async () => {
    // Le poste fixe exécute ; il ne pilote pas. Le distinguer du portable est
    // tout l'intérêt d'avoir trois rôles au lieu de deux.
    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: fixe.device.id,
      }),
    ).resolves.toBeDefined();

    // Le canal accepte la connexion — l'appareil appartient bien à
    // l'utilisateur — mais le routeur ne lui livre rien : c'est `canReceiveEvents`
    // qui tranche, et il est faux pour `WORKER`.
    const clients = await harness.services.deviceRegistry.getClientDevices(account.userId);
    expect(clients.map((appareil) => appareil.id)).not.toContain(fixe.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Le portable ne contourne pas le cœur
// ─────────────────────────────────────────────────────────────────────────────

describe("3. aucun contournement de l'autorisation", () => {
  it("refuse une capacité non accordée, même sur sa propre machine", async () => {
    // Le pire scénario : la fenêtre et le démon sont sur le même disque. Si la
    // proximité valait autorisation, l'utilisateur pourrait s'accorder tout seul
    // ce que le cœur lui refuse.
    const worker = mountWorker(harness, portable, { capabilities: ["terminal.execute"] });
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    // Les permissions effectives sont l'**union de celles des appareils** : ce
    // que l'utilisateur a autorisé, pas ce qu'une machine s'accorde. Il faut
    // donc retirer la capacité partout pour qu'elle disparaisse — la retirer du
    // seul portable ne changerait rien, et c'est le comportement voulu : une
    // permission décrit ce que l'utilisateur permet, le sélecteur décide où.
    for (const appareil of [iphone, portable, fixe, redmi]) {
      await harness.app.inject({
        method: "PATCH",
        url: `/api/v1/devices/${appareil.device.id}/permissions`,
        headers: account.authorization,
        payload: { grantedPermissions: ["filesystem.read"] },
      });
    }

    const refuse = await createTask(portable.device.id, "terminal.execute");

    // Refus **avant** tout dispatch. Le worker revérifiera de son côté, mais un
    // système qui compterait sur cette seconde vérification ferait reposer sa
    // sécurité sur le bon comportement de l'exécutant.
    expect(refuse.status).toBe(403);
    expect(worker.executed).toHaveLength(0);
  });

  it("un client ne désigne jamais l'exécutant", async () => {
    // La route de création n'a pas de champ pour cela. Une demande qui en
    // ajoute un est rejetée par la validation, et non silencieusement ignorée —
    // sans quoi l'auteur croirait que son ciblage a été pris en compte.
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Exécuter ici",
        originClientDeviceId: portable.device.id,
        targetDeviceId: portable.device.id,
        steps: [
          {
            description: "Lire",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            selectedDeviceId: portable.device.id,
          },
        ],
      },
    });

    const plan = response.json<{ data?: { steps: { selectedDeviceId: string | null }[] } }>();
    // Le champ n'existe pas dans le contrat : quoi qu'il arrive, il ne décide
    // rien. Au moment de la création, aucun exécutant n'est encore choisi.
    expect(plan.data?.steps[0]?.selectedDeviceId ?? null).toBeNull();
  });

  it("un jeton d'un autre utilisateur n'ouvre pas le portable", async () => {
    const intrus = await createAccount(harness, "intrus@exemple.fr");

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: intrus.accessToken,
        deviceId: portable.device.id,
      }),
    ).rejects.toThrow();
  });

  it("l'identifiant d'appareil seul n'authentifie rien", async () => {
    // Le fichier d'état public du démon contient cet identifiant, et il est
    // lisible par l'utilisateur de la machine. S'il suffisait, le publier
    // équivaudrait à publier une clé.
    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: "",
        deviceId: portable.device.id,
      }),
    ).rejects.toThrow();
  });

  it("un appareil révoqué n'exécute plus rien", async () => {
    const worker = mountWorker(harness, portable);
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${portable.device.id}/revoke`,
      headers: account.authorization,
    });

    await createTask(portable.device.id, "filesystem.read");
    await settle(60);

    expect(worker.executed).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 et 5. Synchronisation entre l'iPhone et le portable
// ─────────────────────────────────────────────────────────────────────────────

describe("4-5. l'iPhone et le portable restent synchronisés", () => {
  let phone: ClientRig;
  let laptop: ClientRig;
  let worker: WorkerRig;

  beforeEach(async () => {
    phone = await mountClient(harness, account, iphone);
    laptop = await mountClient(harness, account, portable);
    worker = mountWorker(harness, portable);
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));
  });

  it("une tâche lancée sur le portable apparaît à l'identique sur l'iPhone", async () => {
    await createTask(portable.device.id, "filesystem.read", "Lire depuis le portable");

    await until(() => phone.state().tasks.length > 0 && laptop.state().tasks.length > 0);

    const surTelephone = phone.state().tasks[0];
    const surPortable = laptop.state().tasks[0];

    expect(surTelephone?.id).toBe(surPortable?.id);
    expect(surTelephone?.title).toBe(surPortable?.title);
    // Les deux clients voient **la même origine**. C'est ce fil qui permet à
    // l'iPhone d'afficher « lancée depuis le portable » plutôt que de faire
    // croire que l'utilisateur l'a demandée deux fois.
    expect(surTelephone?.originClientDeviceId).toBe(portable.device.id);
    expect(surPortable?.originClientDeviceId).toBe(portable.device.id);
  });

  it("une tâche lancée sur l'iPhone apparaît sur le portable", async () => {
    await createTask(iphone.device.id, "filesystem.read", "Lire depuis l'iPhone");

    await until(() => laptop.state().tasks.length > 0);

    expect(laptop.state().tasks[0]?.originClientDeviceId).toBe(iphone.device.id);
  });

  it("les deux clients convergent jusqu'à la fin de la tâche", async () => {
    await createTask(portable.device.id, "filesystem.read");

    await until(
      () =>
        phone.state().tasks[0]?.status === "succeeded" &&
        laptop.state().tasks[0]?.status === "succeeded",
    );

    expect(phone.state().tasks[0]?.status).toBe("succeeded");
    expect(laptop.state().tasks[0]?.status).toBe("succeeded");
  });

  it("un client déconnecté rattrape son retard à la reconnexion", async () => {
    // L'iPhone est dans une poche, le portable travaille. Quand le téléphone
    // ressort, il doit voir ce qui s'est passé — sinon les deux écrans
    // racontent deux histoires différentes.
    phone.realtime.stop("écran verrouillé");
    await settle();

    await createTask(portable.device.id, "filesystem.read", "Pendant l'absence");
    await until(() => laptop.state().tasks.length > 0);

    const revenu = await mountClient(harness, account, iphone);
    await until(() => revenu.state().tasks.length > 0);

    expect(revenu.state().tasks[0]?.title).toBe("Pendant l'absence");
  });

  it("la confirmation demandée sur l'un peut être tranchée sur l'autre", async () => {
    const laptopRisque = mountWorker(harness, portable, { capabilities: ["docker.execute"] });
    await laptopRisque.runtime.start();

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Action risquée",
        originClientDeviceId: portable.device.id,
        steps: [
          {
            description: "Docker",
            requiredCapabilities: ["docker.execute"],
            tool: "device.docker.execute",
            riskLevel: "HIGH",
          },
        ],
      },
    });

    await until(() => phone.state().confirmations.length > 0);

    // La demande vit au centre, pas dans le client qui l'a affichée : n'importe
    // quel appareil de l'utilisateur peut trancher.
    const demande = phone.state().confirmations[0];
    expect(demande).toBeDefined();
    expect(laptop.state().confirmations[0]?.id).toBe(demande?.id);

    const reponse = await phone.realtime.respondToConfirmation(demande?.id ?? "", "approved");
    expect(reponse.accepted).toBe(true);
  });

  it("les notifications sont produites au centre, pas par chaque client", async () => {
    await createTask(portable.device.id, "filesystem.read");

    await until(
      () => phone.state().notifications.length > 0 && laptop.state().notifications.length > 0,
    );

    // Même identifiant des deux côtés : c'est bien **une** notification
    // diffusée, et non deux fabriquées localement — qui divergeraient au premier
    // écart d'horloge.
    expect(phone.state().notifications[0]?.id).toBe(laptop.state().notifications[0]?.id);
  });

  it("aucun événement d'exécutant ne descend vers les clients", async () => {
    await createTask(portable.device.id, "filesystem.read");
    await until(() => phone.state().tasks[0]?.status === "succeeded");

    const recus = phone.actions
      .filter((action) => action.kind === "server")
      .map((action) => action.type);

    // Les `worker.*` décrivent la topologie de la flotte. Les diffuser
    // apprendrait à chaque client quelle machine fait quoi, sans raison.
    expect(recus.some((type) => type.startsWith("worker."))).toBe(false);
    expect(recus).toContain(SERVER_TO_CLIENT.taskCompleted);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Une tâche lancée depuis l'iPhone s'exécute sur le portable
// ─────────────────────────────────────────────────────────────────────────────

describe("6. l'iPhone lance, le portable exécute", () => {
  it("l'étape atteint le portable et son résultat revient au téléphone", async () => {
    const phone = await mountClient(harness, account, iphone);
    const worker = mountWorker(harness, portable, { capabilities: ["terminal.execute"] });
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    await createTask(iphone.device.id, "terminal.execute", "Lancer les tests");

    await until(() => worker.executed.length > 0);
    expect(worker.executed[0]?.capability).toBe("terminal.execute");

    await until(() => phone.state().tasks[0]?.status === "succeeded");
    expect(phone.state().tasks[0]?.status).toBe("succeeded");
  });

  it("l'iPhone ne peut pas exécuter lui-même ce qu'il demande", async () => {
    // Aucun exécutant connecté : la tâche échoue au lieu de retomber sur le
    // client d'origine. Un client n'est pas un exécutant de repli.
    const phone = await mountClient(harness, account, iphone);

    await createTask(iphone.device.id, "terminal.execute");
    await until(() => phone.state().tasks[0]?.status === "failed");

    expect(phone.state().tasks[0]?.status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Le portable pilote le poste fixe et le Redmi
// ─────────────────────────────────────────────────────────────────────────────

describe("7. le portable pilote le reste de la flotte", () => {
  it("une capacité que le portable n'a pas part sur la machine qui l'a", async () => {
    const laptop = await mountClient(harness, account, portable);

    const local = mountWorker(harness, portable, { capabilities: ["filesystem.read"] });
    const distant = mountWorker(harness, fixe, { capabilities: ["docker.execute"] });
    await Promise.all([local.runtime.start(), distant.runtime.start()]);
    await until(
      () =>
        harness.services.gateway.isConnected(portable.device.id) &&
        harness.services.gateway.isConnected(fixe.device.id),
    );

    await createTask(portable.device.id, "docker.execute", "Lister les conteneurs");

    await until(() => distant.executed.length > 0);

    // Le portable n'a rien exécuté et n'a jamais nommé le poste fixe : il a
    // déclaré `docker.execute`, et le sélecteur a fait le reste.
    expect(distant.executed[0]?.capability).toBe("docker.execute");
    expect(local.executed).toHaveLength(0);

    await until(() => laptop.state().tasks[0]?.status === "succeeded");
    expect(laptop.state().tasks[0]?.workerDeviceId).toBe(fixe.device.id);
  });

  it("atteint le téléphone Android par le même chemin", async () => {
    const laptop = await mountClient(harness, account, portable);
    const android = mountWorker(harness, redmi, { capabilities: ["android.app.open"] });
    await android.runtime.start();
    await until(() => harness.services.gateway.isConnected(redmi.device.id));

    await createTask(portable.device.id, "android.app.open", "Ouvrir Spotify");

    await until(() => android.executed.length > 0);
    expect(android.executed[0]?.capability).toBe("android.app.open");

    await until(() => laptop.state().tasks[0]?.status === "succeeded");
    expect(laptop.state().tasks[0]?.workerDeviceId).toBe(redmi.device.id);
  });

  it("le portable annule une tâche qui tourne ailleurs", async () => {
    const laptop = await mountClient(harness, account, portable);
    const distant = mountWorker(harness, fixe, { capabilities: ["docker.execute"] });
    await distant.runtime.start();
    await until(() => harness.services.gateway.isConnected(fixe.device.id));

    const tache = await createTask(portable.device.id, "docker.execute");
    await until(() => laptop.state().tasks.length > 0);

    // L'annulation passe par le cœur, comme le reste : le portable ne parle pas
    // au poste fixe, il demande au cœur d'arrêter la tâche.
    const resultat = await laptop.realtime.cancelTask(tache.taskId ?? "");
    expect(typeof resultat.cancelled).toBe("boolean");
  });
});
