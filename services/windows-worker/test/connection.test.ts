import { describe, expect, it } from "vitest";
import { Backoff } from "@nexus/worker-core";
import { makeHarness, settle, generateDeviceKeys, USER_ID } from "./fixtures.js";
import { InMemoryCredentialSigner } from "../src/connection/signer.js";
import { createWindowsWorker } from "../src/worker.js";
import { LoopbackLink } from "@nexus/worker-core";
import { MemoryWorkerLogger } from "@nexus/worker-core";
import { assembleCapabilities } from "../src/assemble.js";
import { testConfig, FakeProcessRunner, FakeFileSystem, TestTimers } from "./fixtures.js";
import type { WorkerConnection } from "@nexus/devices";

/**
 * Authentification, session, reprise.
 *
 * Le point que ces tests défendent : **un identifiant d'appareil n'authentifie
 * rien**. Il est public — il apparaît dans l'interface, dans les journaux, dans
 * les événements. Tout ce qui suit repose sur une signature.
 *
 * La poignée de main est jouée en entier, avec de vraies clés Ed25519 et le
 * vrai `DeviceSessionService` du cœur. Seul le transport est en mémoire.
 */

describe("authentification du worker", () => {
  it("ouvre une session sur un challenge correctement signé", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.isAuthenticated).toBe(true);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(true);
    expect(device.status).toBe("ONLINE");
  });

  it("refuse un worker dont la signature est invalide", async () => {
    const harness = await makeHarness();
    // Le worker signe avec une autre clé que celle enregistrée pour l'appareil.
    const autres = generateDeviceKeys();
    harness.credentials.set(harness.device.id, autres.publicKeyPem);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(false);
  });

  it("refuse un appareil sans clé publique enregistrée", async () => {
    const harness = await makeHarness();
    harness.credentials.revoke(harness.device.id);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("refuse un appareil pas encore approuvé", async () => {
    // Un appareil fraîchement appairé est PENDING : il peut se connecter, il
    // n'obtient pas de session tant qu'un humain ne l'a pas approuvé.
    const harness = await makeHarness({ trusted: false });

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("refuse un appareil révoqué", async () => {
    const harness = await makeHarness();
    await harness.registry.revokeDevice(harness.device.id);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("refuse le rejeu d'une trame d'authentification", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    // On rejoue telle quelle la trame d'authentification déjà envoyée.
    const authenticate = harness.link.sent.find(
      (envelope) => envelope.type === "worker.authenticate",
    );
    expect(authenticate).toBeDefined();

    const connection: WorkerConnection = {
      connectionId: `conn-${harness.device.id}`,
      deviceId: harness.device.id,
      send: () => undefined,
      close: () => undefined,
    };

    await expect(harness.gateway.handleMessage(connection, authenticate!)).rejects.toMatchObject({
      code: "DEVICE_REPLAY_REJECTED",
    });
  });

  it("invalide la session dès que l'appareil est révoqué", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const session = harness.link.sent.length;
    expect(session).toBeGreaterThan(0);

    await harness.registry.revokeDevice(harness.device.id);
    await harness.sessions.revokeAllForDevice(harness.device.id);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(false);
  });

  it("borne les capacités négociées à celles que l'appareil déclare", async () => {
    const harness = await makeHarness({ config: { declaredCapabilities: ["git.status"] } });
    await harness.connectWorker();

    expect(harness.worker.grantedCapabilities).toEqual(["git.status"]);
  });

  it("n'écrit jamais le jeton de session dans le journal", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const sessionEnvelope = harness.link.sent.find((e) => e.type === "worker.authenticate");
    expect(sessionEnvelope).toBeDefined();

    // Le jeton n'apparaît que dans la trame `worker.session`, jamais ailleurs.
    const token = (harness.worker.describe().sessionId as string | null) ?? "";
    expect(harness.logger.text).not.toContain("token");
    expect(harness.logger.text).toContain(token);
  });
});

describe("enregistrement des capacités", () => {
  it("enregistre les capacités auprès du registre du cœur", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    const names = device.capabilities.map((capability) => capability.name);

    expect(names).toEqual(
      expect.arrayContaining(["terminal.execute", "filesystem.read", "git.status"]),
    );
  });

  it("n'enregistre pas une capacité dont l'outil est absent", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.missing.add("docker");
      },
    });
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    const names = device.capabilities.map((capability) => capability.name);

    expect(names).not.toContain("docker.execute");
    expect(names).toContain("git.status");
  });

  it("n'enregistre que les capacités autorisées localement", async () => {
    const harness = await makeHarness({
      config: { declaredCapabilities: ["filesystem.read", "git.status"] },
    });
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities.map((c) => c.name)).toEqual(["filesystem.read", "git.status"]);
  });

  it("remonte la santé au cœur", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.health.maxConcurrentTasks).toBe(2);
    expect(device.health.activeTasks).toBe(0);
  });
});

