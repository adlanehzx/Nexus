import { z } from "zod";

/**
 * NEXUS Events.
 *
 * Defined in `@nexus/protocol` because they are shared across:
 * the core (emitter), clients (display/telemetry), and workers (producers).
 * An event type is a stable public contract.
 *
 * Evolution rules:
 *  1. Versioned. Each envelope carries `v`. Differing major versions close the connection.
 *  2. Additive. Event types may be added, but never removed or renamed.
 */

export const EVENT_SCHEMA_VERSION = 1;

/**
 * Common metadata present on all events.
 *
 * `originClientDeviceId` provides the routing thread across the distributed execution mesh.
 */
export const eventEnvelopeSchema = z.object({
  v: z.literal(EVENT_SCHEMA_VERSION),
  id: z.string().min(1),
  type: z.string().min(1),
  at: z.iso.datetime(),
  userId: z.string().min(1),
  correlationId: z.string().min(1),
  /** Originating client device ID. Null for system-generated events. */
  originClientDeviceId: z.string().nullable(),
});

const { type: _discriminator, ...baseShape } = eventEnvelopeSchema.shape;

const withBase = <T extends z.ZodRawShape>(shape: T) => z.object({ ...baseShape, ...shape });

// ── Agent Reasoning ──────────────────────────────────────────────────────────

const agentEvents = [
  withBase({ type: z.literal("agent.started"), runId: z.string(), conversationId: z.string() }),
  withBase({
    type: z.literal("agent.progress"),
    runId: z.string(),
    iteration: z.number().int().nonnegative(),
    label: z.string().nullable(),
  }),
  withBase({
    type: z.literal("agent.completed"),
    runId: z.string(),
    response: z.string(),
    iterations: z.number().int().nonnegative(),
  }),
  withBase({
    type: z.literal("agent.failed"),
    runId: z.string(),
    code: z.string(),
    message: z.string(),
  }),
] as const;

// ── Distributed Tasks ────────────────────────────────────────────────────────

const taskEvents = [
  withBase({
    type: z.literal("task.created"),
    taskId: z.string(),
    title: z.string(),
    stepCount: z.number().int().positive(),
  }),
  withBase({ type: z.literal("task.started"), taskId: z.string() }),
  withBase({
    type: z.literal("task.progress"),
    taskId: z.string(),
    stepId: z.string(),
    deviceId: z.string().nullable().default(null),
    percent: z.number().int().min(0).max(100),
    label: z.string().nullable(),
  }),
  withBase({
    type: z.literal("task.completed"),
    taskId: z.string(),
    status: z.enum(["succeeded", "partial"]),
    durationMs: z.number().nonnegative(),
  }),
  withBase({
    type: z.literal("task.failed"),
    taskId: z.string(),
    code: z.string(),
    message: z.string(),
  }),
  withBase({ type: z.literal("task.cancelled"), taskId: z.string(), reason: z.string() }),
] as const;

// ── Devices ──────────────────────────────────────────────────────────────────

const deviceEvents = [
  withBase({
    type: z.literal("device.connected"),
    deviceId: z.string(),
    deviceName: z.string(),
    role: z.string(),
  }),
  withBase({ type: z.literal("device.disconnected"), deviceId: z.string(), reason: z.string() }),
  withBase({
    type: z.literal("device.status_changed"),
    deviceId: z.string(),
    status: z.string(),
    previous: z.string(),
  }),
  withBase({
    type: z.literal("device.capabilities_changed"),
    deviceId: z.string(),
    capabilities: z.array(z.string()),
  }),
] as const;

// ── Workers ──────────────────────────────────────────────────────────────────

const workerEvents = [
  withBase({
    type: z.literal("worker.connected"),
    deviceId: z.string(),
    deviceName: z.string(),
    workerVersion: z.string(),
  }),
  withBase({
    type: z.literal("worker.ready"),
    deviceId: z.string(),
    capabilities: z.array(z.string()),
    maxConcurrentTasks: z.number().int().positive(),
  }),
  withBase({
    type: z.literal("worker.disconnected"),
    deviceId: z.string(),
    reason: z.string(),
    inFlightSteps: z.number().int().nonnegative(),
  }),
  withBase({
    type: z.literal("worker.task_started"),
    taskId: z.string(),
    stepId: z.string(),
    deviceId: z.string(),
    tool: z.string(),
  }),
  withBase({
    type: z.literal("worker.task_progress"),
    taskId: z.string(),
    stepId: z.string(),
    deviceId: z.string(),
    percent: z.number().int().min(0).max(100).nullable(),
    label: z.string().nullable(),
  }),
  withBase({
    type: z.literal("worker.task_completed"),
    taskId: z.string(),
    stepId: z.string(),
    deviceId: z.string(),
    durationMs: z.number().nonnegative(),
    summary: z.string(),
  }),
  withBase({
    type: z.literal("worker.task_failed"),
    taskId: z.string(),
    stepId: z.string(),
    deviceId: z.string(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
  withBase({
    type: z.literal("worker.task_cancelled"),
    taskId: z.string(),
    stepId: z.string(),
    deviceId: z.string(),
    reason: z.string(),
  }),
] as const;

// ── Confirmations & Notifications ────────────────────────────────────────────

const confirmationEvents = [
  withBase({
    type: z.literal("confirmation.required"),
    confirmationId: z.string(),
    taskId: z.string().nullable(),
    stepId: z.string().nullable(),
    capability: z.string().nullable(),
    action: z.string(),
    description: z.string(),
    riskLevel: z.string(),
    expiresAt: z.iso.datetime(),
  }),
  withBase({
    type: z.literal("confirmation.responded"),
    confirmationId: z.string(),
    decision: z.enum(["approved", "rejected", "expired"]),
    decidedByDeviceId: z.string().nullable(),
  }),
] as const;

const notificationEvents = [
  withBase({
    type: z.literal("notification.created"),
    notificationId: z.string(),
    title: z.string(),
    body: z.string(),
    severity: z.enum(["info", "warning", "error"]),
  }),
] as const;

// ── Discriminated Union ──────────────────────────────────────────────────────

export const nexusEventSchema = z.discriminatedUnion("type", [
  ...agentEvents,
  ...taskEvents,
  ...deviceEvents,
  ...workerEvents,
  ...confirmationEvents,
  ...notificationEvents,
]);

export type NexusEvent = z.infer<typeof nexusEventSchema>;
export type NexusEventType = NexusEvent["type"];

/** All known event types for subscription routing and exhaustive test coverage. */
export const NEXUS_EVENT_TYPES = [
  "agent.started",
  "agent.progress",
  "agent.completed",
  "agent.failed",
  "task.created",
  "task.started",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "device.connected",
  "device.disconnected",
  "device.status_changed",
  "device.capabilities_changed",
  "worker.connected",
  "worker.ready",
  "worker.disconnected",
  "worker.task_started",
  "worker.task_progress",
  "worker.task_completed",
  "worker.task_failed",
  "worker.task_cancelled",
  "confirmation.required",
  "confirmation.responded",
  "notification.created",
] as const satisfies readonly NexusEventType[];

/** Returns the event family (domain prefix) for client subscription filtering. */
export function eventFamily(type: NexusEventType): string {
  return type.split(".")[0] ?? type;
}

/**
 * Validates an incoming event. Unknown event types return undefined rather
 * than throwing, preserving backwards compatibility across client versions.
 */
export function parseNexusEvent(input: unknown): NexusEvent | undefined {
  const result = nexusEventSchema.safeParse(input);
  return result.success ? result.data : undefined;
}
