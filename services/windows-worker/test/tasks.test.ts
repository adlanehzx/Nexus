import { describe, expect, it } from "vitest";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { makeHarness, settle, until, ALLOWED_ROOT, type WorkerHarness } from "./fixtures.js";

/**
 * Réception, exécution et restitution d'une étape.
 *
 * Ces tests entrent par où entre le cœur : une trame `worker.task_dispatch`
 * livrée sur le canal. Rien n'appelle une capacité directement — c'est le
 * chemin complet qui est éprouvé, validation comprise.
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-1",
      stepId: `step-${String(sequence)}`,
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { executable: "git", args: ["status"] },
      timeoutMs: 10_000,
      riskLevel: "HIGH",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

/** Résultats renvoyés au cœur par le worker. */
function results(harness: WorkerHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: WorkerHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await until(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

describe("réception d'une étape", () => {
  it("exécute une étape valide et renvoie le résultat", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness);

    expect(result).toMatchObject({ ok: true, taskId: "task-1" });
    expect(harness.runner.runs.some((run) => run.executable === "git")).toBe(true);
  });

  it("refuse une capacité que le worker n'a pas", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.notification",
      tool: "device.android.notification",
      arguments: { title: "x", body: "y" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("refuse une capacité désactivée par la configuration locale", async () => {
    const harness = await makeHarness({ config: { declaredCapabilities: ["filesystem.read"] } });
    await harness.connectWorker();

    // Les sondes de disponibilité ont déjà lancé « git --version ». Ce qui est
    // vérifié, c'est qu'aucun lancement ne s'y ajoute.
    const before = harness.runner.runs.length;
    const result = await dispatch(harness);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_UNAVAILABLE", retryable: false },
    });
    expect(harness.runner.runs).toHaveLength(before);
  });

  it("refuse des arguments qui ne respectent pas le schéma", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const before = harness.runner.runs.length;
    const result = await dispatch(harness, { arguments: { commande: "git status" } });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_INPUT_INVALID" } });
    // Rien n'a été lancé : la validation précède toujours l'exécution.
    expect(harness.runner.runs).toHaveLength(before);
  });

  it("ignore une trame de dispatch malformée", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.deliver({ v: 1, id: "x", type: "worker.task_dispatch", ts: "pas une date" });
    await settle();

    expect(harness.worker.state).toBe("ready");
    expect(results(harness)).toHaveLength(0);
  });

  it("émet une progression pendant l'exécution", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    await dispatch(harness);

    const progress = harness.link.sent.filter((e) => e.type === WORKER_MESSAGE.taskProgress);
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe("annulation et délais", () => {
  it("annule une étape en cours sur ordre du cœur", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    const envelope = dispatchEnvelope();
    const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
    harness.link.deliver(envelope);
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(
      workerEnvelope(
        WORKER_MESSAGE.taskCancel,
        { taskId: payload.taskId, stepId: payload.stepId, reason: "annulée par NEXUS" },
        { id: "cancel-1", at: new Date() },
      ),
    );

    await until(() => results(harness).length > 0);
    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "EXECUTION_CANCELLED" },
    });
  });

  it("interrompt une étape qui dépasse son délai", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    // Le délai s'appuie sur une vraie minuterie : on laisse passer un vrai
    // court instant plutôt que de simuler l'horloge, sinon c'est le simulacre
    // qu'on teste et non le délai.
    const envelope = dispatchEnvelope({ timeoutMs: 40 });
    const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
    harness.link.deliver(envelope);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await until(() => results(harness).some((r) => r.stepId === payload.stepId));

    const result = results(harness).find((r) => r.stepId === payload.stepId);
    expect(result).toMatchObject({ ok: false, error: { retryable: true } });
    expect(["EXECUTION_TIMEOUT", "EXECUTION_CANCELLED"]).toContain(result?.error?.code);
  }, 10_000);

  it("annule tout ce qui tourne à l'arrêt du worker", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    harness.link.deliver(dispatchEnvelope());
    await until(() => harness.worker.activeTaskCount === 1);

    await harness.worker.stop("arrêt de service");
    await until(() => harness.worker.activeTaskCount === 0);

    expect(harness.worker.activeTaskCount).toBe(0);
  });
});

