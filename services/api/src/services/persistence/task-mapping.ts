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
 * Mapping between the task domain model and PostgreSQL columns.
 *
 * This module exists because both sides do not speak the same language, and
 * ignoring this was costly: the domain writes its statuses in lowercase
 * (`"succeeded"`), while the database stores them in a **native PostgreSQL enum** in
 * uppercase (`SUCCEEDED`). Dates are ISO strings on the domain side and
 * `timestamptz` in the database. One field has a different name on each side
 * (`retry` / `retryPolicy`).
 *
 * As long as these discrepancies were hidden behind `as any` when writing and
 * `as unknown as TaskPlan` when reading, compilation appeared clean while nothing
 * functioned: PostgreSQL rejects `'succeeded'` on an enum that only accepts
 * `SUCCEEDED`. The corresponding tables had remained empty as a result.
 *
 * The mapping tables below are **exhaustive** `Record` types over domain unions.
 * This is intentional: adding a status to the domain without adding it here
 * will fail to compile, rather than triggering a PostgreSQL runtime error when
 * that status is first encountered.
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
 * Status read from the database.
 *
 * The default fallback is not complacency: the column is a PostgreSQL enum,
 * so an unknown value indicates the database was altered outside this codebase.
 * It is therefore safer for a task to present as `failed` than to return an object whose
 * status would mislead the rest of the system.
 */
export const planStatusFromDb = (value: string): TaskStatus =>
  PLAN_STATUS_FROM_DB[value as DbPlanStatus] ?? "failed";

export const stepStatusFromDb = (value: string): StepStatus =>
  STEP_STATUS_FROM_DB[value as DbStepStatus] ?? "failed";

/** Database date → domain ISO string. */
const isoOrNull = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * Domain value → nullable `Json` column.
 *
 * The key point is not the type but the sentinel: Prisma distinguishes
 * `DbNull`, a SQL `NULL`, from `JsonNull`, the JSON `null` literal stored in the
 * column. A JavaScript `null` does not represent either and Prisma input types
 * reject it. The columns concerned here are optional in domain terms:
 * `DbNull` is therefore what we need.
 */
type JsonWrite = InputJsonValue | typeof DbNull;

const jsonOrNull = (value: unknown): JsonWrite => value ?? DbNull;

/** Same conversion for a non-nullable `Json` column whose default is `{}`. */
const jsonValue = (value: unknown): InputJsonValue => value ?? {};

/** Step error as described by the domain. */
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
    // `exactOptionalPropertyTypes` is enabled: an absent constraint is omitted,
    // not set to `undefined`.
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

/** Step write fields, excluding relation keys. */
export function stepToRow(step: TaskStep) {
  return {
    id: step.id,
    // The domain has no readable key distinct from the identifier; the
    // `key` column has a unique constraint per plan, which the identifier satisfies.
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

/** Domain ISO string → database date. */
export const dateOrNull = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

export { jsonOrNull, jsonValue };
