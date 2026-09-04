import { describe, expect, it } from "vitest";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import { makeHarness, settle, until, waitFor, type BrowserHarness } from "./fixtures.js";

/**
 * La chaîne complète, du cœur jusqu'au contrat HTTP du navigateur.
 *
 * C'est ce que la Phase 9 devait rendre possible :
 *
 *     cœur → WorkerGateway → session authentifiée → exécutant navigateur
 *          → capacité → worker Python
 *
 * Rien n'est simulé du côté NEXUS : vraie `WorkerGateway`, vraie signature
 * Ed25519, vrai `DeviceSessionService`, vrai `TaskCoordinator`, vraies
 * enveloppes validées par les schémas du protocole. Le seul double est le
 * worker Python, et il est remplacé **au niveau HTTP** — le client sérialise et
 * valide réellement.
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-nav",
      stepId: `step-${String(sequence)}`,
      capability: "browser.navigate",
      tool: "device.browser.navigate",
      arguments: { instructions: "relève le prix du billet" },
      timeoutMs: 30_000,
      riskLevel: "LOW",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

function results(harness: BrowserHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: BrowserHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  // `waitForTask` du client sonde l'etat avec une minuterie : une attente sur la
  // seule file de micro-taches ne l'atteindrait jamais.
  await waitFor(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session worker
// ─────────────────────────────────────────────────────────────────────────────

describe("session auprès du cœur", () => {
  it("s'authentifie par signature du défi, comme les autres exécutants", async () => {
    // Aucun jeton partagé avec le cœur : l'exécutant navigateur prouve qu'il
    // détient la clé de l'appareil. C'est le même mécanisme que le worker
    // Windows et le worker Android — il n'y a pas de second système.
    const harness = await makeHarness();
    await harness.connect();

    expect(harness.host.isAuthenticated).toBe(true);
    expect(harness.host.state).toBe("ready");
  });

  it("annonce ses quatre capacités au registre du cœur", async () => {
    const harness = await makeHarness();
    await harness.connect();
    await until(async () => {
      const device = await harness.registry.requireDevice(harness.device.id);
      return device.capabilities.length > 0;
    });

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities.map((entry) => entry.name).sort()).toEqual([
      "browser.interact",
      "browser.login",
      "browser.navigate",
      "browser.purchase",
    ]);
  });

  it("n'annonce rien quand le worker Python ne répond pas", async () => {
    // L'exécutant reste joignable mais ne sait rien faire : le sélecteur doit
    // l'écarter plutôt que de lui confier une étape vouée à l'échec.
    const harness = await makeHarness({ seed: (python) => (python.unreachable = true) });
    await harness.connect();
    await settle(30);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities).toEqual([]);
    expect(harness.host.health.isDegraded()).toBe(true);
  });

  it("un appareil non approuvé n'obtient pas de session", async () => {
    const harness = await makeHarness({ trusted: false });
    await harness.host.start();
    await settle(30);

    expect(harness.host.isAuthenticated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exécution dispatchée par le cœur
// ─────────────────────────────────────────────────────────────────────────────

describe("exécution d'une étape venue du cœur", () => {
  it("traverse la chaîne complète et rend le résultat", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const result = await dispatch(harness);

    expect(result?.ok).toBe(true);
    expect(harness.python.launched).toHaveLength(1);
    expect(harness.python.launched[0]?.intent).toBe("read");
  });

  it("refuse une capacité que cet exécutant n'a pas", async () => {
    // Le point de cloisonnement : un exécutant navigateur ne lance pas de
    // commande shell, même si le cœur le lui demandait.
    const harness = await makeHarness();
    await harness.connect();

    const result = await dispatch(harness, {
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { command: "whoami" },
      riskLevel: "HIGH",
    });

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("refuse une capacité retirée par la configuration locale", async () => {
    // Un déploiement qui interdit l'achat automatique : la capacité n'est ni
    // annoncée, ni exécutable, même sur dispatch direct.
    const harness = await makeHarness({
      config: { declaredCapabilities: ["browser.navigate"] },
    });
    await harness.connect();

    const result = await dispatch(harness, {
      capability: "browser.purchase",
      tool: "device.browser.purchase",
      arguments: { instructions: "achète le billet" },
      riskLevel: "CRITICAL",
    });

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("valide les arguments avant d'ouvrir un navigateur", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const result = await dispatch(harness, { arguments: { instructions: "" } });

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("CAPABILITY_INPUT_INVALID");
    // Rien n'a été ouvert : la validation précède l'appel réseau.
    expect(harness.python.sessions).toEqual([]);
  });

  it("remonte la progression au cœur pendant la navigation", async () => {
    const harness = await makeHarness({
      seed: (python) => {
        python.outcome = {
          status: "succeeded",
          output: "129 €",
          steps: 2,
          events: [
            {
              type: "progress",
              taskId: "task-nav-step-1",
              sessionId: "sess-1",
              seq: 1,
              ts: new Date().toISOString(),
              step: 1,
              maxSteps: 4,
              note: null,
            },
          ],
        };
      },
    });
    await harness.connect();
    await dispatch(harness);

    const progress = harness.link.sent.filter(
      (envelope) => envelope.type === WORKER_MESSAGE.taskProgress,
    );
    expect(progress.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions navigateur
// ─────────────────────────────────────────────────────────────────────────────

describe("isolation des sessions navigateur", () => {
  it("réutilise la même session pour les étapes d'une même tâche", async () => {
    // « Connecte-toi, puis commande » est une tâche à deux étapes. Ouvrir deux
    // navigateurs perdrait la connexion entre les deux.
    const harness = await makeHarness();
    await harness.connect();

    await dispatch(harness, { taskId: "task-a" });
    await dispatch(harness, { taskId: "task-a" });

    expect(harness.python.sessions).toHaveLength(1);
    expect(harness.python.launched.map((entry) => entry.sessionId)).toEqual(["sess-1", "sess-1"]);
  });

  it("n'utilise jamais la même session pour deux tâches différentes", async () => {
    // Le point d'isolation. Une tâche qui s'est connectée à une banque ne doit
    // pas laisser sa session ouverte à la tâche suivante, qui visitera
    // peut-être un site hostile.
    const harness = await makeHarness();
    await harness.connect();

    await dispatch(harness, { taskId: "task-a" });
    await dispatch(harness, { taskId: "task-b" });

    expect(harness.python.sessions).toHaveLength(2);
    const used = new Set(harness.python.launched.map((entry) => entry.sessionId));
    expect(used.size).toBe(2);
  });

  it("transmet les listes de domaines au worker Python", async () => {
    // La politique est appliquée là-bas, par le navigateur lui-même. Ce qui se
    // vérifie ici est qu'elle est bien transmise — la perdre reviendrait à
    // naviguer sans restriction.
    const harness = await makeHarness({
      config: {
        allowedDomains: ["exemple.fr"],
        prohibitedDomains: ["ads.exemple.fr"],
      },
    });
    await harness.connect();
    await dispatch(harness);

    expect(harness.python.requestedDomains[0]).toEqual({
      allowed: ["exemple.fr"],
      prohibited: ["ads.exemple.fr"],
    });
  });

  it("ferme les navigateurs à l'arrêt", async () => {
    // Un Chromium laissé ouvert survit au processus et consomme jusqu'à
    // expiration de son TTL.
    const harness = await makeHarness();
    await harness.connect();
    await dispatch(harness, { taskId: "task-a" });

    await harness.host.stop("fin de test");

    expect(harness.python.closedSessions).toEqual(["sess-1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sélection par le cœur
// ─────────────────────────────────────────────────────────────────────────────

describe("sélection par le cœur", () => {
  it("le sélecteur choisit l'exécutant navigateur sur la capacité, pas sur son nom", async () => {
    // Rien dans le cœur ne connaît « le worker navigateur ». Il connaît des
    // capacités, et cet appareil a annoncé `browser.navigate`.
    const harness = await makeHarness();
    await harness.connect();
    await until(async () => {
      const device = await harness.registry.requireDevice(harness.device.id);
      return device.capabilities.length > 0;
    });

    const plan = createTaskPlan({
      userId: "user-adlan",
      title: "Chercher un prix",
      originClientDeviceId: harness.device.id,
      correlationId: "corr-browser",
      steps: [
        {
          id: "s1",
          description: "Relever le prix",
          requiredCapabilities: ["browser.navigate"],
          tool: "device.browser.navigate",
          arguments: { instructions: "prix du billet" },
          riskLevel: "LOW",
        },
      ],
    });

    const chosen = await harness.selector.select({
      userId: "user-adlan",
      requiredCapabilities: ["browser.navigate"],
    });

    expect(chosen.device.id).toBe(harness.device.id);
    expect(plan.steps).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Annulation
// ───────────────────────────────────────────────────────────────────────────────

describe("annulation", () => {
  it("propage l'annulation du cœur jusqu'au navigateur", async () => {
    // Une navigation dure des minutes. Quand l'utilisateur renonce, le
    // navigateur doit s'arrêter — sinon un Chromium continue de cliquer sur un
    // site pour une tâche que plus personne n'attend.
    const harness = await makeHarness({
      seed: (python) => {
        python.outcome = { status: "running", hangUntilCancelled: true };
      },
    });
    await harness.connect();

    const envelope = dispatchEnvelope({ taskId: "task-long", stepId: "step-long" });
    harness.link.deliver(envelope);
    await waitFor(() => harness.python.launched.length > 0);

    harness.link.deliver(
      workerEnvelope(
        WORKER_MESSAGE.taskCancel,
        { taskId: "task-long", stepId: "step-long", reason: "l'utilisateur a renoncé" },
        { id: "env-cancel", at: new Date() },
      ),
    );

    // Le worker Python reçoit réellement l'ordre d'annulation.
    await waitFor(() => harness.python.cancelled.length > 0);
    expect(harness.python.cancelled[0]).toContain("task-long");
  });

  it("rend une étape annulée au cœur, pas un succès silencieux", async () => {
    const harness = await makeHarness({
      seed: (python) => {
        python.outcome = { status: "running", hangUntilCancelled: true };
      },
    });
    await harness.connect();

    harness.link.deliver(dispatchEnvelope({ taskId: "task-x", stepId: "step-x" }));
    await waitFor(() => harness.python.launched.length > 0);

    harness.link.deliver(
      workerEnvelope(
        WORKER_MESSAGE.taskCancel,
        { taskId: "task-x", stepId: "step-x", reason: "arrêt" },
        { id: "env-cancel-2", at: new Date() },
      ),
    );

    await waitFor(() => results(harness).some((entry) => entry.stepId === "step-x"));
    const result = results(harness).find((entry) => entry.stepId === "step-x");

    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBeTruthy();
  });
});