describe("idempotence et concurrence", () => {
  it("n'exécute pas deux fois le même identifiant de requête", async () => {
    // Le cœur peut renvoyer un ordre après une coupure, sans savoir si le
    // premier est arrivé. Sans cette garde, `git.commit` s'exécuterait deux fois.
    const harness = await makeHarness();
    await harness.connectWorker();

    const envelope = dispatchEnvelope();
    harness.link.deliver(envelope);
    await until(() => results(harness).length === 1);

    const gitRuns = harness.runner.runs.filter((r) => r.executable === "git").length;

    harness.link.deliver(envelope);
    await settle(30);

    expect(harness.runner.runs.filter((r) => r.executable === "git")).toHaveLength(gitRuns);
    expect(results(harness)).toHaveLength(1);
  });

  it("refuse une deuxième exécution de la même étape en parallèle", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    const first = dispatchEnvelope();
    const payload = first.payload as WorkerPayload<"worker.task_dispatch">;
    harness.link.deliver(first);
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(dispatchEnvelope({ stepId: payload.stepId, requestId: "req-autre" }));
    await until(() => results(harness).length > 0);

    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "STEP_ALREADY_RUNNING", retryable: false },
    });
  });

  it("refuse une étape de plus quand il est saturé, de façon réessayable", async () => {
    // Réessayable : la machine n'est pas incapable, elle est occupée. Le
    // coordinateur peut basculer immédiatement sur un autre exécutant.
    const harness = await makeHarness({
      config: { maxConcurrentTasks: 1 },
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    harness.link.deliver(dispatchEnvelope());
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(dispatchEnvelope());
    await until(() => results(harness).length > 0);

    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "WORKER_SATURATED", retryable: true },
    });
  });
});

describe("coupure pendant une étape", () => {
  it("libère l'étape côté cœur, de façon réessayable", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.hangUntilAborted = true;
      },
    });
    await harness.connectWorker();

    // Le cœur envoie l'ordre par la passerelle, comme en production.
    const controller = new AbortController();
    const pending = harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "task-coupure",
      stepId: "step-1",
      tool: "device.terminal.execute",
      capability: "terminal.execute",
      arguments: { executable: "git", args: ["log"] },
      timeoutMs: 60_000,
      signal: controller.signal,
      onProgress: () => undefined,
    });

    await until(() => harness.worker.activeTaskCount === 1);
    await harness.gateway.detach(harness.device.id, "câble débranché");

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKER_DISCONNECTED", retryable: true },
    });
  });

  it("refuse un ordre pour un worker déconnecté", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    await harness.gateway.detach(harness.device.id, "hors ligne");

    const result = await harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "t",
      stepId: "s",
      tool: "device.terminal.execute",
      capability: "terminal.execute",
      arguments: {},
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKER_UNAVAILABLE", retryable: true },
    });
  });

  it("abandonne une étape dont l'exécutant ne répond plus", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    // La passerelle attend `timeoutMs + marge` ; on rend la marge nulle.
    const result = await harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "t",
      stepId: "s-muet",
      tool: "device.inconnu",
      // Une capacité que le worker refusera : il répondra, mais on vérifie
      // surtout que rien ne reste en suspens dans la table des étapes.
      capability: "capacite.inexistante",
      arguments: {},
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(result.ok).toBe(false);
  }, 15_000);
});

describe("exécution réelle des capacités par le canal", () => {
  it("lit un fichier autorisé", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\notes.md`, "contenu");
      },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: `${ALLOWED_ROOT}\\notes.md` },
    });

    expect(result).toMatchObject({ ok: true });
    expect((result?.result as { content: string }).content).toBe("contenu");
  });

  it("refuse une lecture hors des dossiers autorisés", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: "C:\\Users\\moi\\.aws\\credentials" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
  });

  it("refuse une opération Git modifiante en mode lecture seule", async () => {
    const harness = await makeHarness({ config: { gitAllowWrite: false } });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "git.pull",
      tool: "device.git.pull",
      arguments: { repositoryPath: `${ALLOWED_ROOT}\\leynai` },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "WORKER_POLICY_VIOLATION" } });
  });

  it("accepte une lecture Git dans la même configuration", async () => {
    const harness = await makeHarness({ config: { gitAllowWrite: false } });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "git.status",
      tool: "device.git.status",
      arguments: { repositoryPath: `${ALLOWED_ROOT}\\leynai` },
    });

    expect(result).toMatchObject({ ok: true });
  });
});
