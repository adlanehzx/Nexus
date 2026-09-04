import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { makeHarness, settle, until, type AndroidHarness } from "./fixtures.js";
import { loadAndroidConfig } from "../src/config.js";

/**
 * Les propriétés de sécurité, énoncées comme des tests.
 *
 * Certaines s'observent à l'exécution ; d'autres se vérifient sur le **code
 * source et le manifeste**, parce que ce sont des propriétés d'architecture.
 * « Ce worker ne lit pas les notifications » ne se démontre pas par un cas de
 * test : on le démontre en lisant tout ce qui est déclaré au système.
 */

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-sec",
      stepId: `step-${String(sequence)}`,
      capability: "android.notification",
      tool: "device.android.notification",
      arguments: { title: "x", body: "y" },
      timeoutMs: 10_000,
      riskLevel: "MEDIUM",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

function results(harness: AndroidHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: AndroidHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await until(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

/**
 * Retire les commentaires avant analyse.
 *
 * Sans cela, une documentation qui **explique** pourquoi `MediaProjection` a été
 * écarté ferait échouer le test censé vérifier qu'il n'est pas utilisé. Or cette
 * documentation a précisément sa place : les tests portent sur le code, pas sur
 * ce qu'on écrit à son sujet.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Même chose pour un fichier XML. */
function stripXmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("aucun contrôle à distance arbitraire", () => {
  it("n'expose aucune capacité générique", () => {
    // Il n'existe pas de `runCommand`, d'`invoke(nom, args)`, ni d'exécution
    // d'`Intent` arbitraire. La surface est la liste des ports, et rien d'autre.
    const ports = stripComments(readFileSync(path.join(ROOT, "src", "ports.ts"), "utf8"));

    for (const forbidden of ["startActivityWithIntent", "runCommand", "exec(", "eval("]) {
      expect(ports).not.toContain(forbidden);
    }
  });

  it("le pont natif n'a pas de méthode générique", () => {
    // Ajouter un pouvoir au worker exige d'ajouter une méthode ici *et* dans le
    // Kotlin, ce qui se voit en revue.
    const bridge = readFileSync(path.join(ROOT, "src", "bridge", "native-bridge.ts"), "utf8");
    const methods = [...bridge.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]);

    expect(methods).not.toContain("invoke");
    expect(methods).not.toContain("call");
    expect(methods).not.toContain("send");
  });

  it("aucune capacité n'accepte d'URI ni d'intention", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "intent:#Intent;action=android.intent.action.CALL;end" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "WORKER_POLICY_VIOLATION" } });
    expect(harness.platform.apps.opened).toHaveLength(0);
  });

  it("refuse une tentative d'ouverture des réglages", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "com.android.settings" },
    });

    expect(result?.ok).toBe(false);
    expect(harness.platform.apps.opened).toHaveLength(0);
  });
});

describe("escalade de capacité", () => {
  it("refuse une capacité désactivée localement, même si le cœur l'envoie", async () => {
    // Le worker ne fait pas confiance au cœur sur ce point : il est le dernier à
    // savoir ce qui est permis sur ce téléphone. Un cœur compromis ne doit pas
    // suffire à lui faire exécuter ce que l'utilisateur a désactivé.
    const harness = await makeHarness({
      config: { declaredCapabilities: ["android.notification"] },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "text", value: "Rechercher" } },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(harness.platform.ui.clicks).toHaveLength(0);
  });

  it("refuse un clic quand l'accessibilité a été coupée entre-temps", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.platform.ui.accessibilityEnabled = false;

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "text", value: "Rechercher" } },
    });

    expect(result?.error?.code).toBe("ANDROID_ACCESSIBILITY_DISABLED");
    expect(harness.platform.ui.clicks).toHaveLength(0);
  });

  it("refuse un clic par coordonnées non autorisé", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "coordinates", x: 540, y: 1200 } },
    });

    expect(result?.ok).toBe(false);
    expect(harness.platform.ui.clicks).toHaveLength(0);
  });
});

describe("fuite de secrets", () => {
  it("ne journalise jamais le texte saisi", async () => {
    // `android.ui.input` est le chemin normal d'un mot de passe.
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.ui.input",
      tool: "device.android.ui.input",
      arguments: {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "MonMotDePasseSecret2026",
      },
    });

    expect(harness.logger.text).not.toContain("MonMotDePasseSecret2026");
  });

  it("ne renvoie jamais le texte saisi au cœur", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.ui.input",
      tool: "device.android.ui.input",
      arguments: {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "CodeBancaire987654",
      },
    });

    expect(JSON.stringify(harness.link.sent)).not.toContain("CodeBancaire987654");
    expect(JSON.stringify(harness.clientEvents)).not.toContain("CodeBancaire987654");
  });

  it("ne journalise jamais une capture d'écran", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.ui.screenshot",
      tool: "device.android.ui.screenshot",
      arguments: {},
    });

    expect(harness.logger.text).not.toContain("aW1hZ2UtZmFjdGljZQ==");
  });

  it("n'écrit aucune capture sur disque", () => {
    // Un fichier temporaire survit à un plantage, entre dans une sauvegarde
    // automatique, et reste lisible par toute application ayant accès au
    // stockage partagé. L'image ne quitte jamais la mémoire.
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      expect(content).not.toMatch(/writeFile|createWriteStream|node:fs/);
    }
  });

  it("ne journalise pas le jeton de session", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.logger.text).not.toMatch(/"token"/);
  });

  it("ne révèle pas le message technique d'une erreur inattendue", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.notifications.failNext = true;
      },
    });
    await harness.connectWorker();

    const result = await dispatch(harness);

    expect(result?.error?.code).toBe("WORKER_INTERNAL_ERROR");
    expect(result?.error?.message).not.toContain("NotificationManager");
  });
});

