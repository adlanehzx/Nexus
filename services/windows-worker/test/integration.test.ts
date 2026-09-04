import { describe, expect, it } from "vitest";
import { createTaskPlan } from "@nexus/devices";
import { makeHarness, until, ALLOWED_ROOT, IPHONE, USER_ID } from "./fixtures.js";

/**
 * Le chemin complet, de bout en bout.
 *
 *     client (iPhone) → TaskCoordinator → DeviceSelector → WorkerTransport
 *       → worker Windows → capacité → événements → EventRouter → client
 *
 * Rien n'est simulé sur ce chemin : ce sont le vrai coordinateur, le vrai
 * sélecteur, la vraie passerelle et le vrai worker. Seuls le transport réseau
 * (remplacé par un canal en mémoire) et les appels système sont doublés.
 *
 * C'est ce test qui justifie que le WebSocket de la phase suivante soit un
 * simple adaptateur : tout ce qu'il portera est déjà éprouvé ici.
 */

const PERMISSIONS = [
  "terminal.execute",
  "filesystem.read",
  "filesystem.write",
  "git.status",
  "git.diff",
];

describe("chaîne complète", () => {
  it("exécute un plan lancé depuis l'iPhone sur le poste Windows", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\leynai\\README.md`, "# LeynAI");
      },
    });
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Lire le README du projet",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-integration",
      steps: [
        {
          id: "lire",
          description: "Lire le README",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\leynai\\README.md` },
          riskLevel: "SAFE",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    expect(executed.status).toBe("succeeded");
    expect(executed.steps[0]?.selectedDeviceId).toBe(harness.device.id);
    expect((executed.steps[0]?.result as { content: string }).content).toBe("# LeynAI");
  });

  it("ramène tous les événements à l'appareil d'origine", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\notes.txt`, "ok");
      },
    });
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Lecture",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-evt",
      steps: [
        {
          id: "lire",
          description: "Lire les notes",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\notes.txt` },
          riskLevel: "SAFE",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    const types = harness.clientEvents.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.started",
        "worker.task_started",
        "worker.task_completed",
        "task.completed",
      ]),
    );

    // Tout ce qui relève de la tâche porte le fil de routage jusqu'au client
    // d'origine. Les événements de cycle de vie du worker — connexion,
    // disponibilité — n'en relèvent pas : ils décrivent la flotte, pas une
    // demande, et leur origine est légitimement nulle.
    const taskEvents = harness.clientEvents.filter(
      (event) => event.type.startsWith("task.") || event.type.startsWith("worker.task_"),
    );
    expect(taskEvents.length).toBeGreaterThan(0);
    for (const event of taskEvents) {
      expect(event.originClientDeviceId).toBe(IPHONE.id);
    }
  });

  it("le sélecteur ne choisit le poste Windows que sur ses capacités", async () => {
    // La consigne d'architecture : jamais « si la tâche contient X, prendre le
    // poste fixe ». Le plan ne nomme aucun appareil ; le rapprochement se fait
    // uniquement sur `requiredCapabilities`.
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const selection = await harness.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.status"],
      userPermissions: PERMISSIONS,
    });

    expect(selection.device.id).toBe(harness.device.id);
    // L'iPhone est bien candidat connu, mais écarté : il est CLIENT.
    expect(selection.rejected.map((r) => r.deviceId)).toContain(IPHONE.id);
  });

  it("échoue proprement quand la capacité n'existe nulle part", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Notifier sur Android",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-absent",
      steps: [
        {
          id: "notifier",
          description: "Notifier",
          requiredCapabilities: ["android.notification"],
          tool: "device.android.notification",
          arguments: { title: "x", body: "y" },
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    expect(executed.status).toBe("failed");
    // L'échec survient à la **sélection**, avant tout dispatch : aucun
    // exécutant ne déclare cette capacité. C'est donc `task.failed` que le
    // client reçoit, pas `worker.task_failed` — la distinction dit à
    // l'utilisateur qu'aucun appareil ne sait faire, et non qu'un appareil a
    // essayé et échoué.
    const types = harness.clientEvents.map((event) => event.type);
    expect(types).toContain("task.failed");
    expect(types).not.toContain("worker.task_started");
  });

  it("remonte au client un refus de politique locale", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Lire un fichier interdit",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-refus",
      steps: [
        {
          id: "lire",
          description: "Lire les identifiants AWS",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: "C:\\Users\\moi\\.aws\\credentials" },
          riskLevel: "SAFE",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    expect(executed.status).toBe("failed");
    expect(executed.steps[0]?.error?.code).toBe("PATH_NOT_ALLOWED");

    // Le message qui atteint le client ne révèle pas l'arborescence.
    const failure = harness.clientEvents.find((e) => e.type === "worker.task_failed");
    expect(JSON.stringify(failure)).not.toContain(".aws");
  });

  it("enchaîne plusieurs étapes sur le même exécutant", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\source.txt`, "contenu");
      },
    });
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Lire puis écrire",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-chaine",
      steps: [
        {
          id: "lire",
          description: "Lire la source",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\source.txt` },
          riskLevel: "SAFE",
        },
        {
          id: "ecrire",
          description: "Écrire la copie",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          arguments: { path: `${ALLOWED_ROOT}\\copie.txt`, content: "copie" },
          dependsOn: ["lire"],
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: PERMISSIONS,
    });

    expect(executed.status).toBe("succeeded");
    expect(harness.fileSystem.files.get(`${ALLOWED_ROOT}\\copie.txt`)).toBe("copie");
  });

  it("consigne les arguments rédigés dans le journal d'exécution du cœur", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Écrire un fichier de configuration",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-secret",
      steps: [
        {
          id: "ecrire",
          description: "Écrire la configuration",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          arguments: {
            path: `${ALLOWED_ROOT}\\config.json`,
            content: "{}",
            apiKey: "sk-doitdisparaitre12345",
          },
          riskLevel: "LOW",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    // Ni dans les événements du client, ni dans le journal du worker.
    expect(JSON.stringify(harness.clientEvents)).not.toContain("sk-doitdisparaitre12345");
    expect(harness.logger.text).not.toContain("sk-doitdisparaitre12345");
  });

  it("le worker reste prêt après un plan échoué", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Échec attendu",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-apres",
      steps: [
        {
          id: "lire",
          description: "Lire ailleurs",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: "C:\\Windows\\win.ini" },
          riskLevel: "SAFE",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });
    await until(() => harness.worker.activeTaskCount === 0);

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.activeTaskCount).toBe(0);
  });
});
