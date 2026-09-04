import { describe, expect, it, vi } from "vitest";
import { InvalidTaskPlanError } from "../src/errors.js";
import {
  createTaskPlan,
  derivePlanStatus,
  planProgress,
  readySteps,
  type TaskPlan,
} from "../src/tasks.js";
import { InMemoryTaskStore, TaskCoordinator, type ConfirmationGate } from "../src/coordinator.js";
import {
  ALL_PERMISSIONS,
  DESKTOP,
  FakeTransport,
  IPHONE,
  LAPTOP,
  REDMI,
  USER_ID,
  makeClient,
  makeHarness,
  setupFleet,
} from "./fixtures.js";

/**
 * Plans multi-étapes, routage vers le client d'origine, synchronisation.
 *
 * Le scénario de référence de l'architecture produit y figure en entier :
 * le poste fixe clone un dépôt, le portable lance les tests, l'Android notifie —
 * pendant que l'iPhone, d'où part la demande, voit tout arriver.
 */

function planFor(originClientDeviceId: string): TaskPlan {
  return createTaskPlan({
    userId: USER_ID,
    title: "Cloner, tester, notifier",
    originClientDeviceId,
    correlationId: "corr-1",
    steps: [
      {
        id: "clone",
        description: "Cloner le dépôt LeynAI",
        requiredCapabilities: ["git.execute"],
        tool: "device.git.execute",
        arguments: { command: "clone" },
        riskLevel: "LOW",
      },
      {
        id: "test",
        description: "Lancer les tests",
        requiredCapabilities: ["terminal.execute"],
        tool: "device.terminal.execute",
        arguments: { command: "pnpm test" },
        dependsOn: ["clone"],
        riskLevel: "LOW",
      },
      {
        id: "notify",
        description: "Notifier le résultat",
        requiredCapabilities: ["android.notification"],
        tool: "device.android.notification",
        arguments: { title: "Tests" },
        dependsOn: ["test"],
        riskLevel: "LOW",
      },
    ],
  });
}

function makeCoordinator(
  h: ReturnType<typeof makeHarness>,
  transport: FakeTransport,
  gate?: ConfirmationGate,
) {
  return new TaskCoordinator({
    registry: h.registry,
    selector: h.selector,
    router: h.router,
    transport,
    ...(gate ? { confirmations: gate } : {}),
    now: () => h.clock.now,
  });
}

describe("plan de tâche", () => {
  it("refuse une dépendance vers une étape inexistante", () => {
    expect(() =>
      createTaskPlan({
        userId: USER_ID,
        title: "x",
        originClientDeviceId: IPHONE.id,
        correlationId: "c",
        steps: [
          {
            id: "a",
            description: "a",
            requiredCapabilities: ["x.y"],
            tool: "t",
            dependsOn: ["fantome"],
          },
        ],
      }),
    ).toThrow(InvalidTaskPlanError);
  });

  it("refuse un cycle de dépendances", () => {
    const error = (() => {
      try {
        createTaskPlan({
          userId: USER_ID,
          title: "x",
          originClientDeviceId: IPHONE.id,
          correlationId: "c",
          steps: [
            {
              id: "a",
              description: "a",
              requiredCapabilities: ["x.y"],
              tool: "t",
              dependsOn: ["b"],
            },
            {
              id: "b",
              description: "b",
              requiredCapabilities: ["x.y"],
              tool: "t",
              dependsOn: ["a"],
            },
          ],
        });
      } catch (e: unknown) {
        return e;
      }
      return undefined;
    })();

    // Mieux vaut refuser un plan incohérent que le découvrir bloqué à mi-parcours.
    expect(error).toBeInstanceOf(InvalidTaskPlanError);
    expect((error as InvalidTaskPlanError).details.join(" ")).toContain("cycle");
  });

  it("ne rend prêtes que les étapes dont les dépendances ont abouti", () => {
    const plan = planFor(IPHONE.id);
    expect(readySteps(plan).map((s) => s.id)).toEqual(["clone"]);

    const afterClone: TaskPlan = {
      ...plan,
      steps: plan.steps.map((s) => (s.id === "clone" ? { ...s, status: "succeeded" as const } : s)),
    };
    expect(readySteps(afterClone).map((s) => s.id)).toEqual(["test"]);
  });

  it("déduit un état partiel quand tout est terminé sans tout réussir", () => {
    const plan = planFor(IPHONE.id);
    const mixed: TaskPlan = {
      ...plan,
      steps: [
        { ...plan.steps[0]!, status: "succeeded" },
        { ...plan.steps[1]!, status: "failed" },
        { ...plan.steps[2]!, status: "skipped" },
      ],
    };

    // L'utilisateur doit savoir ce qui a été fait malgré l'échec.
    expect(derivePlanStatus(mixed)).toBe("partial");
    expect(planProgress(mixed)).toBe(100);
  });
});

