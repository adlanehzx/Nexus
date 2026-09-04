import { describe, expect, it } from "vitest";
import type { CapabilityContext, LocalCapabilityRegistry } from "@nexus/worker-core";
import { assembleCapabilities } from "../src/assemble.js";
import { AndroidHealthSource } from "../src/runtime/health.js";
import { AvailabilityWatcher } from "../src/runtime/availability.js";
import { MemoryWorkerLogger } from "@nexus/worker-core";
import { makePlatform, testConfig, type FakePlatform } from "./fixtures.js";
import type { AndroidWorkerConfig } from "../src/config.js";

/**
 * Les capacités Android, une par une.
 *
 * Aucun appel au système : les quatre ports sont remplacés. Ce qui est vérifié,
 * c'est ce que la capacité *demande* au téléphone — quel paquet, quel sélecteur,
 * quel texte — car c'est là que se joue la sécurité.
 */

interface Fixture {
  capabilities: LocalCapabilityRegistry;
  platform: FakePlatform;
}

async function assemble(
  overrides: Partial<AndroidWorkerConfig> = {},
  seed?: (platform: FakePlatform) => void,
): Promise<Fixture> {
  const platform = makePlatform();
  seed?.(platform);

  const { capabilities } = assembleCapabilities({ config: testConfig(overrides), platform });
  await capabilities.probeAll();

  return { capabilities, platform };
}

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    taskId: "t1",
    stepId: "s1",
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    onProgress: () => undefined,
    ...overrides,
  };
}

async function run(fixture: Fixture, name: string, input: unknown, ctx = context()) {
  const capability = fixture.capabilities.require(name);
  const validated = fixture.capabilities.validateInput(name, input);
  return capability.execute(validated as never, ctx);
}

describe("déclaration des capacités", () => {
  it("annonce les sept capacités quand tout est disponible", async () => {
    const fixture = await assemble();
    expect(fixture.capabilities.declare().map((c) => c.name)).toEqual([
      "android.app.list",
      "android.app.open",
      "android.notification",
      "android.ui.click",
      "android.ui.input",
      "android.ui.screenshot",
      "android.ui.scroll",
    ]);
  });

  it("n'annonce pas les capacités d'interface si l'accessibilité est désactivée", async () => {
    // C'est la garantie centrale : le sélecteur ne doit jamais choisir le
    // téléphone pour un clic qu'il ne peut pas faire.
    const fixture = await assemble({}, (platform) => {
      platform.ui.accessibilityEnabled = false;
    });

    const declared = fixture.capabilities.declare().map((c) => c.name);
    expect(declared).not.toContain("android.ui.click");
    expect(declared).not.toContain("android.ui.input");
    expect(declared).not.toContain("android.ui.scroll");
    // Celles qui n'en dépendent pas restent annoncées.
    expect(declared).toContain("android.app.open");
    expect(declared).toContain("android.notification");
  });

  it("n'annonce pas la capture si elle est indisponible", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.screenshots.available = false;
    });
    expect(fixture.capabilities.declare().map((c) => c.name)).not.toContain(
      "android.ui.screenshot",
    );
  });

  it("n'annonce pas les notifications si la permission est refusée", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.notifications.allowed = false;
    });
    expect(fixture.capabilities.declare().map((c) => c.name)).not.toContain("android.notification");
  });

  it("n'annonce que les capacités autorisées par la configuration", async () => {
    const fixture = await assemble({
      declaredCapabilities: ["android.notification", "android.app.list"],
    });
    expect(fixture.capabilities.declare().map((c) => c.name)).toEqual([
      "android.app.list",
      "android.notification",
    ]);
  });

  it("distingue les trois causes d'indisponibilité", async () => {
    const fixture = await assemble({ declaredCapabilities: ["android.app.list"] }, (platform) => {
      platform.ui.accessibilityEnabled = false;
    });

    expect(() => fixture.capabilities.require("android.ui.click")).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNAVAILABLE",
        context: expect.objectContaining({ reason: expect.stringContaining("configuration") }),
      }),
    );
    expect(() => fixture.capabilities.require("registre.inexistant")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });
});

