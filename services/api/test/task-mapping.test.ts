import { describe, expect, it } from "vitest";
import { stepStatusSchema, taskStatusSchema } from "@nexus/devices";
import {
  executionFromRow,
  planFromRow,
  planStatusFromDb,
  planStatusToDb,
  stepFromRow,
  stepStatusFromDb,
  stepStatusToDb,
  stepToRow,
  type TaskExecutionRow,
  type TaskPlanRow,
  type TaskStepRow,
} from "../src/services/persistence/task-mapping.js";

/**
 * Correspondance domaine ↔ PostgreSQL pour les tâches.
 *
 * Ces tests existent à cause d'un défaut précis : le domaine écrit ses statuts
 * en minuscules, la colonne est un enum PostgreSQL en majuscules, et des
 * `as any` masquaient l'écart. Rien ne compilait faux, et rien ne pouvait
 * fonctionner — PostgreSQL refuse `'succeeded'` sur un enum qui n'admet que
 * `SUCCEEDED`. Les tables sont restées vides sans que personne ne le voie.
 *
 * Le premier test est donc le plus important : il parcourt **toutes** les
 * valeurs du domaine. C'est ce qui attrape un statut ajouté d'un côté et oublié
 * de l'autre, qui est exactement la façon dont ce défaut est né.
 */

const PLAN_ENUM = [
  "PENDING",
  "RUNNING",
  "WAITING_FOR_CONFIRMATION",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "PARTIAL",
];

const STEP_ENUM = [
  "PENDING",
  "READY",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_CONFIRMATION",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
];

describe("statuts de tâche", () => {
  it("traduit chaque statut du domaine vers une valeur admise par l'enum", () => {
    for (const status of taskStatusSchema.options) {
      expect(PLAN_ENUM).toContain(planStatusToDb(status));
    }
    for (const status of stepStatusSchema.options) {
      expect(STEP_ENUM).toContain(stepStatusToDb(status));
    }
  });

  it("fait l'aller-retour sans perte", () => {
    for (const status of taskStatusSchema.options) {
      expect(planStatusFromDb(planStatusToDb(status))).toBe(status);
    }
    for (const status of stepStatusSchema.options) {
      expect(stepStatusFromDb(stepStatusToDb(status))).toBe(status);
    }
  });

  it("couvre l'enum de la base en entier", () => {
    // L'inverse du premier test : un statut présent en base mais absent du
    // domaine se relirait en `failed` sans que rien ne le signale.
    const produced = taskStatusSchema.options.map(planStatusToDb);
    expect([...produced].sort()).toEqual([...PLAN_ENUM].sort());
    const steps = stepStatusSchema.options.map(stepStatusToDb);
    expect([...steps].sort()).toEqual([...STEP_ENUM].sort());
  });

  it("ne garde pas la casse du domaine", () => {
    // Le cœur du défaut : c'est cette assertion qui aurait échoué avant.
    expect(planStatusToDb("succeeded")).toBe("SUCCEEDED");
    expect(stepStatusToDb("waiting_for_confirmation")).toBe("WAITING_FOR_CONFIRMATION");
  });

  it("relit un statut inconnu comme un échec plutôt que de le propager", () => {
    expect(planStatusFromDb("CE_STATUT_N_EXISTE_PAS")).toBe("failed");
    expect(stepStatusFromDb("")).toBe("failed");
  });
});

function stepRow(overrides: Partial<TaskStepRow> = {}): TaskStepRow {
  return {
    id: "11111111-1111-7111-8111-111111111111",
    description: "Cloner le dépôt",
    requiredCapabilities: ["shell.exec"],
    tool: "shell.exec",
    arguments: { cmd: "git clone" },
    dependsOn: [],
    selectedDeviceId: null,
    preferredDeviceId: null,
    constraints: null,
    riskLevel: "MEDIUM",
    retryPolicy: { attempts: 2, backoffMs: 500, failoverToAnotherDevice: true },
    timeoutMs: 1_000,
    status: "SUCCEEDED",
    attempt: 1,
    result: { ok: true },
    error: null,
    startedAt: new Date("2026-10-20T10:00:00.000Z"),
    completedAt: new Date("2026-10-20T10:00:05.000Z"),
    ...overrides,
  };
}