describe("exécution répartie", () => {
  it("répartit les étapes selon les capacités, sans nommer d'appareil", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();

    const result = await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("succeeded");

    // Le clonage et les tests partent sur un poste Windows, la notification sur
    // l'Android — parce que ce sont les seuls à déclarer ces capacités.
    const notifyDevice = transport.deviceFor("device.android.notification");
    expect(notifyDevice).toBe(REDMI.id);
    expect([DESKTOP.id, LAPTOP.id]).toContain(transport.deviceFor("device.git.execute"));
    expect([DESKTOP.id, LAPTOP.id]).toContain(transport.deviceFor("device.terminal.execute"));
  });

  it("respecte l'ordre imposé par les dépendances", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();

    await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(transport.dispatched.map((d) => d.tool)).toEqual([
      "device.git.execute",
      "device.terminal.execute",
      "device.android.notification",
    ]);
  });

  it("saute les étapes dont une dépendance a échoué", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();
    transport.responses.set("device.terminal.execute", {
      ok: false,
      error: { code: "TESTS_FAILED", message: "3 tests en échec", retryable: false },
    });

    const result = await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("partial");
    expect(result.steps.map((s) => s.status)).toEqual(["succeeded", "failed", "skipped"]);
    // La notification n'a jamais été dispatchée.
    expect(transport.deviceFor("device.android.notification")).toBeUndefined();
  });

  it("bascule sur un autre appareil après un échec réessayable", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });
    const transport = new FakeTransport();
    transport.failuresBeforeSuccess.set("device.git.execute", 1);

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "clone",
      originClientDeviceId: LAPTOP.id,
      correlationId: "c",
      steps: [
        {
          id: "clone",
          description: "Cloner",
          requiredCapabilities: ["git.execute"],
          tool: "device.git.execute",
          riskLevel: "LOW",
          retry: { attempts: 2, failoverToAnotherDevice: true },
        },
      ],
    });

    const result = await makeCoordinator(h, transport).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("succeeded");
    expect(transport.dispatched).toHaveLength(2);
    // Réessayer chez celui qui vient d'échouer n'aurait servi à rien.
    expect(transport.dispatched[0]?.deviceId).not.toBe(transport.dispatched[1]?.deviceId);
  });

  it("refuse d'exécuter une capacité que l'appareil n'a plus", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    const transport = new FakeTransport();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "docker",
      originClientDeviceId: LAPTOP.id,
      correlationId: "c",
      steps: [
        {
          id: "run",
          description: "Lancer un conteneur",
          requiredCapabilities: ["docker.execute"],
          tool: "device.docker.execute",
          riskLevel: "LOW",
        },
      ],
    });

    // La capacité disparaît entre la construction du plan et l'exécution.
    await h.registry.updateCapabilities(DESKTOP.id, []);

    const result = await makeCoordinator(h, transport).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0]?.error?.code).toBe("NO_ELIGIBLE_WORKER");
    expect(transport.dispatched).toHaveLength(0);
  });

  it("échoue proprement quand un appareil révoqué était le seul candidat", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [REDMI] });
    await h.registry.revokeDevice(REDMI.id);
    const transport = new FakeTransport();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "notifier",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "notify",
          description: "Notifier",
          requiredCapabilities: ["android.notification"],
          tool: "device.android.notification",
          riskLevel: "LOW",
        },
      ],
    });

    const result = await makeCoordinator(h, transport).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("failed");
    expect(transport.dispatched).toHaveLength(0);
    expect(result.steps[0]?.error?.message).toContain("révoqué");
  });
});

describe("client d'origine", () => {
  it("conserve l'origine pendant toute la vie de la tâche", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();

    const result = await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    // La tâche s'exécute sur trois autres appareils ; l'origine ne bouge pas.
    expect(result.originClientDeviceId).toBe(IPHONE.id);
    expect(new Set(transport.dispatched.map((d) => d.deviceId)).has(IPHONE.id)).toBe(false);
  });

  it("marque chaque événement de l'appareil d'origine", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    await h.router.attach(iphone);

    await makeCoordinator(h, new FakeTransport()).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(iphone.received.length).toBeGreaterThan(0);
    expect(iphone.received.every((e) => e.originClientDeviceId === IPHONE.id)).toBe(true);
  });

  it("route vers le portable quand la tâche en vient", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(laptop);

    const result = await makeCoordinator(h, new FakeTransport()).execute(planFor(LAPTOP.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.originClientDeviceId).toBe(LAPTOP.id);
    expect(laptop.received.every((e) => e.originClientDeviceId === LAPTOP.id)).toBe(true);
  });
});