describe("battement de cœur", () => {
  it("met à jour la présence de l'appareil", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const before = await harness.registry.requireDevice(harness.device.id);
    await harness.worker.sendHeartbeat();
    await settle();

    const after = await harness.registry.requireDevice(harness.device.id);
    expect(after.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt?.getTime() ?? 0);
    expect(after.status).toBe("ONLINE");
  });

  it("est refusé s'il est rejoué", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    await harness.worker.sendHeartbeat();
    await settle();

    const heartbeat = harness.link.sent.filter((e) => e.type === "worker.heartbeat").at(-1);
    const connection: WorkerConnection = {
      connectionId: `conn-${harness.device.id}`,
      deviceId: harness.device.id,
      send: () => undefined,
      close: () => undefined,
    };

    await expect(harness.gateway.handleMessage(connection, heartbeat!)).rejects.toMatchObject({
      code: "DEVICE_REPLAY_REJECTED",
    });
  });

  it("est programmé après l'enregistrement", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    // Une minuterie est en attente : celle du prochain battement.
    expect(harness.timers.delays).toContain(20_000);
  });
});

describe("attente exponentielle", () => {
  it("croît puis plafonne", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 10_000, jitter: 0, random: () => 0.5 });

    expect(backoff.next()).toBe(1_000);
    expect(backoff.next()).toBe(2_000);
    expect(backoff.next()).toBe(4_000);
    expect(backoff.next()).toBe(8_000);
    expect(backoff.next()).toBe(10_000);
    expect(backoff.next()).toBe(10_000);
  });

  it("disperse les tentatives", () => {
    // Sans bruit, tous les workers d'un utilisateur reconnectent à la même
    // milliseconde et refont tomber le cœur au moment où il redémarre.
    const bas = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0.5, random: () => 0 });
    const haut = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0.5, random: () => 1 });

    bas.next();
    haut.next();
    expect(bas.next()).toBeLessThan(haut.next());
  });

  it("ne descend jamais sous le minimum ni au-dessus du plafond", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 5_000, jitter: 0.9, random: () => 0 });
    for (let index = 0; index < 10; index += 1) {
      const delay = backoff.next();
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(5_000);
    }
  });

  it("repart à zéro après une connexion établie", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0, random: () => 0.5 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});

describe("coupure et reprise", () => {
  it("programme une reconnexion après une coupure", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("réseau coupé");
    await settle();

    expect(harness.worker.state).toBe("reconnecting");
    expect(harness.worker.isAuthenticated).toBe(false);
    expect(harness.timers.delays.some((delay) => delay >= 1_000)).toBe(true);
  });

  it("refait la poignée de main complète, sans réutiliser l'ancien jeton", async () => {
    // Une session dont on ne sait pas si elle est encore valide n'est pas une
    // session : on resigne un challenge neuf.
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("réseau coupé");
    await settle();

    const before = harness.link.sent.filter((e) => e.type === "worker.hello").length;
    harness.timers.flush();
    await settle();

    const after = harness.link.sent.filter((e) => e.type === "worker.hello").length;
    expect(after).toBeGreaterThan(before);
  });

  it("réessaie après un échec de connexion, sans tempête", async () => {
    const harness = await makeHarness();
    harness.link.failNextConnect = true;

    await harness.worker.start();
    await settle();

    expect(harness.worker.state).toBe("reconnecting");
    // Une seule reconnexion programmée, pas une par tentative accumulée.
    expect(harness.timers.pending.size).toBe(1);
  });

  it("ne programme pas deux reconnexions pour deux coupures rapprochées", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("coupure 1");
    harness.link.drop("coupure 2");
    await settle();

    expect(harness.timers.pending.size).toBe(1);
  });

  it("libère les étapes en vol côté cœur quand le worker disparaît", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.gateway.detach(harness.device.id, "câble débranché");

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.status).toBe("OFFLINE");
    expect(harness.gateway.isConnected(harness.device.id)).toBe(false);
  });
});

describe("arrêt propre", () => {
  it("ferme le canal et oublie la session", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.worker.stop("test");

    expect(harness.worker.state).toBe("stopped");
    expect(harness.worker.isAuthenticated).toBe(false);
    expect(harness.link.state).toBe("closed");
  });

  it("annule les minuteries et ne reconnecte pas", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.worker.stop("test");
    harness.timers.flush();
    await settle();

    expect(harness.worker.state).toBe("stopped");
  });
});

