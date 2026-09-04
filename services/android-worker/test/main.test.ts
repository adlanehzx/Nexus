import { describe, expect, it } from "vitest";
import { createPrivateKey, randomBytes, sign as signEcdsa } from "node:crypto";
import {
  DeviceRegistry,
  DeviceSelector,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  TaskCoordinator,
  WorkerGateway,
  ecdsaP256Verifier,
  type WorkerConnection,
} from "@nexus/devices";
import { LoopbackLink, MemoryWorkerLogger, WorkerConfigurationError } from "@nexus/worker-core";
import type { Envelope } from "@nexus/protocol";
import { startAndroidWorker } from "../src/main.js";
import type { NexusNative } from "../src/bridge/native-bridge.js";
import type { AndroidApp, AndroidBatteryState, Screenshot, UiNode } from "../src/ports.js";
import { ANDROID_PERMISSIONS, USER_ID, generateDeviceKeys, until } from "./fixtures.js";

/**
 * Attente sur un predicat asynchrone.
 *
 * `until` du harnais ne fait tourner que la file de micro-taches et ne sait pas
 * attendre une promesse : lui passer un predicat `async` reviendrait a tester la
 * verite d'un objet Promise, qui est toujours vraie.
 */
async function untilAsync(predicate: () => Promise<boolean>, label = "condition"): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`jamais atteint : ${label}`);
}

/**
 * Le point d'entrée, éprouvé de bout en bout.
 *
 * Ce fichier part de là où l'application Android part réellement : un module
 * natif et un jeu de variables. Il traverse ensuite tout ce que `main.ts`
 * assemble — configuration, politiques, capacités, signature par le magasin de
 * clés, poignée de main — jusqu'à une session ouverte auprès d'un vrai
 * `WorkerGateway`.
 *
 * Le seul double est `NexusNative`, c'est-à-dire la frontière avec Kotlin. C'est
 * exactement la ligne que ces tests ne peuvent pas franchir sans téléphone, et
 * elle est étroite : quinze méthodes, énumérées dans `native-bridge.ts`.
 */

const DEVICE_ID = "device-redmi";

/**
 * Double du module natif.
 *
 * Il imite le magasin de clés en signant avec une vraie clé P-256 : c'est la
 * courbe qu'AndroidKeyStore sait produire, et le cœur la vérifie ici avec le
 * vrai `ecdsaP256Verifier`. Ce qui n'est pas imité, c'est l'inextractibilité de
 * la clé — une propriété du matériel, qu'aucun test hors appareil ne peut
 * établir.
 */
class FakeNative implements NexusNative {
  readonly #privateKeyPem: string;
  readonly #publicKeyPem: string;
  readonly signedAliases: string[] = [];

  accessibilityEnabled = true;
  screenshotAvailable = true;
  notificationsAllowed = true;
  sdk = 30;
  battery: AndroidBatteryState = { percent: 74, charging: false, powerSaveMode: false };

  readonly opened: string[] = [];

  constructor(keys: { privateKeyPem: string; publicKeyPem: string }) {
    this.#privateKeyPem = keys.privateKeyPem;
    this.#publicKeyPem = keys.publicKeyPem;
  }

