import { describe, expect, it } from "vitest";
import {
  failedSteps,
  formatAge,
  formatCount,
  formatDuration,
  overallHealth,
  selectedWorkers,
  sortActivity,
  workerState,
} from "../src/lib/format.js";
import type { HealthEntry, TaskRow, WorkerRow } from "../src/lib/api.js";

/**
 * Les décisions du tableau de bord.
 *
 * Elles paraissent mineures — une couleur, un libellé, un ordre — et elles ne le
 * sont pas : un écran de supervision qui se trompe se trompe précisément au
 * moment où l'on a besoin de lui, et personne ne s'en aperçoit avant.
 */

function health(level: HealthEntry["level"], name = "X"): HealthEntry {
  return { name, level, detail: "" };
}

describe("santé globale", () => {
  it("le pire l'emporte", () => {
    // Un système dont un composant est à terre n'est pas « partiellement en
    // ligne ».
    expect(overallHealth([health("ok"), health("degraded"), health("down")])).toBe("down");
    expect(overallHealth([health("ok"), health("degraded")])).toBe("degraded");
    expect(overallHealth([health("ok"), health("ok")])).toBe("ok");
  });

  it("un composant non configuré ne compte pas", () => {
    // Ne jamais avoir branché de serveur MCP n'est pas une panne. Le peindre en
    // rouge enverrait chercher un incident qui n'existe pas.
    expect(overallHealth([health("ok"), health("unconfigured")])).toBe("ok");
  });

  it("ne rien mesurer se dit, plutôt que de s'afficher en vert", () => {
    expect(overallHealth([health("unconfigured"), health("unconfigured")])).toBe("unknown");
    expect(overallHealth([])).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function worker(patch: Partial<WorkerRow> = {}): WorkerRow {
  return {
    id: "w1",
    name: "Portable",
    role: "BOTH",
    type: "WINDOWS_PC",
    platform: "WINDOWS",
    status: "ONLINE",
    trust: "TRUSTED",
    authenticated: true,
    capabilities: [],
    grantedPermissions: [],
    lastHeartbeatAt: null,
    health: {
      activeTasks: 0,
      maxConcurrentTasks: 2,
      cpuLoad: null,
      memoryFreeMb: null,
      diskFreeMb: null,
      batteryPercent: null,
      onBattery: null,
      latencyMs: null,
      reportedAt: null,
    },
    pairedAt: "2026-09-01T10:00:00.000Z",
    revokedAt: null,
    agentVersion: null,
    connected: true,
    acceptingTasks: true,
    ...patch,
  };
}

describe("état d'un exécutant", () => {
  it("disponible quand le canal est ouvert et la charge tient", () => {
    expect(workerState(worker())).toBe("accepting");
  });

  it("un canal fermé prime sur un statut en ligne", () => {
    // Le registre peut encore le croire `ONLINE` alors que la socket est tombée.
    // Un exécutant déconnecté n'exécutera rien.
    expect(workerState(worker({ connected: false }))).toBe("disconnected");
  });

  it("la révocation prime sur tout le reste", () => {
    // Un appareil révoqué reste marqué `ONLINE` le temps que la déconnexion se
    // propage. L'afficher comme disponible pendant ces secondes-là serait le
    // pire moment pour se tromper.
    expect(workerState(worker({ trust: "REVOKED", status: "ONLINE", connected: true }))).toBe(
      "revoked",
    );
  });

  it("saturé n'est pas dégradé", () => {
    const saturated = worker({
      health: { ...worker().health, activeTasks: 2, maxConcurrentTasks: 2 },
    });
    expect(workerState(saturated)).toBe("saturated");
    expect(workerState(worker({ status: "DEGRADED" }))).toBe("degraded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function task(steps: TaskRow["steps"]): TaskRow {
  return {
    id: "t1",
    title: "Tâche",
    status: "running",
    originClientDeviceId: "device-iphone",
    correlationId: "corr-1",
    createdAt: "2026-09-03T10:00:00.000Z",
    startedAt: "2026-09-03T10:00:00.000Z",
    completedAt: null,
    progressPercent: 50,
    source: "device",
    steps,
  };
}

function step(patch: Partial<TaskRow["steps"][number]> = {}): TaskRow["steps"][number] {
  return {
    id: "s1",
    description: "Étape",
    tool: "device.terminal.execute",
    requiredCapabilities: ["terminal.execute"],
    status: "succeeded",
    selectedDeviceId: null,
    selectedDeviceName: null,
    riskLevel: "SAFE",
    error: null,
    ...patch,
  };
}

describe("exécutants retenus", () => {
  it("compte les étapes par machine", () => {
    // Le plan déclare des capacités ; c'est le cœur qui choisit. La page doit
    // montrer ce qui a été **décidé**, sans quoi on ne peut pas répondre à
    // « pourquoi ça a tourné là ? ».
    const retenus = selectedWorkers(
      task([
        step({ id: "s1", selectedDeviceId: "d1", selectedDeviceName: "Portable" }),
        step({ id: "s2", selectedDeviceId: "d1", selectedDeviceName: "Portable" }),
        step({ id: "s3", selectedDeviceId: "d2", selectedDeviceName: "Poste fixe" }),
      ]),
    );

    expect(retenus).toEqual([
      { id: "d1", name: "Portable", steps: 2 },
      { id: "d2", name: "Poste fixe", steps: 1 },
    ]);
  });

  it("ignore les étapes non dispatchées", () => {
    expect(selectedWorkers(task([step()]))).toEqual([]);
  });

  it("se rabat sur l'identifiant quand le nom manque", () => {
    // Un appareil supprimé après coup n'a plus de nom. Afficher un vide ferait
    // perdre l'information ; l'identifiant, lui, reste exploitable.
    const retenus = selectedWorkers(
      task([step({ selectedDeviceId: "d-disparu", selectedDeviceName: null })]),
    );

    expect(retenus[0]?.name).toBe("d-disparu");
  });
});

describe("étapes en échec", () => {
  it("retient celles qui portent une erreur ou un statut d'échec", () => {
    const found = failedSteps(
      task([
        step({ id: "ok", status: "succeeded" }),
        step({ id: "ko", status: "failed" }),
        step({ id: "err", status: "succeeded", error: { code: "X", message: "y" } }),
      ]),
    );

    expect(found.map((entry) => entry.id)).toEqual(["ko", "err"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("mise en forme", () => {
  it("les durées passent à l'échelle", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(4_200)).toBe("4.2 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("les âges se lisent d'un coup d'œil", () => {
    const now = new Date("2026-09-03T12:00:00.000Z");

    expect(formatAge(null)).toBe("jamais");
    expect(formatAge("2026-09-03T11:59:30.000Z", now)).toBe("il y a 30 s");
    expect(formatAge("2026-09-03T11:45:00.000Z", now)).toBe("il y a 15 min");
    expect(formatAge("2026-09-03T09:00:00.000Z", now)).toBe("il y a 3 h");
    expect(formatAge("2026-09-01T12:00:00.000Z", now)).toBe("il y a 2 j");
  });

  it("un horodatage illisible ne casse pas la ligne", () => {
    expect(formatAge("pas une date")).toBe("—");
  });

  it("les compteurs restent compacts", () => {
    // Un compteur à six chiffres déborde toutes les colonnes.
    expect(formatCount(42)).toBe("42");
    expect(formatCount(1_500)).toBe("1.5 k");
    expect(formatCount(2_400_000)).toBe("2.4 M");
  });

  it("l'activité est chronologique, la plus fraîche d'abord", () => {
    const sorted = sortActivity([
      { at: "2026-09-03T10:00:00.000Z", kind: "task", summary: "vieille", level: "info" },
      { at: "2026-09-03T12:00:00.000Z", kind: "run", summary: "récente", level: "info" },
    ]);

    expect(sorted.map((entry) => entry.summary)).toEqual(["récente", "vieille"]);
  });
});
