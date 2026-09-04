import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import { settle } from "./harness.js";
import { GRANTED, bootFleet, planFor, runPlan, waitFor, type Fleet } from "./fleet.js";

/**
 * Validation de bout en bout.
 *
 * Sept scénarios, joués sur la flotte complète : iPhone, portable, poste fixe,
 * Redmi et le cœur. Le vrai code des cinq côtés — clients, exécutants,
 * coordinateur, sélecteur, confirmations. Voir `fleet.ts` pour ce qui est doublé
 * et ce qui ne l'est pas.
 *
 * **Une limite, dite d'emblée** : il n'y a pas de modèle de langage câblé. Les
 * scénarios partent du plan que la phrase française dénote, pas de la phrase.
 * Tout ce qui suit — sélection, autorisation, dispatch, exécution, progression,
 * notification, synchronisation — est réel.
 */

let fleet: Fleet;

beforeEach(async () => {
  fleet = await bootFleet();
});

afterEach(async () => {
  await fleet.close();
});

/** Les deux clients ont-ils convergé vers le même état d'une tâche ? */
async function bothClientsSee(taskId: string, status: string): Promise<void> {
  await waitFor(
    () =>
      fleet.iphone.state().tasks.find((task) => task.id === taskId)?.status === status &&
      fleet.laptop.state().tasks.find((task) => task.id === taskId)?.status === status,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E 1 — « Ouvre Chrome sur mon PC bureau et va sur Google. »
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 1 — depuis l'iPhone, ouvrir un navigateur sur le poste fixe", () => {
  it("traverse la chaîne complète et revient sur l'iPhone", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Ouvrir Chrome sur le poste fixe",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "ouvrir",
          description: "Ouvrir Google dans le navigateur",
          // Le sélecteur ne connaît que ça. Jamais un nom de machine.
          requiredCapabilities: ["browser.open"],
          tool: "device.browser.open",
          arguments: { url: "https://www.google.com" },
          // « sur mon PC bureau » devient une **préférence**, pondérée.
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "LOW",
        },
      ],
    });

    runPlan(fleet, plan);

    // 1. L'étape atteint le poste fixe — et lui seul.
    await waitFor(() => fleet.desktop.executed.length > 0);
    expect(fleet.desktop.executed[0]?.capability).toBe("browser.open");
    expect(fleet.desktop.executed[0]?.input).toMatchObject({ url: "https://www.google.com" });
    expect(fleet.laptopWorker.executed).toEqual([]);
    expect(fleet.redmi.executed).toEqual([]);

    // 2. L'iPhone voit la tâche aboutir.
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    const task = fleet.iphone.state().tasks[0];
    expect(task?.title).toBe("Ouvrir Chrome sur le poste fixe");
    // 3. Le fil de routage tient de bout en bout.
    expect(task?.originClientDeviceId).toBe(fleet.devices.iphone.device.id);
    // 4. L'iPhone sait **où** ça a tourné.
    expect(task?.workerDeviceId).toBe(fleet.devices.desktop.device.id);

    // 5. Et il reçoit la notification, produite au centre.
    await waitFor(() => fleet.iphone.state().notifications.length > 0);
    expect(fleet.iphone.state().notifications[0]?.title).toBeTruthy();
  });

  it("la préférence ne contourne pas la capacité", async () => {
    // Le point de sécurité du scénario. « Sur mon PC bureau » est une
    // préférence, pas un ordre : un appareil préféré qui ne sait pas faire reste
    // écarté. Sans cela, nommer une machine deviendrait un moyen de la faire
    // exécuter ce qu'elle n'a pas déclaré.
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Ouvrir une application Android",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "ouvrir",
          description: "Ouvrir une application",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { package: "com.google.android.youtube" },
          // L'utilisateur désigne le poste fixe, qui n'a pas cette capacité.
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.redmi.executed.length > 0);

    // Le Redmi a exécuté ; le poste fixe n'a rien vu.
    expect(fleet.redmi.executed[0]?.capability).toBe("android.app.open");
    expect(fleet.desktop.executed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 2 — « Ouvre YouTube sur mon Redmi. »
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 2 — depuis le portable, agir sur le Redmi", () => {
  it("atteint le téléphone et se synchronise sur l'iPhone", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Ouvrir YouTube sur le Redmi",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "youtube",
          description: "Ouvrir YouTube",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { package: "com.google.android.youtube" },
          riskLevel: "LOW",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(() => fleet.redmi.executed.length > 0);
    expect(fleet.redmi.executed[0]?.input).toMatchObject({
      package: "com.google.android.youtube",
    });

    // Le portable a lancé — et l'iPhone, qui n'a rien demandé, voit la même
    // tâche avec la même origine. C'est la synchronisation par le centre.
    await bothClientsSee(plan.id, "succeeded");

    const surIphone = fleet.iphone.state().tasks.find((task) => task.id === plan.id);
    expect(surIphone?.originClientDeviceId).toBe(fleet.devices.laptop.device.id);
    expect(surIphone?.workerDeviceId).toBe(fleet.devices.redmi.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 3 — « Lance mon projet et dis-moi quand le serveur est prêt. »
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 3 — démarrage d'un serveur, avec progression", () => {
  it("enchaîne lecture puis démarrage, et rapporte l'avancement", async () => {
    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          // Un démarrage de serveur n'est pas instantané : il rapporte.
          "process.start": (input, context) => {
            context.onProgress({ percent: 30, label: "installation des dépendances" });
            context.onProgress({ percent: 80, label: "compilation" });
            return Promise.resolve({ pid: 4242, port: 3000, ready: true, input });
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Lancer le projet sur le poste fixe",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "lire",
          description: "Lire la configuration du projet",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: "C:\\Projets\\leynai\\package.json" },
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "SAFE",
        },
        {
          id: "demarrer",
          description: "Démarrer le serveur de développement",
          requiredCapabilities: ["process.start"],
          tool: "device.process.start",
          arguments: { executable: "pnpm", args: ["dev"] },
          dependsOn: ["lire"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    const task = fleet.iphone.state().tasks[0];
    expect(task?.status).toBe("succeeded");
    expect(task?.percent).toBe(100);
    expect(task?.stepCount).toBe(2);

    // Les deux étapes ont bien tourné sur le poste fixe, dans l'ordre.
    expect(fleet.desktop.executed.map((entry) => entry.capability)).toEqual([
      "filesystem.read",
      "process.start",
    ]);

    // L'iPhone a été notifié de la fin — c'est le « dis-moi quand ».
    await waitFor(() => fleet.iphone.state().notifications.length > 0);
  });

  it("l'iPhone reçoit la progression pendant l'exécution", async () => {
    // Le point du scénario : l'utilisateur regarde son téléphone et veut savoir
    // où ça en est, pas seulement quand c'est fini.
    const progressions = fleet.iphone.actions.filter(
      (action) => action.kind === "server" && action.type === SERVER_TO_CLIENT.taskProgress,
    );
    expect(progressions).toHaveLength(0);

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Étapes successives",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "a",
          description: "Première",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "SAFE",
        },
        {
          id: "b",
          description: "Seconde",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          dependsOn: ["a"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    const recues = fleet.iphone.actions.filter(
      (action) => action.kind === "server" && action.type === SERVER_TO_CLIENT.taskProgress,
    );
    expect(recues.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 4 — « Lance les tests sur mon PC portable. »
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 4 — l'iPhone fait exécuter le portable", () => {
  it("le portable exécute et l'iPhone reçoit le résultat", async () => {
    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        laptop: {
          "terminal.execute": (input) =>
            Promise.resolve({ exitCode: 0, stdout: "1072 tests passés", input }),
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Lancer les tests sur le portable",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "tests",
          description: "Exécuter la suite de tests",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          arguments: { executable: "pnpm", args: ["test"] },
          preferredDeviceId: fleet.devices.laptop.device.id,
          riskLevel: "LOW",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(() => fleet.laptopWorker.executed.length > 0);
    expect(fleet.laptopWorker.executed[0]?.input).toMatchObject({ executable: "pnpm" });

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");
    expect(fleet.iphone.state().tasks[0]?.workerDeviceId).toBe(fleet.devices.laptop.device.id);

    // Le résultat est bien celui qu'a produit la machine, consigné au centre.
    const executions = await fleet.harness.services.taskStore.listExecutions(plan.id);
    expect(executions[0]?.result).toMatchObject({ exitCode: 0 });
  });

  it("le portable est client et exécutant en même temps", () => {
    // Deux canaux, deux secrets, une seule ligne d'appareil.
    expect(fleet.laptop.realtime.state).toBe("connected");
    expect(fleet.harness.services.gateway.isConnected(fleet.devices.laptop.device.id)).toBe(true);
    expect(fleet.harness.app.clientChannel.connectedDeviceIds).toContain(
      fleet.devices.laptop.device.id,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 5 — Deux machines, une dépendance
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 5 — plan multi-machines avec dépendance", () => {
  it("télécharge sur le poste fixe puis ouvre sur le Redmi, dans cet ordre", async () => {
    const ordre: string[] = [];

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          "git.clone": () => {
            ordre.push("desktop");
            return Promise.resolve({ cloned: true });
          },
        },
        redmi: {
          "android.app.open": () => {
            ordre.push("redmi");
            return Promise.resolve({ opened: true });
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Télécharger puis ouvrir",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "telecharger",
          description: "Cloner le projet",
          requiredCapabilities: ["git.clone"],
          tool: "device.git.clone",
          arguments: { url: "https://exemple.fr/projet.git" },
          riskLevel: "SAFE",
        },
        {
          id: "ouvrir",
          description: "Ouvrir l'application sur le téléphone",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { package: "fr.exemple.app" },
          dependsOn: ["telecharger"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => ordre.length === 2);

    // La dépendance est respectée : la seconde étape n'a pas démarré avant que
    // la première n'aboutisse, et elles sont sur deux machines différentes.
    expect(ordre).toEqual(["desktop", "redmi"]);

    // Le sélecteur a choisi chaque machine sur sa capacité, sans qu'on la nomme.
    const executed = await fleet.harness.services.taskStore.listExecutions(plan.id);
    const parEtape = new Map(executed.map((entry) => [entry.stepId, entry.deviceId]));
    expect(parEtape.get("telecharger")).toBe(fleet.devices.desktop.device.id);
    expect(parEtape.get("ouvrir")).toBe(fleet.devices.redmi.device.id);
  });

  it("les deux résultats se synchronisent sur l'iPhone et le portable", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Deux machines",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "telecharger",
          description: "Cloner",
          requiredCapabilities: ["git.clone"],
          tool: "device.git.clone",
          riskLevel: "SAFE",
        },
        {
          id: "ouvrir",
          description: "Ouvrir",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          dependsOn: ["telecharger"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await bothClientsSee(plan.id, "succeeded");

    // Même identifiant, même origine, des deux côtés.
    const surIphone = fleet.iphone.state().tasks.find((task) => task.id === plan.id);
    const surPortable = fleet.laptop.state().tasks.find((task) => task.id === plan.id);

    expect(surIphone?.originClientDeviceId).toBe(fleet.devices.laptop.device.id);
    expect(surPortable?.originClientDeviceId).toBe(fleet.devices.laptop.device.id);
    expect(surIphone?.stepCount).toBe(surPortable?.stepCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 6 — Déconnexion en cours d'exécution
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 6 — le poste fixe tombe pendant l'exécution", () => {
  it("bascule sur une autre machine plutôt que d'échouer en silence", async () => {
    // Deux machines savent lire un fichier : le poste fixe et le portable. Le
    // poste fixe est préféré, il tombe, et la tâche doit finir ailleurs.
    let libere: (() => void) | undefined;
    const bloque = new Promise<void>((resolve) => {
      libere = resolve;
    });

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          // Ne rend jamais la main : la machine est occupée quand le câble tombe.
          "filesystem.read": async () => {
            await bloque;
            return { content: "jamais rendu" };
          },
        },
        laptop: {
          "filesystem.read": () => Promise.resolve({ content: "lu par le portable" }),
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Lecture avec bascule",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "lire",
          description: "Lire un fichier",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          preferredDeviceId: fleet.devices.desktop.device.id,
          retry: { attempts: 2, failoverToAnotherDevice: true },
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);

    // L'étape part bien sur le poste fixe.
    await waitFor(() => fleet.desktop.executed.length > 0);
    expect(fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id)).toBe(true);

    // Le câble tombe.
    fleet.desktop.disconnect("câble débranché");
    await settle(40);

    // 1. NEXUS détecte la déconnexion.
    await waitFor(
      () => !fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id),
    );

    // 2. L'étape en vol est résolue **réessayable**, et bascule sur le portable.
    await waitFor(() => fleet.laptopWorker.executed.length > 0);

    // 3. La tâche aboutit ; l'utilisateur n'est pas laissé sans réponse.
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");
    expect(fleet.iphone.state().tasks[0]?.workerDeviceId).toBe(fleet.devices.laptop.device.id);

    libere?.();
  });

  it("sans repli possible, l'échec est explicite et notifié", async () => {
    // Aucune bascule silencieuse, mais aucun silence non plus : quand plus
    // personne ne sait faire, l'utilisateur doit l'apprendre.
    let libere: (() => void) | undefined;
    const bloque = new Promise<void>((resolve) => {
      libere = resolve;
    });

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        redmi: {
          "android.app.open": async () => {
            await bloque;
            return { opened: true };
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Ouvrir sur le seul téléphone",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "ouvrir",
          description: "Ouvrir une application",
          // Seul le Redmi sait faire : il n'existe pas de repli.
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          retry: { attempts: 1 },
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.redmi.executed.length > 0);

    fleet.redmi.disconnect("téléphone éteint");
    await settle(40);

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "failed");

    const task = fleet.iphone.state().tasks[0];
    expect(task?.status).toBe("failed");
    expect(task?.error).not.toBeNull();

    // Et une notification part — pas de défaillance muette.
    await waitFor(() => fleet.iphone.state().notifications.length > 0);
    expect(fleet.iphone.state().notifications[0]?.severity).toBe("error");

    libere?.();
  });

  it("un exécutant qui revient se réauthentifie entièrement", async () => {
    fleet.desktop.disconnect("coupure réseau");
    await settle(40);
    expect(fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id)).toBe(false);

    // Une session dont on ne sait pas si elle est encore valide n'est pas une
    // session : la reprise refait la poignée de main complète, signature
    // comprise.
    await fleet.desktop.runtime.start();
    await waitFor(() =>
      fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id),
    );

    expect(fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 7 — Opération à risque élevé
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 7 — une action HIGH attend un humain", () => {
  beforeEach(async () => {
    await fleet.close();
    fleet = await bootFleet({ confirmationThreshold: "HIGH" });
  });

  it("rien ne s'exécute avant l'approbation", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Écrire dans un fichier",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "ecrire",
          description: "Écraser le fichier de configuration",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          arguments: { path: "C:\\Projets\\config.json", content: "{}" },
          riskLevel: "HIGH",
        },
      ],
    });

    runPlan(fleet, plan);

    // La demande arrive sur l'appareil d'origine.
    await waitFor(() => fleet.iphone.state().confirmations.length > 0);

    const demande = fleet.iphone.state().confirmations[0];
    expect(demande?.riskLevel).toBe("HIGH");
    expect(demande?.description).toContain("configuration");

    // Et **rien** n'a été exécuté.
    await settle(40);
    expect(fleet.desktop.executed).toEqual([]);
    expect(fleet.laptopWorker.executed).toEqual([]);

    // L'approbation débloque.
    await fleet.harness.services.confirmationBroker.respondAndRecord(
      demande?.id ?? "",
      "approved",
      fleet.account.userId,
    );

    await waitFor(() => fleet.desktop.executed.length + fleet.laptopWorker.executed.length > 0);
  });

  it("la demande apparaît aussi sur l'autre client, l'origine restant marquée", async () => {
    // Une confirmation demandée pendant qu'on est sur l'iPhone peut être
    // approuvée depuis le portable : la demande vit au centre.
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Action risquée",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "ecrire",
          description: "Écrire",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "CRITICAL",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(
      () =>
        fleet.iphone.state().confirmations.length > 0 &&
        fleet.laptop.state().confirmations.length > 0,
    );

    const surIphone = fleet.iphone.state().confirmations[0];
    const surPortable = fleet.laptop.state().confirmations[0];
    expect(surIphone?.id).toBe(surPortable?.id);

    // L'origine est préservée sur la tâche : l'interface sait où mettre la
    // demande en avant.
    await waitFor(() => fleet.iphone.state().tasks.length > 0);
    expect(fleet.iphone.state().tasks[0]?.originClientDeviceId).toBe(
      fleet.devices.iphone.device.id,
    );
  });

  it("un refus n'exécute rien", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Action refusée",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "ecrire",
          description: "Écrire",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.iphone.state().confirmations.length > 0);

    await fleet.harness.services.confirmationBroker.respondAndRecord(
      fleet.iphone.state().confirmations[0]?.id ?? "",
      "rejected",
      fleet.account.userId,
    );

    // Un refus **annule** l'étape ; une confirmation expirée, elle, la fait
    // échouer. La distinction compte : « j'ai dit non » et « personne n'a
    // répondu » n'appellent pas la même relance.
    // Le client **voit** l'annulation : sans le message `task.cancelled`, la
    // carte resterait « en cours » indéfiniment sur tous les appareils.
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "cancelled", {
      label: "tâche annulée après refus",
    });

    expect(fleet.desktop.executed).toEqual([]);
    expect(fleet.laptopWorker.executed).toEqual([]);
  });

  it("une action ordinaire ne demande rien", async () => {
    // Le seuil doit trancher, pas tout arrêter : demander une confirmation pour
    // chaque lecture apprendrait à approuver sans lire.
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Lecture ordinaire",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "lire",
          description: "Lire",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    expect(fleet.iphone.state().confirmations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation finale — les points de la liste
// ─────────────────────────────────────────────────────────────────────────────

describe("validation finale", () => {
  it("les quatre appareils sont dans la flotte, avec leurs rôles", async () => {
    const devices = await fleet.harness.services.deviceRegistry.listDevices(fleet.account.userId);
    const parNom = new Map(devices.map((device) => [device.name, device]));

    expect(parNom.get("iPhone 17")?.role).toBe("CLIENT");
    expect(parNom.get("Portable Windows")?.role).toBe("BOTH");
    expect(parNom.get("Poste fixe Windows")?.role).toBe("WORKER");
    expect(parNom.get("Redmi Note 10S")?.role).toBe("WORKER");
  });

  it("les capacités sont résolues depuis les exécutants, pas déclarées au cœur", async () => {
    const devices = await fleet.harness.services.deviceRegistry.listDevices(fleet.account.userId);
    const redmi = devices.find((device) => device.name === "Redmi Note 10S");

    // Elles viennent de la trame `worker.register` du téléphone.
    expect(redmi?.capabilities.map((capability) => capability.name).sort()).toEqual(
      [...(["android.app.open", "android.app.list", "android.notification"] as const)].sort(),
    );
  });

  it("le cœur ne connaît aucun appareil par son nom", async () => {
    // La propriété d'architecture, vérifiée depuis l'extérieur : renommer une
    // machine ne change rien à ce qu'elle exécute.
    await fleet.harness.services.deviceRegistry.updateDevice(fleet.devices.redmi.device.id, {
      name: "Téléphone renommé",
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Après renommage",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "ouvrir",
          description: "Ouvrir",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.redmi.executed.length > 0);
    expect(fleet.redmi.executed).toHaveLength(1);
  });

  it("une capacité non accordée ne quitte jamais le cœur", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Capacité interdite",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "interdit",
          description: "Faire quelque chose d'interdit",
          requiredCapabilities: ["docker.execute"],
          tool: "device.docker.execute",
          riskLevel: "SAFE",
        },
      ],
    });

    // Le superviseur reçoit des permissions qui **ne contiennent pas** la
    // capacité : c'est ce que ferait la route après le contrôle d'autorisation.
    fleet.harness.services.supervisor.start(
      plan,
      GRANTED.filter((permission) => permission !== "docker.execute"),
    );

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "failed");
    expect(fleet.desktop.executed).toEqual([]);
    expect(fleet.redmi.executed).toEqual([]);
    expect(fleet.laptopWorker.executed).toEqual([]);
  });

  it("une tâche s'annule depuis n'importe quel client", async () => {
    let libere: (() => void) | undefined;
    const bloque = new Promise<void>((resolve) => {
      libere = resolve;
    });

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          "process.start": async () => {
            await bloque;
            return { started: true };
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Longue tâche",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "long",
          description: "Démarrer un serveur",
          requiredCapabilities: ["process.start"],
          tool: "device.process.start",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.desktop.executed.length > 0);

    // Lancée depuis l'iPhone, annulée depuis le portable.
    const resultat = await fleet.laptop.realtime.cancelTask(plan.id);
    expect(resultat.cancelled).toBe(true);

    libere?.();
  });

  it("un client déconnecté rattrape son retard", async () => {
    fleet.iphone.realtime.stop("écran verrouillé");
    await settle();

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Pendant l'absence de l'iPhone",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "lire",
          description: "Lire",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.laptop.state().tasks.length > 0);

    // Le téléphone ressort de la poche : il doit voir ce qu'il a manqué.
    await fleet.iphone.realtime.start();
    await waitFor(() => fleet.iphone.state().tasks.length > 0);

    expect(fleet.iphone.state().tasks[0]?.title).toBe("Pendant l'absence de l'iPhone");
  });
});