  listApps(): Promise<AndroidApp[]> {
    return Promise.resolve([
      { packageName: "com.spotify.music", label: "Spotify", launchable: true },
    ]);
  }

  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }> {
    this.opened.push(packageName);
    return Promise.resolve({ launched: true });
  }

  isInstalled(): Promise<boolean> {
    return Promise.resolve(true);
  }

  isAccessibilityEnabled(): Promise<boolean> {
    return Promise.resolve(this.accessibilityEnabled);
  }

  findNode(): Promise<UiNode | null> {
    return Promise.resolve(null);
  }

  click(): Promise<{ clicked: boolean }> {
    return Promise.resolve({ clicked: true });
  }

  inputText(_selector: string, text: string): Promise<{ entered: boolean; characters: number }> {
    return Promise.resolve({ entered: true, characters: text.length });
  }

  scroll(): Promise<{ scrolled: boolean }> {
    return Promise.resolve({ scrolled: true });
  }

  isScreenshotAvailable(): Promise<boolean> {
    return Promise.resolve(this.screenshotAvailable);
  }

  takeScreenshot(): Promise<Screenshot> {
    return Promise.resolve({
      base64: "aW1hZ2U=",
      format: "png",
      width: 720,
      height: 1_280,
      bytes: 6,
    });
  }

  canPostNotifications(): Promise<boolean> {
    return Promise.resolve(this.notificationsAllowed);
  }

  postNotification(): Promise<{ posted: boolean; notificationId: number }> {
    return Promise.resolve({ posted: true, notificationId: 1 });
  }

  batteryState(): Promise<AndroidBatteryState> {
    return Promise.resolve(this.battery);
  }

  sdkVersion(): Promise<number> {
    return Promise.resolve(this.sdk);
  }

  /**
   * Clé publique correspondant à la clé privée du double.
   *
   * Le vrai magasin la fabrique à la première lecture ; ici elle existe déjà.
   */
  devicePublicKeyPem(): Promise<string> {
    return Promise.resolve(this.#publicKeyPem);
  }

  /**
   * Aléa. Le double n'a pas à être cryptographique — aucun test n'en dépend
   * pour sa sécurité — mais il doit être correctement encodé.
   */
  secureRandomBase64(count: number): string {
    return randomBytes(count).toString("base64");
  }

  signChallenge(keyAlias: string, nonce: string): Promise<string> {
    this.signedAliases.push(keyAlias);
    const signature = signEcdsa(
      "sha256",
      Buffer.from(nonce, "utf8"),
      createPrivateKey(this.#privateKeyPem),
    );
    return Promise.resolve(signature.toString("base64"));
  }
}

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NEXUS_BACKEND_URL: "wss://nexus.test",
    DEVICE_ID,
    DEVICE_KEY_ALIAS: "nexus.device.key",
    ANDROID_SCREENSHOT_MIN_INTERVAL_MS: "200",
    LOG_LEVEL: "debug",
    ...overrides,
  };
}

/** Le cœur, en vrai : registre, sessions P-256, passerelle, coordinateur. */
async function bootCore() {
  const registry = new DeviceRegistry();
  const credentials = new InMemoryCredentialProvider();
  const sessions = new DeviceSessionService({ registry, verifier: ecdsaP256Verifier });
  const router = new EventRouter({ registry });
  const gateway = new WorkerGateway({ registry, sessions, credentials, router });
  const selector = new DeviceSelector({ registry });
  const coordinator = new TaskCoordinator({ registry, selector, router, transport: gateway });

  const keys = generateDeviceKeys();

  const device = await registry.registerDevice({
    id: DEVICE_ID,
    userId: USER_ID,
    name: "Téléphone Android",
    type: "ANDROID",
    platform: "ANDROID",
    role: "WORKER",
    grantedPermissions: ANDROID_PERMISSIONS,
  });
  credentials.set(device.id, keys.publicKeyPem);
  await registry.trustDevice(device.id);

  const link = new LoopbackLink();
  const connection: WorkerConnection = {
    connectionId: `conn-${device.id}`,
    deviceId: device.id,
    send: (envelope: Envelope) => {
      link.deliver(envelope);
    },
    close: () => {
      link.drop("fermé par le cœur");
    },
  };
  link.outbound = (envelope) => gateway.handleMessage(connection, envelope);

  return { registry, sessions, gateway, coordinator, selector, credentials, keys, link, device };
}

// ─────────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────────