describe("android.app.list", () => {
  it("ne liste que les applications lançables et autorisées", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.list", {})) as {
      apps: { packageName: string }[];
    };

    const names = result.apps.map((app) => app.packageName);
    expect(names).toContain("com.spotify.music");
    // Les réglages sont refusés par la politique : ils ne doivent même pas
    // apparaître dans un inventaire — leur présence renseigne sur l'utilisateur.
    expect(names).not.toContain("com.android.settings");
    // Non lançable : rien à en faire.
    expect(names).not.toContain("com.example.service");
  });

  it("ne renvoie ni version, ni permissions, ni date d'installation", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.list", {})) as {
      apps: Record<string, unknown>[];
    };

    expect(Object.keys(result.apps[0] ?? {})).toEqual(["packageName", "label"]);
  });

  it("filtre par nom", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.list", { nameContains: "spot" })) as {
      total: number;
    };
    expect(result.total).toBe(1);
  });

  it("respecte la liste d'autorisation", async () => {
    const fixture = await assemble({ allowedPackages: ["com.whatsapp"] });
    const result = (await run(fixture, "android.app.list", {})) as {
      apps: { packageName: string }[];
    };
    expect(result.apps.map((a) => a.packageName)).toEqual(["com.whatsapp"]);
  });
});

describe("android.app.open", () => {
  it("ouvre une application autorisée", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.open", {
      packageName: "com.spotify.music",
    })) as { launched: boolean };

    expect(result.launched).toBe(true);
    expect(fixture.platform.apps.opened).toEqual(["com.spotify.music"]);
  });

  it("refuse un nom de paquet invalide avant tout appel système", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.app.open", { packageName: "content://settings/secure" }),
    ).rejects.toMatchObject({ code: "WORKER_POLICY_VIOLATION" });

    expect(fixture.platform.apps.opened).toHaveLength(0);
  });

  it("refuse les réglages du système", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.app.open", { packageName: "com.android.settings" }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "app.denied" }) });

    expect(fixture.platform.apps.opened).toHaveLength(0);
  });

  it("distingue « pas installée » de « refus du système »", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.app.open", { packageName: "com.absent.app" }),
    ).rejects.toMatchObject({ code: "ANDROID_APP_NOT_AVAILABLE" });
  });

  it("remonte un refus de lancement en arrière-plan", async () => {
    // Cas courant depuis Android 10, et systématique sur MIUI sans l'autorisation
    // « Afficher les fenêtres contextuelles en arrière-plan ».
    const fixture = await assemble({}, (platform) => {
      platform.apps.launchBlocked = true;
    });

    const error = (await run(fixture, "android.app.open", {
      packageName: "com.spotify.music",
    }).catch((cause: unknown) => cause)) as { code: string; userMessage: string };

    expect(error.code).toBe("ANDROID_ACTIVITY_LAUNCH_BLOCKED");
    expect(error.userMessage).toContain("MIUI");
  });
});

