import { describe, expect, it } from "vitest";
import { localWorkerStatus, remoteWorkers, type ObservedDevice } from "../src/lib/worker-status.js";

/**
 * L'exécutant local, vu depuis la fenêtre.
 *
 * Ce que ces tests fixent : l'interface décrit la machine **d'après le cœur**,
 * jamais d'après le démon qui tourne à côté. Toutes les entrées viennent donc
 * d'une liste d'appareils telle que le backend la renvoie.
 */

const PORTABLE = "device-portable";

function device(patch: Partial<ObservedDevice> = {}): ObservedDevice {
  return {
    id: PORTABLE,
    name: "Portable Windows",
    role: "BOTH",
    status: "ONLINE",
    capabilities: ["terminal.execute", "filesystem.read"],
    health: { activeTasks: 0, maxConcurrentTasks: 2 },
    ...patch,
  };
}

describe("détection", () => {
  it("annonce l'absence d'exécutant plutôt que de l'inventer", () => {
    const statut = localWorkerStatus({ localWorkerDeviceId: null, devices: [device()] });

    expect(statut.state).toBe("absent");
    expect(statut.deviceId).toBeNull();
    expect(statut.acceptingTasks).toBe(false);
  });

  it("distingue « démon installé » de « appareil connu du cœur »", () => {
    // Cas réel du premier démarrage : le démon existe sur le disque, mais
    // l'appairage n'a pas eu lieu. Afficher « hors ligne » enverrait
    // l'utilisateur chercher une panne réseau au lieu de lancer l'appairage.
    const statut = localWorkerStatus({ localWorkerDeviceId: PORTABLE, devices: [] });

    expect(statut.state).toBe("unpaired");
    expect(statut.summary).toContain("appairage");
  });

  it("reconnaît cette machine dans la liste du cœur", () => {
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [device({ id: "device-fixe", name: "Poste fixe" }), device()],
    });

    expect(statut.state).toBe("online");
    expect(statut.name).toBe("Portable Windows");
    expect(statut.capabilities).toContain("terminal.execute");
  });
});

describe("états", () => {
  it("hors ligne quand le cœur ne le voit plus", () => {
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [device({ status: "OFFLINE" })],
    });

    expect(statut.state).toBe("offline");
    expect(statut.acceptingTasks).toBe(false);
  });

  it("dégradé n'est pas hors ligne", () => {
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [device({ status: "DEGRADED" })],
    });

    expect(statut.state).toBe("degraded");
    // Dégradé signifie « joignable mais à éviter » : le cœur préférera une
    // autre machine, et l'interface doit le dire plutôt que de laisser croire
    // à une panne.
    expect(statut.summary).toContain("autre machine");
  });

  it("en attente d'approbation quand la confiance n'est pas accordée", () => {
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [device({ trust: "PENDING" })],
    });

    expect(statut.state).toBe("pending");
  });

  it("révoqué prime sur tout le reste", () => {
    // Un appareil révoqué peut rester marqué ONLINE le temps que la
    // déconnexion se propage. Afficher « prêt » pendant ces secondes-là serait
    // le pire moment pour se tromper.
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [device({ status: "ONLINE", trust: "REVOKED" })],
    });

    expect(statut.state).toBe("revoked");
    expect(statut.acceptingTasks).toBe(false);
  });
});

describe("charge", () => {
  it("un exécutant saturé n'accepte plus rien", () => {
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [device({ health: { activeTasks: 2, maxConcurrentTasks: 2 } })],
    });

    expect(statut.state).toBe("online");
    expect(statut.acceptingTasks).toBe(false);
    expect(statut.summary).toContain("saturé");
  });

  it("compte les tâches en cours", () => {
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [device({ health: { activeTasks: 1, maxConcurrentTasks: 4 } })],
    });

    expect(statut.activeTasks).toBe(1);
    expect(statut.maxConcurrentTasks).toBe(4);
    expect(statut.acceptingTasks).toBe(true);
  });

  it("survit à un appareil sans état de santé", () => {
    // Le canal temps réel envoie `device.updated` sans santé : l'écran ne doit
    // pas se vider pour autant.
    const { health: _health, ...sansSante } = device();
    const statut = localWorkerStatus({
      localWorkerDeviceId: PORTABLE,
      devices: [sansSante],
    });

    expect(statut.state).toBe("online");
    expect(statut.maxConcurrentTasks).toBe(1);
  });
});

describe("le reste de la flotte", () => {
  const flotte: ObservedDevice[] = [
    device(),
    device({ id: "device-fixe", name: "Poste fixe", role: "WORKER" }),
    device({ id: "device-redmi", name: "Redmi Note 10S", role: "WORKER" }),
    device({ id: "device-iphone", name: "iPhone", role: "CLIENT", capabilities: [] }),
  ];

  it("liste les autres exécutants sans se compter", () => {
    const autres = remoteWorkers({ localWorkerDeviceId: PORTABLE, devices: flotte });

    expect(autres.map((appareil) => appareil.name)).toEqual(["Poste fixe", "Redmi Note 10S"]);
  });

  it("exclut les clients purs", () => {
    // L'iPhone n'exécute rien : le faire figurer parmi les exécutants ferait
    // croire qu'on peut lui envoyer une tâche.
    const autres = remoteWorkers({ localWorkerDeviceId: PORTABLE, devices: flotte });

    expect(autres.some((appareil) => appareil.role === "CLIENT")).toBe(false);
  });
});
