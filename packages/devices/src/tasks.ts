import { z } from "zod";
import { uuidv7 } from "@nexus/shared";
import { riskLevelSchema } from "@nexus/tools";
import { InvalidTaskPlanError } from "./errors.js";
import { deviceTypeSchema, devicePlatformSchema } from "./types.js";

/**
 * Plan de tâche multi-appareils.
 *
 * À ne pas confondre avec `AgentRun` de `@nexus/agent-core` : celui-là décrit un
 * **raisonnement** (observer, réfléchir, appeler un outil), celui-ci décrit une
 * **exécution répartie** (le poste fixe clone le dépôt, le portable lance les
 * tests, l'Android notifie). Un run agent peut produire un plan de tâche ; le
 * plan peut s'exécuter sans agent. Les fusionner rendrait l'un ou l'autre
 * illisible.
 *
 * Le champ qui traverse tout : `originClientDeviceId`. La tâche part de
 * l'iPhone, s'exécute sur le poste fixe, et ses résultats reviennent à l'iPhone.
 * Ce n'est pas une métadonnée décorative — c'est le fil de routage.
 */

export const taskStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_for_confirmation",
  "succeeded",
  "failed",
  "cancelled",
  /** Le plan s'est arrêté avant la fin, mais des étapes ont abouti. */
  "partial",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const stepStatusSchema = z.enum([
  "pending",
  /** Dépendances satisfaites, en attente d'un exécutant. */
  "ready",
  "assigned",
  "running",
  "waiting_for_confirmation",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

export const stepRetryPolicySchema = z.object({
  attempts: z.number().int().min(1).max(5).default(1),
  backoffMs: z.number().int().nonnegative().default(1_000),
  /** Réessayer sur un autre appareil si le premier échoue. */
  failoverToAnotherDevice: z.boolean().default(false),
});
export type StepRetryPolicy = z.infer<typeof stepRetryPolicySchema>;

export const taskStepSchema = z.object({
  id: z.string().min(1),
  /** Lisible par un humain : c'est ce que l'interface affiche. */
  description: z.string().min(1),
  /** Le sélecteur ne connaît que ça — jamais un nom d'appareil. */
  requiredCapabilities: z.array(z.string()).min(1),
  /** Outil du registre à invoquer sur l'exécutant. */
  tool: z.string().min(1),
  arguments: z.unknown(),
  /** Identifiants d'étapes qui doivent aboutir avant celle-ci. */
  dependsOn: z.array(z.string()).default([]),
  /** Renseigné par le sélecteur au moment de l'exécution, jamais par le planner. */
  selectedDeviceId: z.string().nullable().default(null),
  /** Préférence explicite de l'utilisateur, respectée si l'appareil est éligible. */
  preferredDeviceId: z.string().nullable().default(null),
  constraints: z
    .object({
      deviceTypes: z.array(deviceTypeSchema).optional(),
      platforms: z.array(devicePlatformSchema).optional(),
      requireMainsPower: z.boolean().optional(),
    })
    .optional(),
  riskLevel: riskLevelSchema.default("MEDIUM"),
  retry: stepRetryPolicySchema.default({
    attempts: 1,
    backoffMs: 1_000,
    failoverToAnotherDevice: false,
  }),
  timeoutMs: z.number().int().positive().default(300_000),
  status: stepStatusSchema.default("pending"),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  result: z.unknown().nullable().default(null),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .nullable()
    .default(null),
  attempt: z.number().int().nonnegative().default(0),
});
export type TaskStep = z.infer<typeof taskStepSchema>;

export const taskPlanSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().min(1),
  /**
   * Appareil d'où part la demande.
   *
   * Conservé pendant toute la vie de la tâche, quels que soient les appareils
   * qui l'exécutent. Les événements et les confirmations lui reviennent en
   * priorité.
   */
  originClientDeviceId: z.string().min(1),
  /** Run agent à l'origine du plan, s'il y en a un. */
  runId: z.string().nullable().default(null),
  conversationId: z.string().nullable().default(null),
  correlationId: z.string().min(1),
  status: taskStatusSchema.default("pending"),
  steps: z.array(taskStepSchema).min(1),
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type TaskPlan = z.infer<typeof taskPlanSchema>;

/** Une tentative d'exécution d'une étape sur un appareil donné. */
export const taskExecutionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  deviceId: z.string().min(1),
  attempt: z.number().int().positive(),
  status: stepStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  durationMs: z.number().nonnegative().nullable().default(null),
  /** Arguments **rédigés** : une exécution est un journal d'audit. */
  input: z.unknown().nullable().default(null),
  result: z.unknown().nullable().default(null),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .nullable()
    .default(null),
});
export type TaskExecution = z.infer<typeof taskExecutionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Construction et validation
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskStepInput {
  id?: string;
  description: string;
  requiredCapabilities: string[];
  tool: string;
  arguments?: unknown;
  dependsOn?: string[];
  preferredDeviceId?: string;
  constraints?: TaskStep["constraints"];
  riskLevel?: TaskStep["riskLevel"];
  retry?: Partial<StepRetryPolicy>;
  timeoutMs?: number;
}

