import { DbNull } from "@nexus/database";
import type { InputJsonValue } from "@nexus/database";
import type {
  StepRetryPolicy,
  StepStatus,
  TaskExecution,
  TaskPlan,
  TaskStatus,
  TaskStep,
} from "@nexus/devices";

/**
 * Correspondance entre le domaine des tâches et les colonnes PostgreSQL.
 *
 * Ce module existe parce que les deux côtés ne parlent pas la même langue, et
 * que l'ignorer coûtait cher : le domaine écrit ses statuts en minuscules
 * (`"succeeded"`), la base les stocke dans un **enum PostgreSQL natif** en
 * majuscules (`SUCCEEDED`). Les dates sont des chaînes ISO côté domaine et des
 * `timestamptz` côté base. Un champ ne porte pas le même nom des deux côtés
 * (`retry` / `retryPolicy`).
 *
 * Tant que ces écarts étaient masqués par des `as any` à l'écriture et des
 * `as unknown as TaskPlan` à la lecture, rien ne compilait faux et rien ne
 * fonctionnait : PostgreSQL refuse `'succeeded'` sur un enum qui n'admet que
 * `SUCCEEDED`. Les tables correspondantes sont d'ailleurs restées vides.
 *
 * Les tables ci-dessous sont des `Record` **exhaustifs** sur les unions du
 * domaine. C'est volontaire : ajouter un statut au domaine sans l'ajouter ici
 * ne compilera pas, au lieu de produire une erreur PostgreSQL le jour où ce
 * statut sera atteint pour la première fois.
 */

const PLAN_STATUS_TO_DB = {
  pending: "PENDING",
  running: "RUNNING",
  waiting_for_confirmation: "WAITING_FOR_CONFIRMATION",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  partial: "PARTIAL",
} as const satisfies Record<TaskStatus, string>;

const STEP_STATUS_TO_DB = {
  pending: "PENDING",
  ready: "READY",
  assigned: "ASSIGNED",
  running: "RUNNING",
  waiting_for_confirmation: "WAITING_FOR_CONFIRMATION",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  skipped: "SKIPPED",
  cancelled: "CANCELLED",
} as const satisfies Record<StepStatus, string>;

export type DbPlanStatus = (typeof PLAN_STATUS_TO_DB)[TaskStatus];
export type DbStepStatus = (typeof STEP_STATUS_TO_DB)[StepStatus];

const PLAN_STATUS_FROM_DB = invert(PLAN_STATUS_TO_DB);
const STEP_STATUS_FROM_DB = invert(STEP_STATUS_TO_DB);

function invert<K extends string, V extends string>(table: Record<K, V>): Record<V, K> {
  const result = {} as Record<V, K>;
  for (const [key, value] of Object.entries(table) as [K, V][]) result[value] = key;
  return result;
}

export const planStatusToDb = (status: TaskStatus): DbPlanStatus => PLAN_STATUS_TO_DB[status];
export const stepStatusToDb = (status: StepStatus): DbStepStatus => STEP_STATUS_TO_DB[status];

/**
 * Statut relu depuis la base.
 *
 * Le défaut n'est pas de la complaisance : la colonne est un enum PostgreSQL,
 * donc une valeur inconnue signifie que la base a été modifiée hors de ce code.
 * Mieux vaut alors une tâche qui se présente comme `failed` qu'un objet dont le
 * statut mentirait au reste du système.
 */
export const planStatusFromDb = (value: string): TaskStatus =>
  PLAN_STATUS_FROM_DB[value as DbPlanStatus] ?? "failed";

export const stepStatusFromDb = (value: string): StepStatus =>
  STEP_STATUS_FROM_DB[value as DbStepStatus] ?? "failed";

/** Date de base → chaîne ISO du domaine. */
const isoOrNull = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * Valeur du domaine → colonne `Json` nullable.
 *
 * Le point à retenir n'est pas le type mais la sentinelle : Prisma distingue
 * `DbNull`, un `NULL` SQL, de `JsonNull`, la valeur JSON `null` stockée dans la
 * colonne. Un `null` JavaScript n'exprime ni l'un ni l'autre et ses types
 * d'entrée le refusent. Les colonnes concernées ici sont facultatives au sens
 * du domaine : c'est donc `DbNull` qu'on veut.
 */
type JsonWrite = InputJsonValue | typeof DbNull;

const jsonOrNull = (value: unknown): JsonWrite => value ?? DbNull;

/** Même conversion pour une colonne `Json` non nullable, dont le défaut est `{}`. */
const jsonValue = (value: unknown): InputJsonValue => value ?? {};

/** Erreur d'étape, telle que le domaine la décrit. */
type StepError = TaskStep["error"];

function stepErrorFromDb(value: unknown): StepError {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { code?: unknown; message?: unknown; retryable?: unknown };
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.retryable !== "boolean"
  ) {
    return null;
  }
  return { code: candidate.code, message: candidate.message, retryable: candidate.retryable };
}