describe("startAndroidWorker", () => {
  it("part d'un module natif et de variables, et arrive à une session ouverte", async () => {
    const core = await bootCore();
    const native = new FakeNative(core.keys);
    const logger = new MemoryWorkerLogger();

    const { worker, config } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger,
    });

    await until(() => worker.isAuthenticated);
    expect(worker.isAuthenticated).toBe(true);
    expect(config.deviceId).toBe(DEVICE_ID);

    // La signature est passée par l'alias, jamais par une clé en clair.
    expect(native.signedAliases).toEqual(["nexus.device.key"]);

    await worker.stop("fin de test");
  });

  it("annonce au cœur les capacités réellement disponibles", async () => {
    const core = await bootCore();
    const native = new FakeNative(core.keys);

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await untilAsync(async () => {
      const device = await core.registry.requireDevice(DEVICE_ID);
      return device.capabilities.length > 0;
    }, "capacites enregistrees");

    const device = await core.registry.requireDevice(DEVICE_ID);
    const names = device.capabilities.map((capability) => capability.name).sort();

    // Les sept capacités NEXUS existantes, sous leurs noms existants. Le point
    // d'entrée n'en invente aucune et n'en retire aucune.
    expect(names).toEqual([
      "android.app.list",
      "android.app.open",
      "android.notification",
      "android.ui.click",
      "android.ui.input",
      "android.ui.screenshot",
      "android.ui.scroll",
    ]);

    await worker.stop("fin de test");
  });

  it("n'annonce pas ce que l'utilisateur n'a pas accordé", async () => {
    // Le service d'accessibilité éteint : quatre capacités disparaissent, et le
    // sélecteur du cœur cessera de choisir ce téléphone pour elles. C'est le
    // comportement voulu — mieux vaut ne pas être choisi qu'échouer après.
    const core = await bootCore();
    const native = new FakeNative(core.keys);
    native.accessibilityEnabled = false;
    native.screenshotAvailable = false;

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await untilAsync(async () => {
      const device = await core.registry.requireDevice(DEVICE_ID);
      return device.capabilities.length > 0;
    }, "capacites enregistrees");

    const device = await core.registry.requireDevice(DEVICE_ID);
    const names = device.capabilities.map((capability) => capability.name).sort();

    expect(names).toEqual(["android.app.list", "android.app.open", "android.notification"]);

    await worker.stop("fin de test");
  });

  it("exécute une tâche venue du cœur jusqu'au module natif", async () => {
    // La chaîne complète que la Phase 8 devait rendre possible :
    // cœur → passerelle → runtime → capacité → politique → pont → natif.
    const core = await bootCore();
    const native = new FakeNative(core.keys);

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv({ ANDROID_ALLOWED_PACKAGES: "com.spotify.music" }),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await untilAsync(async () => {
      const device = await core.registry.requireDevice(DEVICE_ID);
      return device.capabilities.length > 0;
    }, "capacites enregistrees");

    const outcome = await core.gateway.dispatch({
      deviceId: DEVICE_ID,
      taskId: "task-1",
      stepId: "step-1",
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "com.spotify.music" },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(outcome.ok).toBe(true);
    expect(native.opened).toEqual(["com.spotify.music"]);

    await worker.stop("fin de test");
  });

  it("refuse de démarrer sur une configuration incomplète", async () => {
    // Un worker à moitié configuré s'annoncerait, se ferait choisir, puis
    // échouerait tâche après tâche. On préfère l'échec au démarrage.
    const native = new FakeNative(generateDeviceKeys());

    await expect(
      startAndroidWorker({ native, env: { NEXUS_BACKEND_URL: "wss://nexus.test" } }),
    ).rejects.toThrow(WorkerConfigurationError);
  });

  it("refuse une adresse distante en clair", async () => {
    const native = new FakeNative(generateDeviceKeys());

    await expect(
      startAndroidWorker({
        native,
        env: baseEnv({ NEXUS_BACKEND_URL: "ws://nexus.exemple.fr" }),
      }),
    ).rejects.toThrow(WorkerConfigurationError);
  });

  it("ouvre son propre canal quand aucun ne lui est fourni", async () => {
    // Sans `link`, `main.ts` construit une `AndroidWebSocketLink`. Il n'y a pas
    // de cœur en face ici : ce qui est vérifié, c'est que le point d'entrée ne
    // s'arrête pas sur un échec de connexion — la reprise du runtime est le
    // mécanisme prévu, et l'application doit rester vivante.
    const native = new FakeNative(generateDeviceKeys());

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv({
        NEXUS_BACKEND_URL: "http://127.0.0.1:1",
        WORKER_RECONNECT_MIN_MS: "60000",
      }),
      logger: new MemoryWorkerLogger(),
    });

    expect(worker.isAuthenticated).toBe(false);
    expect(["reconnecting", "connecting", "idle"]).toContain(worker.state);

    await worker.stop("fin de test");
  });

  it("s'arrête proprement et ne se reconnecte pas", async () => {
    const core = await bootCore();
    const native = new FakeNative(core.keys);

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await worker.stop("arrêt demandé");

    expect(worker.isAuthenticated).toBe(false);
    expect(core.link.state).toBe("closed");
  });
});
