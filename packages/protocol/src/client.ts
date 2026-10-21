import { z } from "zod";
import { envelopeSchema, PROTOCOL_VERSION } from "./envelope.js";

/**
 * Client real-time channel.
 *
 * Dedicated protocol surface for client applications (mobile, desktop, web).
 * Uses envelopeSchema with strict separation from worker-side messages.
 *
 * Fundamental invariant: clients never address workers directly.
 * Clients communicate strictly through the core gateway.
 */

export const CLIENT_CHANNEL = "client";

/**
 * Client handshake message.
 * Non-routed, non-repayable authentication frame.
 */
export const CLIENT_HELLO = "client.hello";

export const clientHelloSchema = z.object({
  accessToken: z.string().min(1),
  deviceId: z.string().min(1),
});

export type ClientHello = z.infer<typeof clientHelloSchema>;

/** Decodes and validates a client handshake envelope. */
export function parseClientHello(input: unknown): ClientHello | undefined {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success || envelope.data.type !== CLIENT_HELLO) return undefined;

  const hello = clientHelloSchema.safeParse(envelope.data.payload);
  return hello.success ? hello.data : undefined;
}

// ── Client -> Server ─────────────────────────────────────────────────────────

export const messageSendSchema = z.object({
  conversationId: z.string().min(1).nullable().default(null),
  text: z.string().min(1).max(32_000),
  /** Request origin device ID. Populated or overridden by authenticated gateway session. */
  originClientDeviceId: z.string().min(1).optional(),
});

export const agentCancelSchema = z.object({
  runId: z.string().min(1),
  reason: z.string().max(256).default("cancelled by user"),
});

export const confirmationRespondSchema = z.object({
  confirmationId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
});

export const conversationSubscribeSchema = z.object({
  /** Null subscribes to all user conversations and events. */
  conversationId: z.string().min(1).nullable().default(null),
});

export const taskCancelSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().max(256).default("cancelled by user"),
});

export const deviceListSchema = z.object({
  /** Only return worker devices when true; all user devices when false. */
  workersOnly: z.boolean().default(false),
});

// ── Server -> Client ─────────────────────────────────────────────────────────

export const messageDeltaSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  done: z.boolean().default(false),
});

export const agentStartedSchema = z.object({
  runId: z.string(),
  conversationId: z.string(),
});

export const agentProgressSchema = z.object({
  runId: z.string(),
  iteration: z.number().int().nonnegative(),
  label: z.string().nullable().default(null),
});

export const toolStartedSchema = z.object({
  runId: z.string(),
  callId: z.string(),
  tool: z.string(),
  summary: z.string(),
  riskLevel: z.string(),
});

export const toolProgressSchema = z.object({
  runId: z.string(),
  callId: z.string(),
  percent: z.number().int().min(0).max(100).nullable().default(null),
  label: z.string().nullable().default(null),
});

export const toolCompletedSchema = z.object({
  runId: z.string(),
  callId: z.string(),
  tool: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  durationMs: z.number().nonnegative(),
});

export const confirmationRequiredSchema = z.object({
  confirmationId: z.string(),
  taskId: z.string().nullable().default(null),
  stepId: z.string().nullable().default(null),
  capability: z.string().nullable().default(null),
  action: z.string(),
  description: z.string(),
  riskLevel: z.string(),
  expiresAt: z.iso.datetime(),
});

export const taskCreatedSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  stepCount: z.number().int().positive(),
});

export const taskProgressSchema = z.object({
  taskId: z.string(),
  stepId: z.string(),
  deviceId: z.string().nullable().default(null),
  percent: z.number().int().min(0).max(100),
  label: z.string().nullable().default(null),
});

export const taskCompletedSchema = z.object({
  taskId: z.string(),
  status: z.enum(["succeeded", "partial"]),
  durationMs: z.number().nonnegative(),
});

export const taskCancelledSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});

export const taskFailedSchema = z.object({
  taskId: z.string(),
  code: z.string(),
  message: z.string(),
});

export const deviceUpdatedSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  status: z.string(),
  role: z.string(),
  capabilities: z.array(z.string()),
});

export const notificationCreatedSchema = z.object({
  notificationId: z.string(),
  title: z.string(),
  body: z.string(),
  severity: z.enum(["info", "warning", "error"]),
});

export const clientAckSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().nullable().default(null),
  error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
});

// ── Message Types ────────────────────────────────────────────────────────────

export const CLIENT_TO_SERVER = {
  messageSend: "message.send",
  agentCancel: "agent.cancel",
  confirmationRespond: "confirmation.respond",
  conversationSubscribe: "conversation.subscribe",
  taskCancel: "task.cancel",
  deviceList: "device.list",
} as const;

export const SERVER_TO_CLIENT = {
  ack: "client.ack",
  messageDelta: "message.delta",
  agentStarted: "agent.started",
  agentProgress: "agent.progress",
  toolStarted: "tool.started",
  toolProgress: "tool.progress",
  toolCompleted: "tool.completed",
  confirmationRequired: "confirmation.required",
  taskCreated: "task.created",
  taskProgress: "task.progress",
  taskCompleted: "task.completed",
  taskFailed: "task.failed",
  taskCancelled: "task.cancelled",
  deviceUpdated: "device.updated",
  notificationCreated: "notification.created",
} as const;

