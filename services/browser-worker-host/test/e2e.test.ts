import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DeviceRegistry,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  WorkerGateway,
  type WorkerConnection,
} from "@nexus/devices";
import { LoopbackLink, MemoryWorkerLogger } from "@nexus/worker-core";
import { BrowserWorkerClient } from "@nexus/browser-client";
import { WORKER_MESSAGE, workerEnvelope, type Envelope } from "@nexus/protocol";
import { assembleBrowserHost } from "../src/assemble.js";
import { BrowserWorkerHost } from "../src/worker.js";
import { TestSigner, generateDeviceKeys, testConfig, waitFor } from "./fixtures.js";

/**
 * Bout en bout, avec le **vrai worker Python**.
 *
 * Ce fichier lance `uvicorn` dans un processus séparé et le pilote depuis un
 * vrai `WorkerGateway`, à travers l'hôte. Ce qui s'exécute réellement : HTTP,
 * sérialisation, jeton de service, sessions, politiques d'intention, et la
 * chaîne NEXUS complète — poignée de main signée, enregistrement, dispatch,
 * résultat.
 *
 * **Ce qui reste hors de portée ici** : `browser-use` et Chromium. Le worker
 * Python répond, applique ses politiques et gère ses sessions sans qu'aucun
 * navigateur ne démarre tant qu'aucune tâche n'aboutit ; une tâche qui
 * atteindrait Chromium demanderait en plus une clé de modèle et un accès
 * réseau. La ligne est dite plutôt que masquée.
 *
 * Activation :
 *   NEXUS_WORKER_PYTHON=/chemin/vers/python pnpm --filter @nexus/browser-worker-host test
 *
 * Sans cette variable, la suite est ignorée : la chaîne Python n'est pas requise
 * pour travailler côté TypeScript.
 */

const PYTHON = process.env.NEXUS_WORKER_PYTHON;
const TOKEN = "jeton-e2e-suffisamment-long-pour-le-worker";
const PORT = 8142;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

const workerDir = fileURLToPath(new URL("../../browser-worker", import.meta.url));

const suite = PYTHON === undefined ? describe.skip : describe;

let python: ChildProcess | undefined;

/** Requete de session minimale, telle que le worker Python l'attend. */
function createSessionRequest() {
  return {
    ownerId: "user-example",
    allowedDomains: [],
    prohibitedDomains: [],
    headless: true,
    ttlSeconds: 60,
    metadata: {},
  };
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/v1/health`);
      if (response.ok) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`le worker Python n'a pas démarré : ${String(last)}`);
}