describe("android.ui.click", () => {
  it("appuie sur un élément désigné par son texte", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.click", {
      selector: { kind: "text", value: "Rechercher" },
    })) as { clicked: boolean };

    expect(result.clicked).toBe(true);
    expect(fixture.platform.ui.clicks).toHaveLength(1);
  });

  it("refuse si le service d'accessibilité a été désactivé entre-temps", async () => {
    // Vérifié à chaque appel, pas seulement au démarrage : l'utilisateur peut
    // désactiver le service pendant qu'une tâche tourne, et c'est son droit.
    const fixture = await assemble();
    fixture.platform.ui.accessibilityEnabled = false;

    await expect(
      run(fixture, "android.ui.click", { selector: { kind: "text", value: "Rechercher" } }),
    ).rejects.toMatchObject({ code: "ANDROID_ACCESSIBILITY_DISABLED", retryable: true });

    expect(fixture.platform.ui.clicks).toHaveLength(0);
  });

  it("refuse quand l'élément n'est pas à l'écran", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.click", { selector: { kind: "text", value: "Absent" } }),
    ).rejects.toMatchObject({ code: "ANDROID_UI_NODE_NOT_FOUND" });
  });

  it("refuse un clic sur un élément non cliquable", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.click", {
        selector: { kind: "viewId", value: "com.app:id/label" },
      }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "ui.nodeNotClickable" }) });

    expect(fixture.platform.ui.clicks).toHaveLength(0);
  });

  it("refuse un clic par coordonnées par défaut", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.click", { selector: { kind: "coordinates", x: 540, y: 1200 } }),
    ).rejects.toMatchObject({
      context: expect.objectContaining({ rule: "ui.coordinatesDisabled" }),
    });
  });

  it("accepte les coordonnées quand la configuration les autorise", async () => {
    const fixture = await assemble({ allowCoordinateClicks: true });
    const result = (await run(fixture, "android.ui.click", {
      selector: { kind: "coordinates", x: 540, y: 1200 },
    })) as { clicked: boolean };

    expect(result.clicked).toBe(true);
  });

  it("propage l'annulation", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.ui.hangUntilAborted = true;
    });

    const controller = new AbortController();
    const pending = run(
      fixture,
      "android.ui.click",
      { selector: { kind: "text", value: "Rechercher" } },
      context({ signal: controller.signal }),
    );

    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("android.ui.input", () => {
  it("saisit du texte dans un champ", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.input", {
      selector: { kind: "viewId", value: "com.app:id/field" },
      text: "bonjour",
    })) as { entered: boolean; characters: number };

    expect(result).toEqual({ entered: true, characters: 7 });
  });

  it("ne renvoie jamais le texte saisi", async () => {
    // Le résultat traverse le réseau, entre dans le journal d'exécution du cœur,
    // et s'affiche sur l'iPhone. C'est le chemin normal d'un mot de passe.
    const fixture = await assemble();
    const result = await run(fixture, "android.ui.input", {
      selector: { kind: "viewId", value: "com.app:id/field" },
      text: "MonMotDePasse2026",
    });

    expect(JSON.stringify(result)).not.toContain("MonMotDePasse2026");
  });

  it("ne place pas le texte dans la progression", async () => {
    const fixture = await assemble();
    const labels: string[] = [];

    await run(
      fixture,
      "android.ui.input",
      { selector: { kind: "viewId", value: "com.app:id/field" }, text: "SecretAbc123" },
      context({
        onProgress: (progress) => {
          if (progress.label !== undefined) labels.push(progress.label);
        },
      }),
    );

    expect(labels.join(" ")).not.toContain("SecretAbc123");
    expect(labels.join(" ")).toContain("12 caractères");
  });

  it("refuse une saisie dans un élément non éditable", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.input", {
        selector: { kind: "viewId", value: "com.app:id/label" },
        text: "x",
      }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "ui.nodeNotEditable" }) });
  });

  it("refuse un texte plus long que la limite du schéma", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.ui.input", {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "x".repeat(5_000),
      }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("refuse si le service d'accessibilité est désactivé", async () => {
    const fixture = await assemble();
    fixture.platform.ui.accessibilityEnabled = false;

    await expect(
      run(fixture, "android.ui.input", {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "ANDROID_ACCESSIBILITY_DISABLED" });

    expect(fixture.platform.ui.inputs).toHaveLength(0);
  });
});

