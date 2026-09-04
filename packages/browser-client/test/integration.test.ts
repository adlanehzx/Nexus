import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BrowserWorkerClient, BrowserWorkerError } from "../src/index.js";

/**
 * Communication réelle TypeScript ↔ Python.
 *
 * Lance le vrai worker FastAPI dans un processus séparé et le pilote avec le
 * vrai client : HTTP, sérialisation, authentification, codes d'erreur. C'est la
 * seule façon de vérifier que les deux mondes se comprennent — le test de
 * contrat compare des schémas, celui-ci compare des comportements.
 *
 * Activation :
 *   NEXUS_WORKER_PYTHON=/chemin/vers/python pnpm --filter @nexus/browser-client test
 *
 * Ignoré sans cette variable : la chaîne Python n'est pas requise pour
 * travailler côté TypeScript.
 */

const PYTHON = process.env.NEXUS_WORKER_PYTHON;
const TOKEN = "jeton-integration-suffisamment-long";
const PORT = 8137;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

const workerDir = fileURLToPath(new URL("../../../services/browser-worker", import.meta.url));

let worker: ChildProcess | undefined;
let client: BrowserWorkerClient;

const suite = PYTHON === undefined ? describe.skip : describe;

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/v1/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`le worker n'a pas démarré : ${String(lastError)}`);
}

suite("communication TypeScript ↔ Python", () => {
  beforeAll(async () => {
    worker = spawn(
      PYTHON!,
      [
        "-m",
        "uvicorn",
        "app.main:build",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
      ],
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

    client = new BrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN });
  }, 90_000);

  afterAll(() => {
    worker?.kill();
  });

  it("lit la santé du worker et sa version de protocole", async () => {
    const health = await client.health();

    expect(health.protocolVersion).toBe(1);
    expect(["ok", "degraded"]).toContain(health.status);
    // Le schéma Zod valide la réponse Pydantic : les deux mondes s'accordent
    // sur la forme, pas seulement sur les noms.
    expect(typeof health.openSessions).toBe("number");
  });

  it("crée, lit et ferme une session", async () => {
    const session = await client.createSession({
      ownerId: "user-integration",
      allowedDomains: ["exemple.test"],
    });

    expect(session.sessionId).toMatch(/^bs_/);
    expect(session.ownerId).toBe("user-integration");
    expect(session.status).toBe("open");

    const fetched = await client.getSession(session.sessionId);
    expect(fetched.sessionId).toBe(session.sessionId);

    await client.closeSession(session.sessionId);
    await expect(client.getSession(session.sessionId)).rejects.toBeInstanceOf(BrowserWorkerError);
  });

  it("refuse un jeton invalide", async () => {
    const intrus = new BrowserWorkerClient({ baseUrl: BASE_URL, token: "mauvais-jeton-long" });

    await expect(intrus.createSession({ ownerId: "u" })).rejects.toThrow();
  });

  it("renvoie des codes d'erreur que le TypeScript reconnaît", async () => {
    // Le contrat d'erreur traverse aussi la frontière : le backend s'appuie
    // dessus pour distinguer le réessayable du définitif.
    try {
      await client.getSession("bs_inexistante");
      expect.unreachable("aurait dû échouer");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserWorkerError);
      expect((error as BrowserWorkerError).code).toBe("BROWSER_SESSION_NOT_FOUND");
    }
  });

  it("rejette une session inconnue au lancement d'une tâche", async () => {
    await expect(
      client.runTask({
        taskId: "t-integration",
        sessionId: "bs_inexistante",
        instructions: "Lis la page d'accueil",
        intent: "read",
      }),
    ).rejects.toBeInstanceOf(BrowserWorkerError);
  });

  it("applique la limite de sessions et la rend lisible", async () => {
    const opened: string[] = [];
    try {
      for (let i = 0; i < 5; i += 1) {
        opened.push((await client.createSession({ ownerId: "user-limite" })).sessionId);
      }
      const extra = await client.createSession({ ownerId: "user-limite" });
      opened.push(extra.sessionId);
      expect.unreachable("la limite aurait dû s'appliquer");
    } catch (error) {
      expect((error as BrowserWorkerError).code).toBe("BROWSER_SESSION_BUSY");
    } finally {
      for (const id of opened) await client.closeSession(id).catch(() => undefined);
    }
  });
});
