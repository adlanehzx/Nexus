import { describe, expect, it } from "vitest";
import { NoEligibleWorkerError } from "../src/errors.js";
import { canAcceptTasks, canReceiveEvents } from "../src/types.js";
import { defaultRiskFor } from "../src/tools.js";
import {
  ALL_PERMISSIONS,
  DESKTOP,
  IPHONE,
  LAPTOP,
  REDMI,
  USER_ID,
  makeHarness,
  setupFleet,
} from "./fixtures.js";

/**
 * Le parc, ses rôles, et ce que la sélection en fait.
 *
 * Aucun test ne nomme un appareil dans une décision : ils déclarent des
 * capacités requises et vérifient qui est retenu. Un test qui dirait « prends le
 * poste fixe » validerait précisément ce que l'architecture interdit.
 */

describe("rôles du parc", () => {
  it("l'iPhone est un client, jamais un exécutant", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const iphone = await h.registry.requireDevice(IPHONE.id);
    expect(iphone.role).toBe("CLIENT");
    expect(canAcceptTasks(iphone.role)).toBe(false);
    expect(canReceiveEvents(iphone.role)).toBe(true);
  });

  it("le portable Windows est les deux à la fois", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const laptop = await h.registry.requireDevice(LAPTOP.id);
    expect(laptop.role).toBe("BOTH");
    expect(canAcceptTasks(laptop.role)).toBe(true);
    expect(canReceiveEvents(laptop.role)).toBe(true);
  });

  it("le poste fixe est un exécutant, pas un client", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const desktop = await h.registry.requireDevice(DESKTOP.id);
    expect(desktop.role).toBe("WORKER");
    expect(canAcceptTasks(desktop.role)).toBe(true);
    expect(canReceiveEvents(desktop.role)).toBe(false);
  });

  it("le Redmi est un exécutant Android", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const redmi = await h.registry.requireDevice(REDMI.id);
    expect(redmi.role).toBe("WORKER");
    expect(redmi.type).toBe("ANDROID");
    expect(canAcceptTasks(redmi.role)).toBe(true);
  });

  it("range les appareils par rôle", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const clients = (await h.registry.getClientDevices(USER_ID)).map((d) => d.id).sort();
    const workers = (await h.registry.getWorkerDevices(USER_ID)).map((d) => d.id).sort();

    // Le portable figure dans les deux listes : c'est tout l'intérêt de BOTH.
    expect(clients).toEqual([IPHONE.id, LAPTOP.id].sort());
    expect(workers).toEqual([DESKTOP.id, LAPTOP.id, REDMI.id].sort());
  });
});