describe("synchronisation entre clients", () => {
  it("diffuse à tous les clients, pas seulement à l'origine", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(iphone);
    await h.router.attach(laptop);

    // Tâche lancée depuis le portable…
    await makeCoordinator(h, new FakeTransport()).execute(planFor(LAPTOP.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    // …l'iPhone la voit quand même.
    const iphoneTypes = iphone.received.map((e) => e.type);
    expect(iphoneTypes).toContain("task.created");
    expect(iphoneTypes).toContain("task.completed");
    expect(iphone.received).toHaveLength(laptop.received.length);
  });

  it("ne diffuse jamais un événement à un exécutant pur", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const desktop = makeClient(DESKTOP.id);
    await h.router.attach(desktop);

    await makeCoordinator(h, new FakeTransport()).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    // Le poste fixe exécute ; il n'affiche rien, il ne reçoit donc rien.
    expect(desktop.received).toHaveLength(0);
  });

  it("met en file pour un client déconnecté et lui livre au retour", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(laptop);

    // L'iPhone est éteint pendant l'exécution.
    await makeCoordinator(h, new FakeTransport()).execute(planFor(LAPTOP.id), {
      userPermissions: ALL_PERMISSIONS,
    });
    expect(h.router.pendingFor(IPHONE.id).length).toBeGreaterThan(0);

    const iphone = makeClient(IPHONE.id);
    const backlog = await h.router.attach(iphone);

    // Il retrouve exactement le même état que le portable resté connecté.
    expect(backlog.length).toBe(laptop.received.length);
    expect(iphone.received.map((e) => e.type)).toEqual(laptop.received.map((e) => e.type));
    expect(h.router.pendingFor(IPHONE.id)).toHaveLength(0);
  });

  it("livre l'appareil d'origine en premier", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const order: string[] = [];
    const iphone = { ...makeClient(IPHONE.id), send: () => void order.push(IPHONE.id) };
    const laptop = { ...makeClient(LAPTOP.id), send: () => void order.push(LAPTOP.id) };

    await h.router.attach(laptop);
    await h.router.attach(iphone);

    await h.router.emit({
      type: "task.started",
      userId: USER_ID,
      correlationId: "c",
      originClientDeviceId: IPHONE.id,
      payload: { taskId: "t1" },
    });

    // L'utilisateur regarde l'appareil d'où il a lancé la demande.
    expect(order[0]).toBe(IPHONE.id);
  });
});

describe("confirmations", () => {
  it("route la demande vers l'origine et n'exécute qu'après accord", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    await h.router.attach(iphone);

    const transport = new FakeTransport();
    const request = vi.fn().mockResolvedValue("approved");
    const gate: ConfirmationGate = { request };

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "supprimer",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "rm",
          description: "Supprimer le dossier build",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    const result = await makeCoordinator(h, transport, gate).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("succeeded");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ originClientDeviceId: IPHONE.id, riskLevel: "HIGH" }),
    );

    const required = iphone.received.find((e) => e.type === "confirmation.required");
    expect(required).toBeDefined();
    expect(required?.originClientDeviceId).toBe(IPHONE.id);
  });

  it("n'exécute rien si l'utilisateur refuse", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();
    const gate: ConfirmationGate = { request: vi.fn().mockResolvedValue("rejected") };

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "supprimer",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "rm",
          description: "Supprimer",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    const result = await makeCoordinator(h, transport, gate).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("cancelled");
    expect(transport.dispatched).toHaveLength(0);
  });

  it("ne demande rien pour une étape à faible risque", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const request = vi.fn().mockResolvedValue("approved");
    const gate: ConfirmationGate = { request };

    await makeCoordinator(h, new FakeTransport(), gate).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    // Les trois étapes du plan sont en LOW : aucune n'atteint le seuil.
    expect(request).not.toHaveBeenCalled();
  });

  it("les deux clients voient la demande, l'un ou l'autre peut trancher", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(iphone);
    await h.router.attach(laptop);

    const gate: ConfirmationGate = { request: vi.fn().mockResolvedValue("approved") };
    const plan = createTaskPlan({
      userId: USER_ID,
      title: "écrire",
      originClientDeviceId: LAPTOP.id,
      correlationId: "c",
      steps: [
        {
          id: "w",
          description: "Écrire un fichier",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    await makeCoordinator(h, new FakeTransport(), gate).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    // L'iPhone reçoit une demande partie du portable : il peut l'approuver.
    expect(iphone.received.some((e) => e.type === "confirmation.required")).toBe(true);
    expect(laptop.received.some((e) => e.type === "confirmation.required")).toBe(true);
  });
});

describe("secrets dans le journal d'exécution", () => {
  it("rédige les arguments avant de les consigner", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const store = new InMemoryTaskStore();
    const transport = new FakeTransport();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "déployer",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "deploy",
          description: "Déployer",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          arguments: { command: "deploy", apiKey: "sk-abcdefghijklmnopqrstuvwxyz" },
          riskLevel: "LOW",
        },
      ],
    });

    await new TaskCoordinator({
      registry: h.registry,
      selector: h.selector,
      router: h.router,
      transport,
      store,
      now: () => h.clock.now,
    }).execute(plan, { userPermissions: ALL_PERMISSIONS });

    const executions = await store.listExecutions(plan.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.input).toEqual({ command: "deploy", apiKey: "[REDACTED]" });
    expect(JSON.stringify(executions)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");

    // Le worker, lui, reçoit bien la valeur réelle : la rédaction protège le
    // journal, pas l'exécution.
    expect(transport.dispatched[0]?.arguments).toMatchObject({
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
    });
  });
});