function retryFromDb(value: unknown): StepRetryPolicy {
  const fallback: StepRetryPolicy = {
    attempts: 1,
    backoffMs: 1_000,
    failoverToAnotherDevice: false,
  };
  if (typeof value !== "object" || value === null) return fallback;
  const candidate = value as Partial<Record<keyof StepRetryPolicy, unknown>>;
  return {
    attempts: typeof candidate.attempts === "number" ? candidate.attempts : fallback.attempts,
    backoffMs: typeof candidate.backoffMs === "number" ? candidate.backoffMs : fallback.backoffMs,
    failoverToAnotherDevice:
      typeof candidate.failoverToAnotherDevice === "boolean"
        ? candidate.failoverToAnotherDevice
        : fallback.failoverToAnotherDevice,
  };
}

function constraintsFromDb(value: unknown): TaskStep["constraints"] {
  return typeof value === "object" && value !== null ? value : undefined;
}

const metadataFromDb = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
};

/** Ligne `task_steps` telle que Prisma la rend. */
export interface TaskStepRow {
  id: string;
  description: string;
  requiredCapabilities: string[];
  tool: string;
  arguments: unknown;
  dependsOn: string[];
  selectedDeviceId: string | null;
  preferredDeviceId: string | null;
  constraints: unknown;
  riskLevel: string;
  retryPolicy: unknown;
  timeoutMs: number;
  status: string;
  attempt: number;
  result: unknown;
  error: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface TaskPlanRow {
  id: string;
  userId: string;
  title: string;
  originClientDeviceId: string;
  runId: string | null;
  conversationId: string | null;
  correlationId: string;
  status: string;
  metadata: unknown;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  steps: TaskStepRow[];
}

export interface TaskExecutionRow {
  id: string;
  taskId: string;
  stepId: string;
  deviceId: string;
  attempt: number;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  input: unknown;
  result: unknown;
  error: unknown;
}

export function stepFromRow(row: TaskStepRow): TaskStep {
  const constraints = constraintsFromDb(row.constraints);
  return {
    id: row.id,
    description: row.description,
    requiredCapabilities: row.requiredCapabilities,
    tool: row.tool,
    arguments: row.arguments,
    dependsOn: row.dependsOn,
    selectedDeviceId: row.selectedDeviceId,
    preferredDeviceId: row.preferredDeviceId,
    riskLevel: row.riskLevel as TaskStep["riskLevel"],
    retry: retryFromDb(row.retryPolicy),
    timeoutMs: row.timeoutMs,
    status: stepStatusFromDb(row.status),
    attempt: row.attempt,
    result: row.result ?? null,
    error: stepErrorFromDb(row.error),
    startedAt: isoOrNull(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
    // `exactOptionalPropertyTypes` est actif : une contrainte absente s'omet,
    // elle ne se met pas à `undefined`.
    ...(constraints === undefined ? {} : { constraints }),
  };
}

export function planFromRow(row: TaskPlanRow): TaskPlan {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    originClientDeviceId: row.originClientDeviceId,
    runId: row.runId,
    conversationId: row.conversationId,
    correlationId: row.correlationId,
    status: planStatusFromDb(row.status),
    steps: row.steps.map(stepFromRow),
    createdAt: row.createdAt.toISOString(),
    startedAt: isoOrNull(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
    metadata: metadataFromDb(row.metadata),
  };
}

export function executionFromRow(row: TaskExecutionRow): TaskExecution {
  return {
    id: row.id,
    taskId: row.taskId,
    stepId: row.stepId,
    deviceId: row.deviceId,
    attempt: row.attempt,
    status: stepStatusFromDb(row.status),
    startedAt: row.startedAt.toISOString(),
    completedAt: isoOrNull(row.completedAt),
    durationMs: row.durationMs,
    input: row.input ?? null,
    result: row.result ?? null,
    error: stepErrorFromDb(row.error),
  };
}

/** Champs d'écriture d'une étape, hors clés de relation. */
export function stepToRow(step: TaskStep) {
  return {
    id: step.id,
    // Le domaine n'a pas de clé lisible distincte de l'identifiant ; la colonne
    // `key` est contrainte unique par plan, et l'identifiant la satisfait.
    key: step.id,
    description: step.description,
    requiredCapabilities: step.requiredCapabilities,
    tool: step.tool,
    arguments: jsonValue(step.arguments),
    dependsOn: step.dependsOn,
    selectedDeviceId: step.selectedDeviceId,
    preferredDeviceId: step.preferredDeviceId,
    constraints: jsonOrNull(step.constraints),
    riskLevel: step.riskLevel,
    retryPolicy: jsonValue(step.retry),
    timeoutMs: step.timeoutMs,
    status: stepStatusToDb(step.status),
    attempt: step.attempt,
    result: jsonOrNull(step.result),
    error: jsonOrNull(step.error),
    startedAt: dateOrNull(step.startedAt),
    completedAt: dateOrNull(step.completedAt),
  };
}

/** Chaîne ISO du domaine → date de base. */
export const dateOrNull = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

export { jsonOrNull, jsonValue };