export type ClientToServerType = (typeof CLIENT_TO_SERVER)[keyof typeof CLIENT_TO_SERVER];
export type ServerToClientType = (typeof SERVER_TO_CLIENT)[keyof typeof SERVER_TO_CLIENT];

export const CLIENT_REQUEST_SCHEMAS = {
  [CLIENT_TO_SERVER.messageSend]: messageSendSchema,
  [CLIENT_TO_SERVER.agentCancel]: agentCancelSchema,
  [CLIENT_TO_SERVER.confirmationRespond]: confirmationRespondSchema,
  [CLIENT_TO_SERVER.conversationSubscribe]: conversationSubscribeSchema,
  [CLIENT_TO_SERVER.taskCancel]: taskCancelSchema,
  [CLIENT_TO_SERVER.deviceList]: deviceListSchema,
} as const;

export const SERVER_EVENT_SCHEMAS = {
  [SERVER_TO_CLIENT.ack]: clientAckSchema,
  [SERVER_TO_CLIENT.messageDelta]: messageDeltaSchema,
  [SERVER_TO_CLIENT.agentStarted]: agentStartedSchema,
  [SERVER_TO_CLIENT.agentProgress]: agentProgressSchema,
  [SERVER_TO_CLIENT.toolStarted]: toolStartedSchema,
  [SERVER_TO_CLIENT.toolProgress]: toolProgressSchema,
  [SERVER_TO_CLIENT.toolCompleted]: toolCompletedSchema,
  [SERVER_TO_CLIENT.confirmationRequired]: confirmationRequiredSchema,
  [SERVER_TO_CLIENT.taskCreated]: taskCreatedSchema,
  [SERVER_TO_CLIENT.taskProgress]: taskProgressSchema,
  [SERVER_TO_CLIENT.taskCompleted]: taskCompletedSchema,
  [SERVER_TO_CLIENT.taskFailed]: taskFailedSchema,
  [SERVER_TO_CLIENT.taskCancelled]: taskCancelledSchema,
  [SERVER_TO_CLIENT.deviceUpdated]: deviceUpdatedSchema,
  [SERVER_TO_CLIENT.notificationCreated]: notificationCreatedSchema,
} as const;

export type ClientRequestPayload<T extends ClientToServerType> = z.infer<
  (typeof CLIENT_REQUEST_SCHEMAS)[T]
>;
export type ServerEventPayload<T extends ServerToClientType> = z.infer<
  (typeof SERVER_EVENT_SCHEMAS)[T]
>;

export interface ClientRequest<T extends ClientToServerType = ClientToServerType> {
  type: T;
  payload: ClientRequestPayload<T>;
  requestId: string | undefined;
  envelope: z.infer<typeof envelopeSchema>;
}

export function isClientRequestType(type: string): type is ClientToServerType {
  return Object.values(CLIENT_TO_SERVER).includes(type as ClientToServerType);
}

/** Parses and validates incoming client requests. */
export function parseClientRequest(input: unknown): ClientRequest | undefined {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) return undefined;

  const type = envelope.data.type;
  if (!isClientRequestType(type)) return undefined;

  const payload = CLIENT_REQUEST_SCHEMAS[type].parse(envelope.data.payload);

  return {
    type,
    payload,
    requestId: envelope.data.requestId,
    envelope: envelope.data,
  };
}

/** Constructs a downstream client-channel envelope. */
export function clientEnvelope<T extends ServerToClientType>(
  type: T,
  payload: ServerEventPayload<T>,
  options: { id: string; at: Date; requestId?: string | undefined; seq?: number },
): z.infer<typeof envelopeSchema> {
  return {
    v: PROTOCOL_VERSION,
    id: options.id,
    type,
    ts: options.at.toISOString(),
    channel: CLIENT_CHANNEL,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(options.seq === undefined ? {} : { seq: options.seq }),
    payload,
  };
}

/** Translates internal NexusEvents into client-facing WebSocket frames. */
export const EVENT_TO_CLIENT_MESSAGE: Record<string, ServerToClientType | undefined> = {
  "agent.started": SERVER_TO_CLIENT.agentStarted,
  "agent.progress": SERVER_TO_CLIENT.agentProgress,
  "task.created": SERVER_TO_CLIENT.taskCreated,
  "task.progress": SERVER_TO_CLIENT.taskProgress,
  "task.completed": SERVER_TO_CLIENT.taskCompleted,
  "task.failed": SERVER_TO_CLIENT.taskFailed,
  "task.cancelled": SERVER_TO_CLIENT.taskCancelled,
  "confirmation.required": SERVER_TO_CLIENT.confirmationRequired,
  "notification.created": SERVER_TO_CLIENT.notificationCreated,
  "device.connected": SERVER_TO_CLIENT.deviceUpdated,
  "device.disconnected": SERVER_TO_CLIENT.deviceUpdated,
  "device.status_changed": SERVER_TO_CLIENT.deviceUpdated,
  "device.capabilities_changed": SERVER_TO_CLIENT.deviceUpdated,
};