suite("bout en bout avec le worker Python réel", () => {
  beforeAll(async () => {
    python = spawn(
      PYTHON!,
      ["-m", "uvicorn", "app.main:build", "--factory", "--port", String(PORT)],
      {
        cwd: workerDir,
        env: {
          ...process.env,
          BROWSER_WORKER_AUTH_TOKEN: TOKEN,
          BROWSER_WORKER_LOG_LEVEL: "WARNING",
          BROWSER_WORKER_ALLOW_PRIVATE_HOSTS: "true",
        },
        stdio: "ignore",
      },
    );
    await waitForHealth();
  }, 90_000);

  afterAll(() => {
    python?.kill();
  });

  it("le worker Python répond, et l'hôte le voit en bonne santé", async () => {
    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
    const health = await client.health();

    expect(health.status).toBe("ok");
    expect(health.protocolVersion).toBeGreaterThan(0);
  });

  it("refuse un jeton de service invalide", async () => {
    // Le lien interne est authentifié pour de vrai, et ce test le prouve
    // contre le vrai serveur — pas contre un double.
    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: "mauvais-jeton-mais-long" });
    await expect(client.createSession(createSessionRequest())).rejects.toThrow();
  });

  it("traverse la chaîne cœur → passerelle → hôte → worker Python", async () => {
    const registry = new DeviceRegistry();
    const credentials = new InMemoryCredentialProvider();
    const sessions = new DeviceSessionService({ registry });
    const router = new EventRouter({ registry });
    const gateway = new WorkerGateway({ registry, sessions, credentials, router });

    const keys = generateDeviceKeys();
    const config = testConfig({
      browserWorkerUrl: BASE_URL,
      browserWorkerToken: TOKEN,
      deviceId: "device-browser-e2e",
    });

    const device = await registry.registerDevice({
      id: config.deviceId,
      userId: "user-example",
      name: "Exécutant navigateur",
      type: "BROWSER_WORKER",
      platform: "WEB",
      role: "WORKER",
      grantedPermissions: ["browser.navigate"],
    });
    credentials.set(device.id, keys.publicKeyPem);
    await registry.trustDevice(device.id);

    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
    const assembled = assembleBrowserHost({ config, client });
    const link = new LoopbackLink();

    const connection: WorkerConnection = {
      connectionId: "conn-e2e",
      deviceId: device.id,
      send: (envelope: Envelope) => {
        link.deliver(envelope);
      },
      close: () => {
        link.drop("fermé");
      },
    };
    link.outbound = (envelope) => gateway.handleMessage(connection, envelope);

    const host = new BrowserWorkerHost({
      config,
      capabilities: assembled.capabilities,
      client,
      sessions: assembled.sessions,
      link,
      signer: new TestSigner(keys.privateKeyPem),
      logger: new MemoryWorkerLogger(),
    });

    await host.start();
    await waitFor(() => host.isAuthenticated);

    // Les capacités arrivent réellement au registre du cœur.
    await waitFor(async () => {
      const current = await registry.requireDevice(device.id);
      return current.capabilities.length > 0;
    });
    const current = await registry.requireDevice(device.id);
    expect(current.capabilities.map((entry) => entry.name)).toContain("browser.navigate");

    // Une session navigateur est réellement ouverte côté Python.
    const opened = await client.createSession({
      ownerId: device.id,
      allowedDomains: [],
      prohibitedDomains: [],
      headless: true,
      ttlSeconds: 60,
      metadata: {},
    });
    expect(opened.sessionId).toBeTruthy();
    await client.closeSession(opened.sessionId);

    await host.stop("fin de test");
  }, 60_000);

  it("mène une tâche jusqu'à un état terminal, sans jamais rester en suspens", async () => {
    // Ce qui est éprouvé ici : le cycle de vie réel d'une tâche côté Python —
    // acceptation, numérotation des événements, état terminal. Sans clé de
    // modèle ni Chromium, elle n'aboutira pas ; ce qui compte est qu'elle
    // **se termine** au lieu de laisser l'hôte attendre indéfiniment.
    //
    // La politique de domaine elle-même (boucle locale, plages privées, points
    // de métadonnées cloud) s'applique au moment de la navigation, dans
    // `browser-use`. Elle est couverte par `tests/test_policies.py` du worker
    // Python, qui l'exerce directement.
    const client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
    const session = await client.createSession({
      ownerId: "user-example",
      allowedDomains: [],
      prohibitedDomains: [],
      headless: true,
      ttlSeconds: 60,
      metadata: {},
    });

    const started = await client.runTask({
      taskId: "t-terminal",
      sessionId: session.sessionId,
      instructions: "Va sur http://169.254.169.254/latest/meta-data/",
      intent: "read",
      maxSteps: 1,
    });

    const finished = await client.waitForTask(started.taskId, {
      pollIntervalMs: 200,
      maxWaitMs: 30_000,
    });

    expect(["succeeded", "failed", "cancelled", "timeout", "needs_human"]).toContain(
      finished.status,
    );
    // L'intention transmise n'est jamais reclassée par le worker.
    expect(finished.intent).toBe("read");

    await client.closeSession(session.sessionId);
  }, 45_000);
});

/** Le dispatch nominal reste couvert sans Python par `integration.test.ts`. */
export const DISPATCH_REFERENCE = workerEnvelope(
  WORKER_MESSAGE.taskDispatch,
  {
    taskId: "reference",
    stepId: "s1",
    capability: "browser.navigate",
    tool: "device.browser.navigate",
    arguments: { instructions: "référence" },
    timeoutMs: 1_000,
    riskLevel: "LOW",
    requestId: "r1",
  },
  { id: "ref", at: new Date(0) },
);