describe("sélection de l'exécutant", () => {
  it("ne choisit jamais un client, même s'il a la capacité", async () => {
    const h = makeHarness();
    // L'iPhone déclare `notification.push` ; le Redmi aussi sait notifier.
    await setupFleet(h);

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["notification.push"],
      userPermissions: ALL_PERMISSIONS,
    });

    // L'iPhone a la capacité mais le rôle CLIENT : il est écarté d'office.
    expect(selection.device.id).not.toBe(IPHONE.id);
    expect(selection.rejected.find((r) => r.deviceId === IPHONE.id)?.reason).toContain("client");
  });

  it("accepte le portable comme exécutant parce qu'il est BOTH", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [IPHONE, LAPTOP] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["terminal.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(LAPTOP.id);
  });

  it("écarte un exécutant hors ligne", async () => {
    const h = makeHarness();
    await setupFleet(h, { online: [LAPTOP.id] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["docker.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(LAPTOP.id);
    expect(selection.rejected.find((r) => r.deviceId === DESKTOP.id)?.reason).toBe("offline");
  });

  it("écarte un exécutant en ligne mais non authentifié", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    await h.registry.setAuthenticated(DESKTOP.id, false);
    await h.registry.updateDevice(DESKTOP.id, { status: "ONLINE" });

    await expect(
      h.selector.select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: ALL_PERMISSIONS,
      }),
    ).rejects.toBeInstanceOf(NoEligibleWorkerError);
  });

  it("écarte un exécutant non approuvé", async () => {
    const h = makeHarness();
    // Allumé et authentifié, mais la confiance n'a jamais été donnée.
    await setupFleet(h, { devices: [DESKTOP], trusted: [] });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: ALL_PERMISSIONS,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("not approved yet");
  });

  it("écarte un exécutant dont la permission n'est pas accordée", async () => {
    const h = makeHarness();
    await setupFleet(h, {
      devices: [DESKTOP],
      permissions: { [DESKTOP.id]: ["filesystem.read"] },
    });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: [],
      })
      .catch((e: unknown) => e);

    // La capacité existe, l'autorisation non : savoir faire n'est pas avoir le droit.
    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("permission not granted");
  });

  it("écarte un exécutant dont la capacité manque", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [REDMI] });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["docker.execute"],
        userPermissions: ALL_PERMISSIONS,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("missing capability");
  });

  it("écarte un appareil révoqué", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP, LAPTOP] });
    await h.registry.revokeDevice(DESKTOP.id);

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["terminal.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(LAPTOP.id);
    expect(selection.rejected.find((r) => r.deviceId === DESKTOP.id)?.reason).toBe(
      "device revoked",
    );
  });

  it("choisit le plus disponible entre deux exécutants équivalents", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });

    // Le portable est déjà chargé ; le poste fixe est libre.
    await h.registry.updateHealth(LAPTOP.id, {
      activeTasks: 2,
      maxConcurrentTasks: 3,
      cpuLoad: 0.9,
    });
    await h.registry.updateHealth(DESKTOP.id, {
      activeTasks: 0,
      maxConcurrentTasks: 3,
      cpuLoad: 0.1,
    });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(DESKTOP.id);
    expect(selection.candidates).toHaveLength(2);
    expect(selection.candidates[0]?.score).toBeGreaterThan(selection.candidates[1]?.score ?? 0);
  });

  it("respecte un choix explicite de l'utilisateur s'il reste éligible", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });
    await h.registry.updateHealth(LAPTOP.id, { activeTasks: 2, maxConcurrentTasks: 3 });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
      preferredDeviceId: LAPTOP.id,
    });

    // Le portable est plus chargé, mais l'utilisateur l'a demandé.
    expect(selection.device.id).toBe(LAPTOP.id);
  });

  it("ignore une préférence portant sur un appareil inéligible", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP], online: [LAPTOP.id] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
      preferredDeviceId: DESKTOP.id,
    });

    // Une préférence ne rend pas éligible un appareil hors ligne.
    expect(selection.device.id).toBe(LAPTOP.id);
  });

  it("écarte un exécutant saturé", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    await h.registry.updateHealth(DESKTOP.id, { activeTasks: 2, maxConcurrentTasks: 2 });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: ALL_PERMISSIONS,
      })
      .catch((e: unknown) => e);

    expect((error as NoEligibleWorkerError).userMessage).toContain("busy");
  });

  it("écarte un exécutant dont le type ne respecte pas la contrainte", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["git.execute"],
        userPermissions: ALL_PERMISSIONS,
        constraints: { deviceTypes: ["ANDROID"] },
      })
      .catch((e: unknown) => e);

    // Deux postes Windows savent le faire, mais la contrainte les exclut.
    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("does not match");
  });

  it("écarte un appareil sur batterie quand la tâche exige le secteur", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
      constraints: { requireMainsPower: true },
    });

    expect(selection.device.id).toBe(DESKTOP.id);
    expect(selection.rejected.find((r) => r.deviceId === LAPTOP.id)?.reason).toContain("battery");
  });
});

