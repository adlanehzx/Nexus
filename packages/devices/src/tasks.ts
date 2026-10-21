import { z } from "zod";
import { uuidv7 } from "@nexus/shared";
import { riskLevelSchema } from "@nexus/tools";
import { InvalidTaskPlanError } from "./errors.js";
import { deviceTypeSchema, devicePlatformSchema } from "./types.js";

/**
 * Multi-device task execution plan.
 *
 * Distinct from `AgentRun` in `@nexus/agent-core`: an agent run describes LLM reasoning
 * turns, whereas a task plan describes distributed execution across devices.
 *
 * `originClientDeviceId` identifies the initiating client device so results, progress,
 * and confirmation prompts route back to the originating user interface.
 */

export const taskStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_for_confirmation",
  "succeeded",
  "failed",
  "cancelled",
  /** Stopped before final completion, but some steps succeeded. */
  "partial",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const stepStatusSchema = z.enum([
  "pending",
  /** Dependencies fulfilled, awaiting worker dispatch. */
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
  /** Retry on an alternative worker if primary candidate fails. */
  failoverToAnotherDevice: z.boolean().default(false),
});
export type StepRetryPolicy = z.infer<typeof stepRetryPolicySchema>;

export const taskStepSchema = z.object({
  id: z.string().min(1),
  /** Human-readable description displayed in UI. */
  description: z.string().min(1),
  /** Required capabilities for selector matching. */
  requiredCapabilities: z.array(z.string()).min(1),
  /** Registry tool name to invoke on worker. */
  tool: z.string().min(1),
  arguments: z.unknown(),
  /** Step IDs that must succeed before this step executes. */
  dependsOn: z.array(z.string()).default([]),
  /** Assigned worker device ID, populated at execution time. */
  selectedDeviceId: z.string().nullable().default(null),
  /** Optional preferred device ID, respected if eligible. */
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
  /** Client device where request originated. */
  originClientDeviceId: z.string().min(1),
  /** Originating agent run ID, if any. */
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

/** Execution audit record of a step attempt on a specific device. */
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
  /** Redacted input arguments. */
  input: z.unknown().nullable().default(null),
  result: z.unknown().nullable().default(null),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .nullable()
    .default(null),
});
export type TaskExecution = z.infer<typeof taskExecutionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Construction and Validation
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
 * Constructs and validates a task execution plan.
 *
 * @throws {InvalidTaskPlanError} If duplicate IDs, missing dependency targets, or cycles are found.
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

/** Validates step ID uniqueness, dependency existence, and acyclicity. */
export function validateTaskPlan(plan: TaskPlan): void {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const step of plan.steps) {
    if (ids.has(step.id)) problems.push(`duplicate step ID: ${step.id}`);
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        problems.push(`step ${step.id} depends on nonexistent step: ${dependency}`);
      }
      if (dependency === step.id) problems.push(`step ${step.id} depends on itself`);
    }
  }

  const cycle = findCycle(plan.steps);
  if (cycle !== undefined) problems.push(`dependency cycle detected: ${cycle.join(" -> ")}`);

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
 * Returns executable steps whose dependencies have all completed successfully.
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
 * Returns blocked steps whose dependencies failed, were cancelled, or were skipped.
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

/** Computes overall plan status based on constituent step states. */
export function derivePlanStatus(plan: TaskPlan): TaskStatus {
  const statuses = plan.steps.map((step) => step.status);

  if (statuses.includes("waiting_for_confirmation")) return "waiting_for_confirmation";
  if (statuses.some((status) => status === "running" || status === "assigned")) return "running";
  if (statuses.every((status) => status === "succeeded")) return "succeeded";
  if (statuses.includes("cancelled")) return "cancelled";

  const finished = statuses.every((status) => TERMINAL_STEP_STATUSES.includes(status));
  if (!finished) return statuses.every((status) => status === "pending") ? "pending" : "running";

  return statuses.includes("succeeded") ? "partial" : "failed";
}

/** Progress percentage (0 to 100) for UI display. */
export function planProgress(plan: TaskPlan): number {
  const done = plan.steps.filter((step) => TERMINAL_STEP_STATUSES.includes(step.status)).length;
  return Math.round((done / plan.steps.length) * 100);
}
