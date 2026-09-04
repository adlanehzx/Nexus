import { z } from "zod";
import { envelopeSchema, PROTOCOL_VERSION } from "./envelope.js";

/**
 * Canal temps réel des clients.
 *
 * Le pendant de `worker.ts` pour l'autre bout du système : l'iPhone et le
 * portable parlent ici, les exécutants parlent là-bas. **Deux canaux, un seul
 * cadrage** — `envelopeSchema`, la même version, le même `id`, le même `ts`.
 *
 * La séparation n'est pas cosmétique. Un client ne doit jamais pouvoir émettre
 * une trame du canal worker : un `worker.task_result` forgé depuis un téléphone
 * ferait croire au cœur qu'une étape a réussi. Les deux canaux ont des types
 * disjoints, des schémas disjoints, et des points d'entrée disjoints.
 *
 * Règle qui gouverne tout le reste : **aucun client ne parle à un exécutant.**
 * Un client demande au cœur ; le cœur autorise, choisit, dispatche, et renvoie
 * les résultats. Il n'existe aucun message client dont la charge utile désigne
 * un worker.
 */

export const CLIENT_CHANNEL = "client";

/**
 * Poignée de main du canal client.
 *
 * **Volontairement hors de `CLIENT_TO_SERVER`.** Ce n'est pas une demande : elle
 * n'est pas routée vers le répartiteur, elle n'attend pas d'accusé, et elle est
 * la seule trame qu'une connexion non authentifiée a le droit d'émettre. La
 * garder dans la table des demandes reviendrait à autoriser un client à la
 * rejouer une fois la session ouverte, pour se réauthentifier en autre chose.
 *
 * Le `deviceId` ne prouve rien : le jeton dit *qui*, le `deviceId` dit *d'où*, et
 * le serveur vérifie que le second appartient bien au premier. Un identifiant
 * d'appareil seul n'est jamais une authentification.
 */
export const CLIENT_HELLO = "client.hello";

export const clientHelloSchema = z.object({
  accessToken: z.string().min(1),
  deviceId: z.string().min(1),
});

export type ClientHello = z.infer<typeof clientHelloSchema>;

/**
 * Décode une poignée de main.
 *
 * Rend `undefined` sur tout ce qui n'en est pas une, sans distinguer les causes :
 * une connexion qui n'ouvre pas par un `client.hello` valide est fermée, et
 * détailler *pourquoi* renseignerait un attaquant sur ce qui manque.
 */
export function parseClientHello(input: unknown): ClientHello | undefined {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success || envelope.data.type !== CLIENT_HELLO) return undefined;

  const hello = clientHelloSchema.safeParse(envelope.data.payload);
  return hello.success ? hello.data : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client → serveur
// ─────────────────────────────────────────────────────────────────────────────

export const messageSendSchema = z.object({
  conversationId: z.string().min(1).nullable().default(null),
  text: z.string().min(1).max(32_000),
  /**
   * Appareil d'où part la demande.
   *
   * Le fil de routage de toute l'architecture : les événements de la tâche qui
   * en découlera reviendront ici en priorité. Le serveur le **remplace** par
   * l'appareil réellement authentifié — un client ne choisit pas son identité.
   */
  originClientDeviceId: z.string().min(1).optional(),
});

export const agentCancelSchema = z.object({
  runId: z.string().min(1),
  reason: z.string().max(256).default("annulé par l'utilisateur"),
});

export const confirmationRespondSchema = z.object({
  confirmationId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
});

export const conversationSubscribeSchema = z.object({
  /** `null` s'abonne à tout ce qui concerne l'utilisateur. */
  conversationId: z.string().min(1).nullable().default(null),
});

export const taskCancelSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().max(256).default("annulé par l'utilisateur"),
});

export const deviceListSchema = z.object({
  /** Ne renvoyer que les exécutants. Faux = tous les appareils de l'utilisateur. */
  workersOnly: z.boolean().default(false),
});

// ─────────────────────────────────────────────────────────────────────────────
// Serveur → client
// ─────────────────────────────────────────────────────────────────────────────

export const messageDeltaSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  /** Fragment de texte. Le client concatène ; il ne reçoit jamais tout d'un coup. */
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
  /** Résumé lisible. **Jamais les arguments bruts.** */
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
  /** Exécutant de l'étape. `null` tant qu'aucun n'a été retenu. */
  deviceId: z.string().nullable().default(null),
  percent: z.number().int().min(0).max(100),
  label: z.string().nullable().default(null),
});

export const taskCompletedSchema = z.object({
  taskId: z.string(),
  status: z.enum(["succeeded", "partial"]),
  durationMs: z.number().nonnegative(),
});

/**
 * Une tâche a été annulée.
 *
 * Distinct de `task.failed`, et ce n'est pas une nuance : « j'ai dit non » et
 * « ça a échoué » n'appellent ni la même relance ni le même message. Sans ce
 * type, une tâche annulée — par un refus de confirmation ou par l'utilisateur —
 * restait affichée « en cours » indéfiniment sur tous les clients.
 */
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

/** Réponse à une demande client — porte le `requestId` de la demande. */
export const clientAckSchema = z.object({
  ok: z.boolean(),
  /** Charge utile de la réponse, propre à la demande. */
  data: z.unknown().nullable().default(null),
  error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
});

// ─────────────────────────────────────────────────────────────────────────────
// Types de messages
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Corrèle la réponse. Absent = le client ne veut pas d'accusé. */
  requestId: string | undefined;
  envelope: z.infer<typeof envelopeSchema>;
}

export function isClientRequestType(type: string): type is ClientToServerType {
  return Object.values(CLIENT_TO_SERVER).includes(type as ClientToServerType);
}

/**
 * Décode une trame montante.
 *
 * Trois issues, et la distinction compte :
 *
 *  - `undefined` — cadrage illisible ou type inconnu. Ignoré : un client plus
 *    récent que le serveur ne doit pas faire tomber la connexion.
 *  - **levée** — type connu mais charge utile invalide. C'est une erreur de
 *    programmation ou une falsification, pas une différence de version, et
 *    l'appelant répond par un accusé négatif.
 *  - un `ClientRequest` — utilisable.
 */
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

/** Construit une trame descendante du canal client. */
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

/**
 * Traduit un événement `NexusEvent` vers le canal client.
 *
 * Les événements internes et les messages temps réel ne portent pas les mêmes
 * noms — `worker.task_started` décrit ce que fait un exécutant, `task.progress`
 * décrit ce que le client doit afficher. Cette table est la frontière, et elle
 * est volontairement **partielle** : tout ce qui n'y figure pas ne descend pas
 * vers les clients.
 */
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
