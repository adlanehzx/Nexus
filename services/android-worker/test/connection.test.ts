import { describe, expect, it } from "vitest";
import type { WorkerConnection } from "@nexus/devices";
import { makeHarness, settle, until, generateDeviceKeys, USER_ID } from "./fixtures.js";

/**
 * Authentification, session, reprise — côté Android.
 *
 * L'objectif de ce fichier n'est pas de re-tester le runtime commun : le worker
 * Windows le fait déjà. Il est de vérifier que **le même mécanisme fonctionne
 * avec une clé ECDSA P-256**, celle que le magasin de clés d'Android sait
 * produire, et que le téléphone se comporte comme un exécutant ordinaire.
 *
 * Un identifiant d'appareil n'authentifie rien. Tout repose sur une signature.
 */

describe("authentification du worker Android", () => {
  it("ouvre une session sur un challenge signé en P-256", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.isAuthenticated).toBe(true);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(true);
    expect(device.status).toBe("ONLINE");
  });

  it("refuse une signature produite par une autre clé", async () => {
    const harness = await makeHarness();
    harness.credentials.set(harness.device.id, generateDeviceKeys().publicKeyPem);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("refuse un appareil sans clé publique enregistrée", async () => {
    const harness = await makeHarness();
    harness.credentials.revoke(harness.device.id);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("refuse un appareil pas encore approuvé", async () => {
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

    const authenticate = harness.link.sent.find((e) => e.type === "worker.authenticate");
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

  it("invalide la session dès la révocation de l'appareil", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.registry.revokeDevice(harness.device.id);
    await harness.sessions.revokeAllForDevice(harness.device.id);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(false);
  });

  it("n'écrit jamais le jeton de session dans le journal", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.logger.text).not.toMatch(/"token"/);
  });
});

describe("enregistrement des capacités", () => {
  it("enregistre les capacités Android auprès du registre du cœur", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities.map((c) => c.name)).toEqual([
      "android.app.list",
      "android.app.open",
      "android.notification",
      "android.ui.click",
      "android.ui.input",
      "android.ui.screenshot",
      "android.ui.scroll",
    ]);
  });

  it("n'enregistre pas les capacités d'interface sans service d'accessibilité", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.ui.accessibilityEnabled = false;
      },
    });
    await harness.connectWorker();

    const names = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(names).not.toContain("android.ui.click");
    expect(names).toContain("android.notification");
  });

  it("remonte l'état de la batterie au cœur", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.device.battery = { percent: 42, charging: false, powerSaveMode: false };
      },
    });
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.health.batteryPercent).toBe(42);
    expect(device.health.onBattery).toBe(true);
  });
});

describe("changement de disponibilité en cours de route", () => {
  it("réannonce les capacités quand l'accessibilité est désactivée", async () => {
    // Le scénario que la liste de vérification physique rejoue à la main : on
    // coupe le service d'accessibilité, les trois capacités d'interface doivent
    // disparaître du registre sans redémarrer le worker.
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    harness.platform.ui.accessibilityEnabled = false;
    await harness.worker.availability.check();
    await until(() =>
      harness.clientEvents.some((event) => event.type === "device.capabilities_changed"),
    );

    const names = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(names).not.toContain("android.ui.click");
    expect(names).not.toContain("android.ui.input");
    expect(names).not.toContain("android.ui.scroll");
  });

  it("prévient les clients par l'événement existant", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    harness.platform.screenshots.available = false;
    await harness.worker.availability.check();
    await until(() =>
      harness.clientEvents.some((event) => event.type === "device.capabilities_changed"),
    );

    // Le dernier : le premier est l'annonce initiale, qui contenait encore la
    // capture. C'est la mise à jour qui doit ne plus la mentionner.
    const changed = harness.clientEvents
      .filter((event) => event.type === "device.capabilities_changed")
      .at(-1);

    expect(changed).toBeDefined();
    expect(JSON.stringify(changed)).not.toContain("android.ui.screenshot");
  });

  it("fait revenir les capacités quand le service est réactivé", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.platform.ui.accessibilityEnabled = false;
    await harness.worker.availability.check();
    await settle(40);

    const during = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(during).not.toContain("android.ui.click");

    harness.platform.ui.accessibilityEnabled = true;
    await harness.worker.availability.check();
    await settle(40);

    const names = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(names).toContain("android.ui.click");
  });

  it("ne produit aucun événement quand rien ne change", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    await settle(40);
    const before = harness.clientEvents.filter(
      (event) => event.type === "device.capabilities_changed",
    ).length;

    await harness.worker.availability.check();
    await harness.worker.availability.check();
    await settle(40);

    expect(
      harness.clientEvents.filter((event) => event.type === "device.capabilities_changed").length,
    ).toBe(before);
  });
});

describe("coupure et reprise", () => {
  it("programme une reconnexion après une coupure", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("réseau mobile perdu");
    await settle();

    expect(harness.worker.state).toBe("reconnecting");
    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("refait la poignée de main complète, sans réutiliser l'ancien jeton", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("réseau mobile perdu");
    await settle();

    const before = harness.link.sent.filter((e) => e.type === "worker.hello").length;
    harness.timers.flush();
    await settle();

    expect(harness.link.sent.filter((e) => e.type === "worker.hello").length).toBeGreaterThan(
      before,
    );
  });

  it("libère les étapes en vol côté cœur", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.gateway.detach(harness.device.id, "téléphone hors de portée");

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.status).toBe("OFFLINE");
  });

  it("s'arrête proprement et cesse de surveiller la disponibilité", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const pendingBefore = harness.timers.pending.size;
    await harness.worker.stop("test");
    harness.timers.flush();
    await settle();

    expect(harness.worker.state).toBe("stopped");
    expect(harness.worker.isAuthenticated).toBe(false);
    expect(pendingBefore).toBeGreaterThan(0);
  });
});

describe("rôle de l'appareil", () => {
  it("le téléphone est un exécutant, jamais un client", async () => {
    // Le Redmi n'est pas une interface NEXUS : l'iPhone et le portable le sont.
    const harness = await makeHarness();
    await harness.connectWorker();

    const workers = await harness.registry.getWorkerDevices(USER_ID);
    const clients = await harness.registry.getClientDevices(USER_ID);

    expect(workers.map((d) => d.id)).toContain(harness.device.id);
    expect(clients.map((d) => d.id)).not.toContain(harness.device.id);
  });

  it("ne reçoit aucun événement destiné aux clients", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    // Le routeur ne livre qu'aux appareils dont le rôle reçoit des événements.
    const clients = await harness.registry.getClientDevices(USER_ID);
    expect(clients.map((d) => d.id)).toEqual(["device-iphone"]);
  });
});