describe("android.ui.scroll", () => {
  it("fait défiler dans la direction demandée", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.scroll", {
      direction: "down",
      amount: 3,
    })) as { scrolled: boolean };

    expect(result.scrolled).toBe(true);
    expect(fixture.platform.ui.scrolls).toEqual([{ direction: "down", amount: 3 }]);
  });

  it("refuse une direction inconnue", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.ui.scroll", { direction: "diagonale" }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("refuse une amplitude hors limites", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.ui.scroll", { direction: "down", amount: 500 }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("refuse si le service d'accessibilité est désactivé", async () => {
    const fixture = await assemble();
    fixture.platform.ui.accessibilityEnabled = false;

    await expect(run(fixture, "android.ui.scroll", { direction: "down" })).rejects.toMatchObject({
      code: "ANDROID_ACCESSIBILITY_DISABLED",
    });
  });
});

describe("android.ui.screenshot", () => {
  it("capture l'écran à la demande", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.screenshot", {})) as {
      image: string;
      width: number;
    };

    expect(result.image).toBe("aW1hZ2UtZmFjdGljZQ==");
    expect(fixture.platform.screenshots.captures).toBe(1);
  });

  it("refuse quand la capture est indisponible", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.screenshots.available = false;
    });

    // La capacité n'est même pas annoncée ; l'exiger explicitement échoue aussi.
    expect(() => fixture.capabilities.require("android.ui.screenshot")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("refuse deux captures trop rapprochées", async () => {
    const fixture = await assemble({ screenshotMinIntervalMs: 60_000 });

    await run(fixture, "android.ui.screenshot", {});
    await expect(run(fixture, "android.ui.screenshot", {})).rejects.toMatchObject({
      context: expect.objectContaining({ rule: "screenshot.rate" }),
    });

    expect(fixture.platform.screenshots.captures).toBe(1);
  });

  it("refuse une image dépassant la résolution autorisée", async () => {
    const fixture = await assemble({ screenshotMaxDimension: 480 }, (platform) => {
      platform.screenshots.image = { ...platform.screenshots.image, width: 1_080, height: 2_400 };
    });

    await expect(run(fixture, "android.ui.screenshot", {})).rejects.toMatchObject({
      context: expect.objectContaining({ rule: "screenshot.tooBig" }),
    });
  });

  it("marque son résultat comme non conservable", async () => {
    // C'est ce drapeau qui empêche l'image d'entrer dans le journal d'audit du
    // cœur. Sans lui, une capture d'écran de téléphone y resterait des mois.
    const fixture = await assemble();
    expect(fixture.capabilities.require("android.ui.screenshot").sensitiveResult).toBe(true);
  });

  it("propage l'annulation", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.screenshots.hangUntilAborted = true;
    });

    const controller = new AbortController();
    const pending = run(
      fixture,
      "android.ui.screenshot",
      {},
      context({ signal: controller.signal }),
    );

    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("android.notification", () => {
  it("émet une notification", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.notification", {
      title: "Tests terminés",
      body: "240 réussis",
    })) as { posted: boolean };

    expect(result.posted).toBe(true);
    expect(fixture.platform.notifications.posted).toEqual([
      { title: "Tests terminés", body: "240 réussis" },
    ]);
  });

  it("refuse une notification malformée", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.notification", { title: "", body: "x" }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("refuse quand la permission a été révoquée entre-temps", async () => {
    const fixture = await assemble();
    fixture.platform.notifications.allowed = false;

    await expect(
      run(fixture, "android.notification", { title: "x", body: "y" }),
    ).rejects.toMatchObject({ code: "ANDROID_PERMISSION_DENIED" });

    expect(fixture.platform.notifications.posted).toHaveLength(0);
  });

  it("remonte un échec de la plateforme", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.notifications.failNext = true;
    });

    await expect(run(fixture, "android.notification", { title: "x", body: "y" })).rejects.toThrow();
  });
});