describe("registre", () => {
  it("trouve les appareils par capacité, sans filtrer sur le statut", async () => {
    const h = makeHarness();
    await setupFleet(h, { online: [] });

    // La question est « qui sait faire ça ? », pas « qui peut maintenant ? ».
    const capable = await h.registry.getDevicesByCapability(USER_ID, ["docker.execute"]);
    expect(capable.map((d) => d.id).sort()).toEqual([DESKTOP.id, LAPTOP.id].sort());
  });

  it("exige toutes les capacités demandées", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const capable = await h.registry.getDevicesByCapability(USER_ID, [
      "docker.execute",
      "android.notification",
    ]);
    expect(capable).toHaveLength(0);
  });

  it("met à jour les capacités déclarées et retire celles qui disparaissent", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });

    await h.registry.updateCapabilities(DESKTOP.id, [
      { name: "filesystem.read", version: "1", description: "", enabled: true, metadata: {} },
    ]);

    const device = await h.registry.requireDevice(DESKTOP.id);
    // Docker a disparu de la déclaration : l'appareil ne doit plus être choisi
    // pour Docker, pas conserver une capacité fantôme.
    expect(device.capabilities.map((c) => c.name)).toEqual(["filesystem.read"]);
    expect(await h.registry.getDevicesByCapability(USER_ID, ["docker.execute"])).toHaveLength(0);
  });

  it("passe hors ligne un appareil silencieux trop longtemps", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    expect((await h.registry.requireDevice(DESKTOP.id)).status).toBe("ONLINE");

    h.clock.now = new Date(h.clock.now.getTime() + 120_000);

    // Sans cette expiration, un worker débranché brutalement resterait éligible
    // jusqu'à sa prochaine écriture — c'est-à-dire jamais.
    expect((await h.registry.requireDevice(DESKTOP.id)).status).toBe("OFFLINE");
  });

  it("un battement de cœur ne ressuscite pas un appareil révoqué", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    await h.registry.revokeDevice(DESKTOP.id);

    await h.registry.updateHeartbeat(DESKTOP.id);

    const device = await h.registry.requireDevice(DESKTOP.id);
    expect(device.status).toBe("REVOKED");
    expect(device.trust).toBe("REVOKED");
  });

  it("retirer la confiance est réversible, la révocation ne l'est pas", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });

    await h.registry.revokeTrust(DESKTOP.id);
    expect((await h.registry.requireDevice(DESKTOP.id)).trust).toBe("PENDING");

    await h.registry.trustDevice(DESKTOP.id);
    expect((await h.registry.requireDevice(DESKTOP.id)).trust).toBe("TRUSTED");

    await h.registry.revokeDevice(DESKTOP.id);
    expect((await h.registry.requireDevice(DESKTOP.id)).revokedAt).not.toBeNull();
  });

  it("un appareil arrive hors ligne et non approuvé", async () => {
    const h = makeHarness();
    const device = await h.registry.registerDevice({
      userId: USER_ID,
      name: "Nouveau",
      type: "LINUX",
      platform: "LINUX",
      role: "WORKER",
    });

    // La confiance se donne, elle ne se suppose pas.
    expect(device.status).toBe("OFFLINE");
    expect(device.trust).toBe("PENDING");
    expect(device.authenticated).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Risque par défaut d'une capacité
// ───────────────────────────────────────────────────────────────────────────────

describe("risque par défaut", () => {
  it("gradue les capacités du navigateur de la lecture à l'achat", () => {
    // La progression est ce qui permet aux confirmations de faire leur travail :
    // lire un prix ne demande rien, acheter demande un accord explicite.
    expect(defaultRiskFor("browser.navigate")).toBe("LOW");
    expect(defaultRiskFor("browser.interact")).toBe("MEDIUM");
    expect(defaultRiskFor("browser.login")).toBe("HIGH");
    expect(defaultRiskFor("browser.purchase")).toBe("CRITICAL");
  });

  it("un achat reste CRITICAL, pas HIGH", () => {
    // Le point précis. Le coordinateur confirme quand
    // `riskRank(risque) >= riskRank(seuil)`. Un déploiement qui place son seuil
    // à CRITICAL ne confirmerait pas un paiement classé HIGH — c'est-à-dire
    // qu'il paierait sans demander.
    expect(defaultRiskFor("browser.purchase")).not.toBe("HIGH");
  });

  it("retombe sur HIGH pour une capacité inconnue", () => {
    // Dans le doute, on ne minimise pas : une capacité qu'on ne connaît pas
    // pourrait tout faire.
    expect(defaultRiskFor("quelque.chose.dinconnu")).toBe("HIGH");
  });
});