describe("aucune lecture de notifications", () => {
  it("le code ne référence aucun service d'écoute de notifications", () => {
    // Lire les notifications donnerait accès aux messages, aux codes à usage
    // unique, aux alertes bancaires. Ce n'est pas nécessaire, ce n'est pas
    // implémenté, et rien ne doit le réintroduire par inadvertance.
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/NotificationListenerService|getActiveNotifications|onNotificationPosted/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("le manifeste ne déclare aucun service d'écoute", () => {
    const manifest = stripXmlComments(
      readFileSync(path.join(ROOT, "android", "AndroidManifest.xml"), "utf8"),
    );

    expect(manifest).not.toContain("BIND_NOTIFICATION_LISTENER_SERVICE");
    expect(manifest).not.toContain("NotificationListenerService");
    expect(manifest).not.toContain("android.permission.READ_SMS");
    expect(manifest).not.toContain("android.permission.RECORD_AUDIO");
    expect(manifest).not.toContain("android.permission.CAMERA");
    // La visibilité des paquets passe par `<queries>`, pas par la permission
    // globale que Google restreint et dont ce worker n'a pas besoin.
    expect(manifest).not.toContain("QUERY_ALL_PACKAGES");
  });
});

describe("aucun enregistrement continu", () => {
  it("le code ne référence aucune capture continue", () => {
    const offenders: string[] = [];

    // `MediaProjection` a été écarté délibérément : il ouvre un flux vidéo, là
    // où une capture ponctuelle suffit. Le refus est documenté ; ce qui compte
    // ici est qu'il ne soit pas appelé.
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/MediaProjection|MediaRecorder|startRecording|VirtualDisplay/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("le manifeste ne déclare pas de service de projection d'écran", () => {
    const manifest = stripXmlComments(
      readFileSync(path.join(ROOT, "android", "AndroidManifest.xml"), "utf8"),
    );
    expect(manifest).not.toContain("mediaProjection");
  });

  it("la cadence des captures est bornée par défaut", () => {
    const config = loadAndroidConfig({
      NEXUS_BACKEND_URL: "wss://nexus.test/ws",
      DEVICE_ID: "d1",
    });
    expect(config.screenshotMinIntervalMs).toBeGreaterThan(0);
  });
});

describe("configuration", () => {
  const base = {
    NEXUS_BACKEND_URL: "wss://nexus.exemple.fr/ws",
    DEVICE_ID: "device-android",
  };

  it("accepte une configuration minimale", () => {
    expect(loadAndroidConfig(base)).toMatchObject({ deviceId: "device-android" });
  });

  it("refuse de démarrer sans identifiant d'appareil", () => {
    expect(() => loadAndroidConfig({ ...base, DEVICE_ID: undefined })).toThrow(
      expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }),
    );
  });

  it("refuse une adresse distante en clair", () => {
    // Un téléphone se connecte depuis n'importe quel réseau, y compris un point
    // d'accès public : le jeton de session ne peut pas transiter en clair.
    expect(() => loadAndroidConfig({ ...base, NEXUS_BACKEND_URL: "ws://nexus.fr/ws" })).toThrow(
      expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }),
    );
  });

  it("tolère l'adresse de l'émulateur en clair", () => {
    expect(() =>
      loadAndroidConfig({ ...base, NEXUS_BACKEND_URL: "ws://10.0.2.2:3000/ws" }),
    ).not.toThrow();
  });

  it("désigne la clé par un alias, jamais par sa valeur", () => {
    const config = loadAndroidConfig(base);
    expect(config.keyAlias).toBe("nexus.device.key");
    expect(JSON.stringify(config)).not.toContain("PRIVATE KEY");
  });

  it("refuse des seuils de batterie incohérents", () => {
    expect(() =>
      loadAndroidConfig({
        ...base,
        ANDROID_LOW_BATTERY_PERCENT: "5",
        ANDROID_CRITICAL_BATTERY_PERCENT: "50",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });

  it("refuse les clics par coordonnées par défaut", () => {
    expect(loadAndroidConfig(base).allowCoordinateClicks).toBe(false);
  });
});

describe("aucun secret dans le dépôt", () => {
  it("le fichier .env.example ne contient que des marqueurs", () => {
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");

    expect(example).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(example).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/);
    expect(example).toMatch(/DEVICE_KEY_ALIAS=/);
  });

  it("aucun fichier de clé n'est présent dans le paquet", () => {
    for (const suspect of ["nexus-device.key", "keystore.jks", "release.keystore"]) {
      expect(existsSync(path.join(ROOT, suspect))).toBe(false);
      expect(existsSync(path.join(ROOT, "android", suspect))).toBe(false);
    }
  });
});

describe("un identifiant d'appareil n'authentifie rien", () => {
  it("refuse d'exécuter un ordre reçu avant l'ouverture de session", async () => {
    const harness = await makeHarness();
    // On ne connecte pas : le canal est ouvert mais aucune session n'existe.
    await harness.link.connect();

    harness.link.deliver(dispatchEnvelope());
    await settle(30);

    expect(harness.platform.notifications.posted).toHaveLength(0);
    expect(harness.worker.isAuthenticated).toBe(false);
  });
});