describe("santé du téléphone", () => {
  function makeHealth(battery: { percent: number; charging: boolean; powerSaveMode?: boolean }) {
    const platform = makePlatform();
    platform.device.battery = {
      percent: battery.percent,
      charging: battery.charging,
      powerSaveMode: battery.powerSaveMode ?? false,
    };

    return new AndroidHealthSource({
      device: platform.device,
      maxConcurrentTasks: 2,
      activeTasks: () => 0,
      lowBatteryPercent: 20,
      criticalBatteryPercent: 10,
    });
  }

  it("n'est pas dégradé avec une batterie saine", async () => {
    const health = makeHealth({ percent: 80, charging: false });
    await health.refresh();
    expect(health.isDegraded()).toBe(false);
    expect(health.hasCapacity()).toBe(true);
  });

  it("passe dégradé sous le seuil bas", async () => {
    const health = makeHealth({ percent: 15, charging: false });
    await health.refresh();
    expect(health.isDegraded()).toBe(true);
    // Dégradé annonce une capacité réduite : le sélecteur le voit saturé plus
    // vite, sans qu'il faille lui apprendre ce qu'est une batterie.
    expect(health.snapshot().maxConcurrentTasks).toBe(1);
  });

  it("n'est pas dégradé en charge, même à bas niveau", async () => {
    const health = makeHealth({ percent: 5, charging: true });
    await health.refresh();
    expect(health.isDegraded()).toBe(false);
  });

  it("passe dégradé en mode économie d'énergie", async () => {
    // Android y bride les tâches de fond : les délais deviennent imprévisibles.
    const health = makeHealth({ percent: 90, charging: false, powerSaveMode: true });
    await health.refresh();
    expect(health.isDegraded()).toBe(true);
  });

  it("refuse toute tâche sous le seuil critique", async () => {
    const health = makeHealth({ percent: 8, charging: false });
    await health.refresh();
    expect(health.hasCapacity()).toBe(false);
  });

  it("garde la dernière valeur connue si la lecture échoue", async () => {
    const platform = makePlatform();
    const health = new AndroidHealthSource({
      device: {
        batteryState: () => Promise.reject(new Error("indisponible")),
        sdkVersion: () => platform.device.sdkVersion(),
      },
      maxConcurrentTasks: 1,
      activeTasks: () => 0,
    });

    await health.refresh();
    // Une lecture qui échoue ne doit pas faire disparaître le worker du registre.
    expect(health.snapshot().activeTasks).toBe(0);
  });

  it("ne remonte ni position, ni réseau, ni identité", async () => {
    const health = makeHealth({ percent: 50, charging: false });
    await health.refresh();

    expect(Object.keys(health.snapshot()).sort()).toEqual([
      "activeTasks",
      "batteryPercent",
      "maxConcurrentTasks",
      "onBattery",
    ]);
  });
});

describe("surveillance de la disponibilité", () => {
  it("signale le premier état observé", async () => {
    const platform = makePlatform();
    const changes: unknown[] = [];
    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: (snapshot) => {
        changes.push(snapshot);
      },
    });

    expect(await watcher.check()).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it("ne signale rien quand rien ne change", async () => {
    const platform = makePlatform();
    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: () => undefined,
    });

    await watcher.check();
    expect(await watcher.check()).toBe(false);
  });

  it("signale la désactivation du service d'accessibilité", async () => {
    const platform = makePlatform();
    const changes: { accessibility: boolean }[] = [];
    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: (snapshot) => {
        changes.push(snapshot);
      },
    });

    await watcher.check();
    platform.ui.accessibilityEnabled = false;

    expect(await watcher.check()).toBe(true);
    expect(changes.at(-1)?.accessibility).toBe(false);
  });

  it("traite une sonde en échec comme une indisponibilité", async () => {
    const platform = makePlatform();
    platform.ui.isAccessibilityEnabled = () => Promise.reject(new Error("pont indisponible"));

    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: () => undefined,
    });

    expect((await watcher.probe()).accessibility).toBe(false);
  });
});
