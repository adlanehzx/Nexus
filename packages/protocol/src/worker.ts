import { z } from "zod";
import { envelopeSchema, PROTOCOL_VERSION } from "./envelope.js";

/**
 * Wire contract between the NEXUS core and execution workers.
 *
 * Workers initiate the outbound connection to the core (no open inbound worker ports).
 * Message framing uses standard envelopeSchema on the dedicated "worker" channel.
 */

export const WORKER_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Channel reserved for execution workers. */
export const WORKER_CHANNEL = "worker";

// ── Capabilities & Health ────────────────────────────────────────────────────

/** Worker-declared capability specification. */
export const workerCapabilitySchema = z.object({
  name: z.string().min(1).max(128),
  version: z.string().default("1"),
  description: z.string().default(""),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type WorkerCapability = z.infer<typeof workerCapabilitySchema>;

/** Worker health metrics transmitted during heartbeat. */
export const workerHealthSchema = z.object({
  cpuLoad: z.number().min(0).max(1).optional(),
  memoryFreeMb: z.number().nonnegative().optional(),
  diskFreeMb: z.number().nonnegative().optional(),
  batteryPercent: z.number().min(0).max(100).optional(),
  onBattery: z.boolean().optional(),
  activeTasks: z.number().int().nonnegative(),
  maxConcurrentTasks: z.number().int().positive(),
});
export type WorkerHealth = z.infer<typeof workerHealthSchema>;

// ── Worker -> Core ───────────────────────────────────────────────────────────

export const workerHelloSchema = z.object({
  deviceId: z.string().min(1),
  workerVersion: z.string().min(1),
  platform: z.string().min(1),
});

export const workerAuthenticateSchema = z.object({
  deviceId: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  requestId: z.string().min(1),
  timestamp: z.iso.datetime(),
});

export const workerRegisterSchema = z.object({
  capabilities: z.array(workerCapabilitySchema),
  health: workerHealthSchema,
});

export const workerHeartbeatSchema = z.object({
  requestId: z.string().min(1),
  timestamp: z.iso.datetime(),
  health: workerHealthSchema,
});

export const workerTaskProgressSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  percent: z.number().int().min(0).max(100).nullable().default(null),
  label: z.string().nullable().default(null),
});

export const workerTaskResultSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().nullable().default(null),
  sensitiveResult: z.boolean().default(false),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .nullable()
    .default(null),
  durationMs: z.number().nonnegative(),
});

export const workerErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  stepId: z.string().nullable().default(null),
});

// ── Core -> Worker ───────────────────────────────────────────────────────────

export const workerChallengeSchema = z.object({
  nonce: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export const workerSessionSchema = z.object({
  sessionId: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  capabilities: z.array(z.string()),
});

export const workerRegisteredSchema = z.object({
  accepted: z.array(z.string()),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
});

export const workerHeartbeatAckSchema = z.object({
  at: z.iso.datetime(),
  rotateSession: z.boolean().default(false),
});

export const workerTaskDispatchSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  capability: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown(),
  timeoutMs: z.number().int().positive(),
  riskLevel: z.string().min(1),
  requestId: z.string().min(1),
});

export const workerTaskCancelSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  reason: z.string().min(1),
});

// ── Message Types ────────────────────────────────────────────────────────────

export const WORKER_MESSAGE = {
  // worker -> core
  hello: "worker.hello",
  authenticate: "worker.authenticate",
  register: "worker.register",
  heartbeat: "worker.heartbeat",
  taskProgress: "worker.task_progress",
  taskResult: "worker.task_result",
  error: "worker.error",

  // core -> worker
  challenge: "worker.challenge",
  session: "worker.session",
  registered: "worker.registered",
  heartbeatAck: "worker.heartbeat_ack",
  taskDispatch: "worker.task_dispatch",
  taskCancel: "worker.task_cancel",
} as const;

export type WorkerMessageType = (typeof WORKER_MESSAGE)[keyof typeof WORKER_MESSAGE];

export const WORKER_PAYLOAD_SCHEMAS = {
  [WORKER_MESSAGE.hello]: workerHelloSchema,
  [WORKER_MESSAGE.authenticate]: workerAuthenticateSchema,
  [WORKER_MESSAGE.register]: workerRegisterSchema,
  [WORKER_MESSAGE.heartbeat]: workerHeartbeatSchema,
  [WORKER_MESSAGE.taskProgress]: workerTaskProgressSchema,
  [WORKER_MESSAGE.taskResult]: workerTaskResultSchema,
  [WORKER_MESSAGE.error]: workerErrorSchema,
  [WORKER_MESSAGE.challenge]: workerChallengeSchema,
  [WORKER_MESSAGE.session]: workerSessionSchema,
  [WORKER_MESSAGE.registered]: workerRegisteredSchema,
  [WORKER_MESSAGE.heartbeatAck]: workerHeartbeatAckSchema,
  [WORKER_MESSAGE.taskDispatch]: workerTaskDispatchSchema,
  [WORKER_MESSAGE.taskCancel]: workerTaskCancelSchema,
} as const;

export type WorkerPayload<T extends WorkerMessageType> = z.infer<
  (typeof WORKER_PAYLOAD_SCHEMAS)[T]
>;

export interface WorkerMessage<T extends WorkerMessageType = WorkerMessageType> {
  type: T;
  payload: WorkerPayload<T>;
  envelope: z.infer<typeof envelopeSchema>;
}

/** Parses and validates worker channel messages. */
export function parseWorkerMessage(input: unknown): WorkerMessage | undefined {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) return undefined;

  const type = envelope.data.type;
  if (!isWorkerMessageType(type)) return undefined;

  const schema = WORKER_PAYLOAD_SCHEMAS[type];
  const payload = schema.parse(envelope.data.payload);
  return { type, payload, envelope: envelope.data };
}

export function isWorkerMessageType(type: string): type is WorkerMessageType {
  return (Object.values(WORKER_MESSAGE) as string[]).includes(type);
}

/** Constructs a worker-channel envelope. */
export function workerEnvelope<T extends WorkerMessageType>(
  type: T,
  payload: WorkerPayload<T>,
  options: { id: string; at: Date; seq?: number },
): z.infer<typeof envelopeSchema> {
  return {
    v: WORKER_PROTOCOL_VERSION,
    id: options.id,
    type,
    ts: options.at.toISOString(),
    channel: WORKER_CHANNEL,
    ...(options.seq === undefined ? {} : { seq: options.seq }),
    payload,
  };
}
