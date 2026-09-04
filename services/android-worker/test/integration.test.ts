import { describe, expect, it } from "vitest";
import { createTaskPlan, SENSITIVE_RESULT_PLACEHOLDER, InMemoryTaskStore } from "@nexus/devices";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { TaskCoordinator } from "@nexus/devices";
import {
  ANDROID_PERMISSIONS,
  IPHONE,
  USER_ID,
  makeHarness,
  settle,
  until,
  type AndroidHarness,
} from "./fixtures.js";

/**
 * Le chemin complet, de bout en bout.
 *
 *     iPhone → TaskCoordinator → DeviceSelector → WorkerTransport
 *       → worker Android → capacité → événements → EventRouter → iPhone
 *
 * Rien n'est simulé sur ce chemin : ce sont le vrai coordinateur, le vrai
 * sélecteur, la vraie passerelle et le vrai worker. Seuls le transport réseau
 * et les quatre ports Android sont doublés.
 *
 * C'est ce fichier qui justifie que le WebSocket de la phase suivante soit un
 * simple adaptateur : tout ce qu'il portera est déjà éprouvé ici.
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-1",
      stepId: `step-${String(sequence)}`,
      capability: "android.notification",
      tool: "device.android.notification",
      arguments: { title: "Bonjour", body: "Test" },
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

describe("chaîne complète", () => {
  it("exécute une notification demandée depuis l'iPhone", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Prévenir sur le téléphone",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-android",
      steps: [
        {
          id: "notifier",
          description: "Notifier la fin des tests",
          requiredCapabilities: ["android.notification"],
          tool: "device.android.notification",
          arguments: { title: "Tests", body: "Terminés" },
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(executed.status).toBe("succeeded");
    expect(executed.steps[0]?.selectedDeviceId).toBe(harness.device.id);
    expect(harness.platform.notifications.posted).toEqual([{ title: "Tests", body: "Terminés" }]);
  });

  it("ramène les événements de tâche à l'appareil d'origine", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Ouvrir Spotify",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-open",
      steps: [
        {
          id: "ouvrir",
          description: "Ouvrir Spotify",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { packageName: "com.spotify.music" },
          riskLevel: "LOW",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: ANDROID_PERMISSIONS });

    const taskEvents = harness.clientEvents.filter(
      (event) => event.type.startsWith("task.") || event.type.startsWith("worker.task_"),
    );

    expect(taskEvents.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.started",
        "worker.task_started",
        "worker.task_completed",
        "task.completed",
      ]),
    );
    for (const event of taskEvents) {
      expect(event.originClientDeviceId).toBe(IPHONE.id);
    }
  });

  it("le sélecteur choisit le téléphone sur ses capacités, jamais sur son nom", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const selection = await harness.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["android.ui.click"],
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(selection.device.id).toBe(harness.device.id);
    // L'iPhone est connu, mais écarté : il est CLIENT.
    expect(selection.rejected.map((r) => r.deviceId)).toContain(IPHONE.id);
  });

  it("ne choisit pas le téléphone quand l'accessibilité est coupée", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.ui.accessibilityEnabled = false;
      },
    });
    await harness.connectWorker();

    const selection = await harness.selector.trySelect({
      userId: USER_ID,
      requiredCapabilities: ["android.ui.click"],
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(selection).toBeUndefined();
  });

  it("remonte au client un refus de politique Android", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Ouvrir les réglages",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-refus",
      steps: [
        {
          id: "ouvrir",
          description: "Ouvrir les réglages du système",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { packageName: "com.android.settings" },
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(executed.status).toBe("failed");
    expect(executed.steps[0]?.error?.code).toBe("WORKER_POLICY_VIOLATION");
    expect(harness.platform.apps.opened).toHaveLength(0);
  });

  it("échoue proprement quand aucun exécutant ne sait faire", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Lancer un terminal",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-absent",
      steps: [
        {
          id: "shell",
          description: "Exécuter une commande",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          arguments: {},
          riskLevel: "HIGH",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(executed.status).toBe("failed");
    expect(harness.clientEvents.map((e) => e.type)).toContain("task.failed");
  });

  it("ne conserve pas la capture d'écran dans le journal d'exécution", async () => {
    // Le point le plus sensible de ce lot : l'image atteint le client qui l'a
    // demandée, et le journal d'audit n'en garde qu'une mention.
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const store = new InMemoryTaskStore();
    const coordinator = new TaskCoordinator({
      registry: harness.registry,
      selector: harness.selector,
      router: harness.router,
      transport: harness.gateway,
      store,
    });

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Voir l'écran",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-capture",
      steps: [
        {
          id: "capture",
          description: "Capturer l'écran",
          requiredCapabilities: ["android.ui.screenshot"],
          tool: "device.android.ui.screenshot",
          arguments: {},
          riskLevel: "MEDIUM",
        },
      ],
    });

    const executed = await coordinator.execute(plan, { userPermissions: ANDROID_PERMISSIONS });
    expect(executed.status).toBe("succeeded");

    // Le client reçoit bien l'image…
    expect(JSON.stringify(executed.steps[0]?.result)).toContain("aW1hZ2UtZmFjdGljZQ==");

    // …et le journal d'exécution ne la contient pas.
    const executions = await store.listExecutions(plan.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.result).toBe(SENSITIVE_RESULT_PLACEHOLDER);
    expect(JSON.stringify(executions)).not.toContain("aW1hZ2UtZmFjdGljZQ==");
  });

  it("ne place jamais l'image dans un événement", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Voir l'écran",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-capture-evt",
      steps: [
        {
          id: "capture",
          description: "Capturer l'écran",
          requiredCapabilities: ["android.ui.screenshot"],
          tool: "device.android.ui.screenshot",
          arguments: {},
          riskLevel: "MEDIUM",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: ANDROID_PERMISSIONS });

    expect(JSON.stringify(harness.clientEvents)).not.toContain("aW1hZ2UtZmFjdGljZQ==");
    expect(harness.logger.text).not.toContain("aW1hZ2UtZmFjdGljZQ==");
  });

  it("le worker reste prêt après un plan échoué", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "com.android.settings" },
    });
    await settle(20);

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.activeTaskCount).toBe(0);
  });
});

describe("protocole de tâche", () => {
  it("refuse une capacité que le téléphone n'a pas", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { executable: "sh" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("refuse des arguments qui ne respectent pas le schéma", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, { arguments: { titre: "mauvais champ" } });
    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_INPUT_INVALID" } });
    expect(harness.platform.notifications.posted).toHaveLength(0);
  });

  it("n'exécute pas deux fois le même identifiant de requête", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const envelope = dispatchEnvelope();
    harness.link.deliver(envelope);
    await until(() => results(harness).length === 1);

    harness.link.deliver(envelope);
    await settle(30);

    expect(harness.platform.notifications.posted).toHaveLength(1);
    expect(results(harness)).toHaveLength(1);
  });

  it("refuse une étape de plus quand le téléphone est saturé", async () => {
    const harness = await makeHarness({
      config: { maxConcurrentTasks: 1 },
    });
    await harness.connectWorker();
    harness.platform.ui.hangUntilAborted = true;

    harness.link.deliver(
      dispatchEnvelope({
        capability: "android.ui.click",
        tool: "device.android.ui.click",
        arguments: { selector: { kind: "text", value: "Rechercher" } },
      }),
    );
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(dispatchEnvelope());
    await until(() => results(harness).length > 0);

    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "WORKER_SATURATED", retryable: true },
    });
  });

  it("annule une étape en cours sur ordre du cœur", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.platform.ui.hangUntilAborted = true;

    const envelope = dispatchEnvelope({
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "text", value: "Rechercher" } },
    });
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
    expect(results(harness)[0]?.ok).toBe(false);
  });

  it("libère l'étape côté cœur quand le téléphone disparaît", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.platform.ui.hangUntilAborted = true;

    const controller = new AbortController();
    const pending = harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "task-coupure",
      stepId: "step-1",
      tool: "device.android.ui.click",
      capability: "android.ui.click",
      arguments: { selector: { kind: "text", value: "Rechercher" } },
      timeoutMs: 60_000,
      signal: controller.signal,
      onProgress: () => undefined,
    });

    await until(() => harness.worker.activeTaskCount === 1);
    await harness.gateway.detach(harness.device.id, "réseau mobile perdu");

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKER_DISCONNECTED", retryable: true },
    });
  });
});