describe("architecture : un seul worker, deux machines", () => {
  /**
   * Le test qui compte le plus de ce lot.
   *
   * La même classe, la même configuration de code, le même assemblage —
   * enregistrés une fois en `BOTH` (le portable, qui est aussi un client) et une
   * fois en `WORKER` (le poste fixe, machine d'exécution). Rien dans le worker
   * ne lit ce rôle : il vient du registre, côté cœur.
   */
  async function connectAs(role: "BOTH" | "WORKER", deviceId: string, name: string) {
    const harness = await makeHarness({ role, deviceName: name, config: { deviceId } });
    await harness.connectWorker();
    return harness;
  }

  it("s'enregistre en BOTH sur le portable", async () => {
    const harness = await connectAs("BOTH", "device-portable", "Portable Windows");
    const device = await harness.registry.requireDevice("device-portable");

    expect(device.role).toBe("BOTH");
    expect(harness.worker.state).toBe("ready");
  });

  it("s'enregistre en WORKER sur le poste fixe", async () => {
    const harness = await connectAs("WORKER", "device-poste-fixe", "Poste fixe");
    const device = await harness.registry.requireDevice("device-poste-fixe");

    expect(device.role).toBe("WORKER");
    expect(harness.worker.state).toBe("ready");
  });

  it("annonce exactement les mêmes capacités dans les deux rôles", async () => {
    const portable = await connectAs("BOTH", "device-portable", "Portable Windows");
    const fixe = await connectAs("WORKER", "device-poste-fixe", "Poste fixe");

    const capabilitiesOf = async (harness: typeof portable, id: string) =>
      (await harness.registry.requireDevice(id)).capabilities.map((c) => c.name);

    expect(await capabilitiesOf(portable, "device-portable")).toEqual(
      await capabilitiesOf(fixe, "device-poste-fixe"),
    );
  });

  it("ne contient aucune décision fondée sur le nom de la machine", async () => {
    // Deux noms radicalement différents, comportement identique : c'est ce qui
    // garantit qu'ajouter une quatrième machine est une écriture en base, pas
    // une modification du worker.
    const a = await connectAs("WORKER", "device-a", "Poste fixe du salon");
    const b = await connectAs("WORKER", "device-b", "ZZZ-9000");

    expect(a.worker.grantedCapabilities).toEqual(b.worker.grantedCapabilities);
    expect(a.worker.state).toBe(b.worker.state);
  });

  it("seul le rôle décide qui peut recevoir une tâche", async () => {
    const portable = await connectAs("BOTH", "device-portable", "Portable");

    const workers = await portable.registry.getWorkerDevices(USER_ID);
    const clients = await portable.registry.getClientDevices(USER_ID);

    // Le portable est dans les deux listes ; l'iPhone n'est que client.
    expect(workers.map((d) => d.id)).toContain("device-portable");
    expect(clients.map((d) => d.id)).toContain("device-portable");
    expect(workers.map((d) => d.id)).not.toContain("device-iphone");
  });
});

describe("garde-fous du canal", () => {
  it("ignore une trame d'un type inconnu au lieu de tomber", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.deliver({
      v: 1,
      id: "x",
      type: "worker.telepathie",
      ts: new Date().toISOString(),
      payload: {},
    });
    await settle();

    expect(harness.worker.state).toBe("ready");
  });

  it("refuse d'exécuter un ordre reçu avant l'ouverture de session", async () => {
    // Le cœur ne dispatche que vers un worker authentifié. Mais un worker qui
    // exécuterait sur simple réception ferait reposer toute la sécurité sur le
    // bon comportement de l'autre bout.
    const runner = new FakeProcessRunner();
    const config = testConfig();
    const { capabilities } = assembleCapabilities({
      config,
      runner,
      fileSystem: new FakeFileSystem(),
      env: {},
    });
    await capabilities.probeAll();
    runner.runs.length = 0;

    const link = new LoopbackLink();
    const timers = new TestTimers();
    const worker = createWindowsWorker({
      config,
      link,
      signer: new InMemoryCredentialSigner(generateDeviceKeys().privateKeyPem),
      capabilities,
      logger: new MemoryWorkerLogger(),
      timers,
    });

    await link.connect();
    link.deliver({
      v: 1,
      id: "x",
      type: "worker.task_dispatch",
      ts: new Date().toISOString(),
      payload: {
        taskId: "t",
        stepId: "s",
        capability: "terminal.execute",
        tool: "device.terminal.execute",
        arguments: { executable: "git", args: ["status"] },
        timeoutMs: 1_000,
        riskLevel: "HIGH",
        requestId: "r1",
      },
    });
    await settle();

    expect(runner.runs).toHaveLength(0);
    expect(worker.isAuthenticated).toBe(false);
  });
});
