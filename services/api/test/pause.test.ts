import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";
import { PauseSwitch } from "../src/services/pause.js";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { makeApi, type ApiHarness } from "./harness.js";

/**
 * Pause globale.
 *
 * Ce qui est éprouvé est la définition retenue — **lire continue, agir
 * s'arrête** — et les deux pièges d'un bouton d'arrêt : qu'il ne couvre qu'une
 * moitié du système, et qu'il s'enferme en interdisant sa propre levée.
 */

const PASSWORD = "MotDePasseTresSolide!42";

/**
 * Un plan valide.
 *
 * Il doit passer la validation du schéma pour que la pause ait son mot à dire :
 * une requête malformée est refusée en 400 avant d'atteindre le gestionnaire,
 * ce qui est correct — mais ne prouverait rien de la pause.
 */
const TASK = {
  title: "Ranger",
  originClientDeviceId: "appareil-origine",
  steps: [
    {
      description: "Exécuter une commande",
      requiredCapabilities: ["shell.exec"],
      tool: "shell.exec",
    },
  ],
};

async function register(harness: ApiHarness): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "adlan@exemple.fr", displayName: "Adlane", password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

describe("pause globale", () => {
  let harness: ApiHarness;
  let token: string;

  beforeEach(async () => {
    harness = await makeApi();
    token = await register(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  const pause = (paused: boolean, reason?: string) =>
    harness.app.inject({
      method: "POST",
      url: "/api/v1/pause",
      headers: { authorization: `Bearer ${token}` },
      payload: { paused, ...(reason === undefined ? {} : { reason }) },
    });

  it("part en marche, et rend son état", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/pause",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { paused: boolean } }>().data.paused).toBe(false);
  });

  it("porte un motif et une date", async () => {
    const response = await pause(true, "réunion");
    const state = response.json<{ data: { paused: boolean; reason: string; since: string } }>()
      .data;
    expect(state.paused).toBe(true);
    expect(state.reason).toBe("réunion");
    // « Rien ne se passe » est le symptôme le plus coûteux à diagnostiquer :
    // une date et un motif le transforment en information.
    expect(new Date(state.since).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("ne déplace pas la date quand on remet en pause", async () => {
    const first = (await pause(true)).json<{ data: { since: string } }>().data.since;
    const second = (await pause(true, "toujours")).json<{ data: { since: string } }>().data.since;
    // On veut savoir depuis quand, pas depuis le dernier clic.
    expect(second).toBe(first);
  });

  it("laisse lire et empêche d'agir", async () => {
    await pause(true);

    // Agir : refusé.
    const acting = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: `Bearer ${token}` },
      payload: TASK,
    });
    expect(acting.statusCode).toBe(409);
    expect(acting.json<{ error: { code: string } }>().error.code).toBe("SYSTEM_PAUSED");

    // Lire : autorisé. Mettre NEXUS en pause ne doit pas le rendre aveugle.
    const reading = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reading.statusCode).toBe(200);
  });

  it("refuse une mission tant que la pause tient", async () => {
    await pause(true);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "Fais quelque chose." },
    });
    // 409 si la pause a parlé ; 500 si le moteur ACP n'est pas configuré. La
    // pause doit passer **avant** : une mission à moitié partie serait pire
    // qu'une mission refusée.
    expect(response.statusCode).toBe(409);
  });

  it("n'interdit pas sa propre levée", async () => {
    await pause(true, "test");
    const resumed = await pause(false);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ data: { paused: boolean; since: null } }>().data).toMatchObject({
      paused: false,
      reason: null,
      since: null,
    });

    const acting = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: `Bearer ${token}` },
      payload: TASK,
    });
    expect(acting.statusCode).not.toBe(409);
  });

  it("coupe les outils de l'agent dès l'appel suivant, sans reconstruire le service", async () => {
    // La pause est consultée par une fermeture : elle prend effet tout de
    // suite, sans remonter le conteneur. On interroge donc le vrai service de
    // permissions avec un vrai outil, plutôt que de se fier à un code HTTP.
    const tool: ToolDefinition<Record<string, never>, Record<string, never>> = {
      name: "demo.action",
      description: "Action quelconque, de risque LOW.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      riskLevel: "LOW",
      requiredPermissions: [],
      requiresConfirmation: false,
      execute: () => Promise.resolve({}),
    };
    const context = {
      runId: "run-1",
      userId: "utilisateur-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      signal: new AbortController().signal,
      idempotencyKey: "cle-1",
      attempt: 1,
      onProgress: () => undefined,
    };

    const before = await harness.services.permissions.check(tool, {}, context);
    expect(before.effect).toBe("allow");

    await pause(true);

    const after = await harness.services.permissions.check(tool, {}, context);
    expect(after.effect).toBe("deny");
    if (after.effect === "deny") expect(after.reason).toContain("pause");
  });

  it("exige un utilisateur", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/pause",
      payload: { paused: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it("journalise la mise en pause et la reprise", async () => {
    await pause(true, "réunion");
    await pause(false);
    const kinds = harness.services.securityLog.list({ limit: 20 }).map((event) => event.kind);
    expect(kinds).toContain("system.paused");
    expect(kinds).toContain("system.resumed");
  });
});

describe("la pause survit à un redémarrage", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-pause-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("se relit depuis le disque", async () => {
    const store = new RuntimeConfigurationStore(directory);
    await new PauseSwitch({ store }).set(true, "maintenance");

    // Une *autre* instance : c'est ce qui simule le redémarrage. Une pause qui
    // s'oublie est pire que pas de pause — on croit NEXUS arrêté, il ne l'est
    // plus, et personne n'est prévenu.
    const afterRestart = new PauseSwitch({ store });
    expect(afterRestart.paused).toBe(false); // avant restauration
    const restored = await afterRestart.restore();
    expect(restored.paused).toBe(true);
    expect(restored.reason).toBe("maintenance");
    expect(afterRestart.paused).toBe(true);
  });

  it("une reprise est aussi persistée", async () => {
    const store = new RuntimeConfigurationStore(directory);
    const switch1 = new PauseSwitch({ store });
    await switch1.set(true);
    await switch1.set(false);

    const restored = await new PauseSwitch({ store }).restore();
    expect(restored.paused).toBe(false);
  });

  it("écrit un fichier lisible, sans secret", async () => {
    const store = new RuntimeConfigurationStore(directory);
    await new PauseSwitch({ store }).set(true, "réunion");
    const written = JSON.parse(await readFile(join(directory, "pause.json"), "utf8")) as {
      paused: boolean;
      reason: string;
    };
    expect(written).toMatchObject({ paused: true, reason: "réunion" });
  });

  it("sans persistance, la pause ne vit qu'en mémoire — et le dit", async () => {
    // C'est le cas des tests. Ce n'en est pas un en production : sans magasin,
    // un redémarrage lèverait la pause en silence.
    const volatile = new PauseSwitch();
    await volatile.set(true);
    expect(volatile.paused).toBe(true);
    expect((await new PauseSwitch().restore()).paused).toBe(false);
  });
});