describe("lecture d'une ligne de tâche", () => {
  it("rend un plan conforme au domaine", () => {
    const row: TaskPlanRow = {
      id: "22222222-2222-7222-8222-222222222222",
      userId: "33333333-3333-7333-8333-333333333333",
      title: "Mettre à jour le dépôt",
      originClientDeviceId: "44444444-4444-7444-8444-444444444444",
      runId: null,
      conversationId: null,
      correlationId: "corr-1",
      status: "RUNNING",
      metadata: { source: "chat", ignored: 42 },
      createdAt: new Date("2026-10-20T09:59:00.000Z"),
      startedAt: new Date("2026-10-20T10:00:00.000Z"),
      completedAt: null,
      steps: [stepRow()],
    };

    const plan = planFromRow(row);

    expect(plan.status).toBe("running");
    // Les dates du domaine sont des chaînes ISO, pas des `Date` — l'ancien
    // `as unknown as TaskPlan` prétendait le contraire.
    expect(plan.createdAt).toBe("2026-10-20T09:59:00.000Z");
    expect(plan.startedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(plan.completedAt).toBeNull();
    // Les métadonnées sont déclarées `Record<string, string>` : une valeur non
    // conforme est écartée au lieu d'être propagée.
    expect(plan.metadata).toEqual({ source: "chat" });
    expect(plan.steps[0]?.status).toBe("succeeded");
  });

  it("renomme la politique de réessai, qui n'a pas le même nom des deux côtés", () => {
    const step = stepFromRow(stepRow());
    expect(step.retry).toEqual({ attempts: 2, backoffMs: 500, failoverToAnotherDevice: true });
    expect(step).not.toHaveProperty("retryPolicy");
  });

  it("retombe sur une politique par défaut quand la colonne est illisible", () => {
    expect(stepFromRow(stepRow({ retryPolicy: null })).retry).toEqual({
      attempts: 1,
      backoffMs: 1_000,
      failoverToAnotherDevice: false,
    });
  });

  it("omet les contraintes absentes au lieu de les mettre à undefined", () => {
    // `exactOptionalPropertyTypes` est actif : la différence est observable.
    expect("constraints" in stepFromRow(stepRow({ constraints: null }))).toBe(false);
    expect(stepFromRow(stepRow({ constraints: { requireMainsPower: true } })).constraints).toEqual({
      requireMainsPower: true,
    });
  });

  it("n'accepte une erreur d'étape que si elle a la forme attendue", () => {
    expect(
      stepFromRow(stepRow({ error: { code: "E", message: "m", retryable: true } })).error,
    ).toEqual({ code: "E", message: "m", retryable: true });
    // Une forme partielle est écartée : la propager donnerait un objet qui ne
    // satisfait pas le schéma du domaine.
    expect(stepFromRow(stepRow({ error: { code: "E" } })).error).toBeNull();
    expect(stepFromRow(stepRow({ error: "boom" })).error).toBeNull();
  });

  it("rend une exécution conforme au domaine", () => {
    const row: TaskExecutionRow = {
      id: "55555555-5555-7555-8555-555555555555",
      taskId: "22222222-2222-7222-8222-222222222222",
      stepId: "11111111-1111-7111-8111-111111111111",
      deviceId: "44444444-4444-7444-8444-444444444444",
      attempt: 1,
      status: "FAILED",
      startedAt: new Date("2026-10-20T10:00:00.000Z"),
      completedAt: null,
      durationMs: null,
      input: null,
      result: null,
      error: { code: "E", message: "m", retryable: false },
    };

    const execution = executionFromRow(row);
    expect(execution.status).toBe("failed");
    expect(execution.startedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(execution.error?.code).toBe("E");
  });
});

describe("écriture d'une étape", () => {
  it("écrit le statut dans la casse de l'enum", () => {
    const written = stepToRow({
      ...stepFromRow(stepRow()),
      status: "running",
    });
    expect(written.status).toBe("RUNNING");
  });

  it("convertit les dates et nomme la colonne de réessai", () => {
    const written = stepToRow(stepFromRow(stepRow()));
    expect(written.startedAt).toEqual(new Date("2026-10-20T10:00:00.000Z"));
    expect(written.retryPolicy).toEqual({
      attempts: 2,
      backoffMs: 500,
      failoverToAnotherDevice: true,
    });
  });

  it("fait l'aller-retour d'une étape sans la déformer", () => {
    const original = stepFromRow(stepRow());
    const written = stepToRow(original);

    // On rejoue ce que PostgreSQL rendrait de cette écriture : les colonnes
    // facultatives absentes reviennent en `null`, pas sous la sentinelle que
    // Prisma exige à l'écriture.
    const reread = stepFromRow({
      id: written.id,
      description: written.description,
      requiredCapabilities: written.requiredCapabilities,
      tool: written.tool,
      arguments: written.arguments,
      dependsOn: written.dependsOn,
      selectedDeviceId: written.selectedDeviceId,
      preferredDeviceId: written.preferredDeviceId,
      constraints: null,
      riskLevel: written.riskLevel,
      retryPolicy: written.retryPolicy,
      timeoutMs: written.timeoutMs,
      status: written.status,
      attempt: written.attempt,
      result: written.result,
      error: null,
      startedAt: written.startedAt,
      completedAt: written.completedAt,
    });

    expect(reread).toEqual(original);
  });
});