export interface CreateTaskPlanInput {
  userId: string;
  title: string;
  originClientDeviceId: string;
  correlationId: string;
  runId?: string;
  conversationId?: string;
  steps: TaskStepInput[];
  metadata?: Record<string, string>;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Construit un plan et le valide.
 *
 * @throws {InvalidTaskPlanError} si une dépendance pointe dans le vide, si un
 *   identifiant est dupliqué, ou si le graphe contient un cycle. Mieux vaut
 *   refuser un plan incohérent que le découvrir bloqué à la troisième étape.
 */
export function createTaskPlan(input: CreateTaskPlanInput): TaskPlan {
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? uuidv7;

  const steps: TaskStep[] = input.steps.map((step, index) =>
    taskStepSchema.parse({
      id: step.id ?? `step-${String(index + 1)}`,
      description: step.description,
      requiredCapabilities: step.requiredCapabilities,
      tool: step.tool,
      arguments: step.arguments ?? {},
      dependsOn: step.dependsOn ?? [],
      preferredDeviceId: step.preferredDeviceId ?? null,
      ...(step.constraints === undefined ? {} : { constraints: step.constraints }),
      riskLevel: step.riskLevel ?? "MEDIUM",
      retry: {
        attempts: step.retry?.attempts ?? 1,
        backoffMs: step.retry?.backoffMs ?? 1_000,
        failoverToAnotherDevice: step.retry?.failoverToAnotherDevice ?? false,
      },
      timeoutMs: step.timeoutMs ?? 300_000,
    }),
  );

  const plan = taskPlanSchema.parse({
    id: newId(),
    userId: input.userId,
    title: input.title,
    originClientDeviceId: input.originClientDeviceId,
    runId: input.runId ?? null,
    conversationId: input.conversationId ?? null,
    correlationId: input.correlationId,
    status: "pending",
    steps,
    createdAt: now().toISOString(),
    metadata: input.metadata ?? {},
  });

  validateTaskPlan(plan);
  return plan;
}

/** Vérifie l'unicité des identifiants, l'existence des dépendances, l'absence de cycle. */
export function validateTaskPlan(plan: TaskPlan): void {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const step of plan.steps) {
    if (ids.has(step.id)) problems.push(`identifiant d'étape dupliqué : ${step.id}`);
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        problems.push(`l'étape ${step.id} dépend de ${dependency}, qui n'existe pas`);
      }
      if (dependency === step.id) problems.push(`l'étape ${step.id} dépend d'elle-même`);
    }
  }

  const cycle = findCycle(plan.steps);
  if (cycle !== undefined) problems.push(`cycle de dépendances : ${cycle.join(" → ")}`);

  if (problems.length > 0) throw new InvalidTaskPlanError(problems);
}

function findCycle(steps: readonly TaskStep[]): string[] | undefined {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  function visit(id: string): string[] | undefined {
    const current = state.get(id);
    if (current === "done") return undefined;
    if (current === "visiting") return [...path.slice(path.indexOf(id)), id];

    state.set(id, "visiting");
    path.push(id);

    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const found = visit(dependency);
      if (found !== undefined) return found;
    }

    path.pop();
    state.set(id, "done");
    return undefined;
  }

  for (const step of steps) {
    const found = visit(step.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Étapes exécutables maintenant : en attente, dépendances toutes abouties.
 *
 * Renvoie un **ensemble**, pas une étape : deux étapes sans dépendance mutuelle
 * peuvent partir en parallèle sur deux appareils différents.
 */
export function readySteps(plan: TaskPlan): TaskStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));

  return plan.steps.filter(
    (step) =>
      step.status === "pending" &&
      step.dependsOn.every((id) => byId.get(id)?.status === "succeeded"),
  );
}

/**
 * Étapes définitivement bloquées : une dépendance a échoué ou été annulée.
 *
 * Les marquer `skipped` plutôt que de les laisser en attente évite qu'un plan
 * reste éternellement « en cours » après un échec.
 */
export function blockedSteps(plan: TaskPlan): TaskStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));

  return plan.steps.filter(
    (step) =>
      step.status === "pending" &&
      step.dependsOn.some((id) => {
        const dependency = byId.get(id);
        return (
          dependency !== undefined &&
          (dependency.status === "failed" ||
            dependency.status === "cancelled" ||
            dependency.status === "skipped")
        );
      }),
  );
}

/** Statut global déduit de celui des étapes. */
export function derivePlanStatus(plan: TaskPlan): TaskStatus {
  const statuses = plan.steps.map((step) => step.status);

  if (statuses.includes("waiting_for_confirmation")) return "waiting_for_confirmation";
  if (statuses.some((status) => status === "running" || status === "assigned")) return "running";
  if (statuses.every((status) => status === "succeeded")) return "succeeded";
  if (statuses.includes("cancelled")) return "cancelled";

  const finished = statuses.every((status) => TERMINAL_STEP_STATUSES.includes(status));
  if (!finished) return statuses.every((status) => status === "pending") ? "pending" : "running";

  // Tout est terminé sans que tout ait réussi : partiel s'il reste des acquis,
  // échec sinon. L'utilisateur doit savoir ce qui a été fait malgré tout.
  return statuses.includes("succeeded") ? "partial" : "failed";
}

/** Progression de 0 à 100, pour l'interface. */
export function planProgress(plan: TaskPlan): number {
  const done = plan.steps.filter((step) => TERMINAL_STEP_STATUSES.includes(step.status)).length;
  return Math.round((done / plan.steps.length) * 100);
}
