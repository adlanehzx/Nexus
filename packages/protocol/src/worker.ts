import { z } from "zod";
import { envelopeSchema, PROTOCOL_VERSION } from "./envelope.js";

/**
 * Contrat de fil entre le cœur NEXUS et un exécutant.
 *
 * **Ce n'est pas un second protocole WebSocket.** Le cadrage reste
 * `envelopeSchema` — même version, même `id`, même `ts`. Ce fichier décrit
 * uniquement les *charges utiles* qui circulent sur le canal `worker`.
 *
 * Il vit dans `@nexus/protocol` parce que trois codes le lisent : le cœur qui
 * dispatche, le worker Windows qui exécute, et demain le worker Android. Le
 * placer dans l'un des trois en ferait le propriétaire des deux autres.
 *
 * Le sens de la connexion est toujours le même : **le worker appelle le cœur**.
 * Aucun port entrant, aucune redirection de port, aucune machine exposée à
 * Internet. Le cœur ne sait pas joindre un worker — il répond sur une connexion
 * que le worker a ouverte.
 */

export const WORKER_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Canal réservé aux exécutants. Les clients n'y ont jamais accès. */
export const WORKER_CHANNEL = "worker";

// ─────────────────────────────────────────────────────────────────────────────
// Capacité, forme de fil
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capacité telle qu'un worker la déclare.
 *
 * Structurellement identique à `DeviceCapability` de `@nexus/devices`, et
 * délibérément déclarée à part : le modèle de domaine et le contrat de fil
 * évoluent à des rythmes différents. Renommer un champ du domaine ne doit pas
 * casser un worker déployé sur une machine qu'on ne redémarre pas ce jour-là.
 */
export const workerCapabilitySchema = z.object({
  /**
   * Nom de la capacité.
   *
   * Volontairement permissif ici : la forme `domaine.action` est vérifiée par le
   * **modèle de domaine**, côté cœur. Si le fil l'imposait, un worker déclarant
   * une seule capacité mal nommée verrait sa trame entière rejetée, et perdrait
   * les quinze autres — au lieu de recevoir un refus nominatif pour celle-là.
   */
  name: z.string().min(1).max(128),
  version: z.string().default("1"),
  description: z.string().default(""),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type WorkerCapability = z.infer<typeof workerCapabilitySchema>;

/**
 * Santé déclarée au battement de cœur.
 *
 * Volontairement pauvre. NEXUS a besoin de savoir s'il peut confier une tâche à
 * cette machine — pas de la superviser. Rien ici n'identifie l'utilisateur, ne
 * décrit ce qui tourne, ni ne quitte le réseau de l'utilisateur.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Worker → cœur
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Première trame. Elle n'authentifie rien.
 *
 * Le worker annonce qui il prétend être ; le cœur répond par un challenge. Un
 * identifiant d'appareil est public — il ne prouve rien, et cette trame ne
 * donne accès à rien.
 */
export const workerHelloSchema = z.object({
  deviceId: z.string().min(1),
  workerVersion: z.string().min(1),
  platform: z.string().min(1),
});

export const workerAuthenticateSchema = z.object({
  deviceId: z.string().min(1),
  /** Nonce reçu dans le challenge, signé par la clé privée de la machine. */
  nonce: z.string().min(1),
  signature: z.string().min(1),
  /** Capacités revendiquées. Le cœur les borne à celles enregistrées. */
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

/**
 * Fin d'une étape, dans un sens ou dans l'autre.
 *
 * `result` traverse le réseau ; il est **rédigé côté worker** avant l'envoi. Ce
 * qu'un processus écrit sur sa sortie standard n'est pas maîtrisé — un script
 * qui affiche sa clé d'API ne doit pas la faire entrer dans le journal du cœur.
 */
export const workerTaskResultSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().nullable().default(null),
  /**
   * Le résultat ne doit pas être conservé par le cœur.
   *
   * Il est transmis au client qui l'a demandé, mais le journal d'exécution n'en
   * garde qu'une mention. Une capture d'écran de téléphone rangée dans une table
   * d'audit est une fuite qui survit des mois à la demande qui l'a produite.
   */
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
  /** Étape concernée, si l'erreur en vise une. */
  stepId: z.string().nullable().default(null),
});

// ─────────────────────────────────────────────────────────────────────────────
// Cœur → worker
// ─────────────────────────────────────────────────────────────────────────────

export const workerChallengeSchema = z.object({
  nonce: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

/**
 * Session ouverte.
 *
 * `token` ne transite qu'ici, une fois, sur une connexion chiffrée. Il n'est
 * jamais journalisé ni renvoyé. Le worker le garde en mémoire pour se
 * réauthentifier plus vite après une coupure brève.
 */
export const workerSessionSchema = z.object({
  sessionId: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  /** Capacités réellement accordées — l'intersection fait foi. */
  capabilities: z.array(z.string()),
});

export const workerRegisteredSchema = z.object({
  accepted: z.array(z.string()),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
});

export const workerHeartbeatAckSchema = z.object({
  at: z.iso.datetime(),
  /** Le cœur peut exiger une rotation avant expiration. */
  rotateSession: z.boolean().default(false),
});

/**
 * Ordre d'exécution d'une étape.
 *
 * Il ne porte **jamais** de commande shell. Il porte une *capacité* et des
 * arguments structurés que le worker validera contre son propre schéma avant
 * d'exécuter quoi que ce soit. C'est la différence entre « exécute ceci » et
 * « fais cette chose que tu sais faire ».
 */
export const workerTaskDispatchSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  capability: z.string().min(1),
  /** Nom d'outil côté cœur, conservé pour la trace. */
  tool: z.string().min(1),
  arguments: z.unknown(),
  timeoutMs: z.number().int().positive(),
  riskLevel: z.string().min(1),
  /** Rend le dispatch idempotent : un renvoi après coupure ne réexécute pas. */
  requestId: z.string().min(1),
});

export const workerTaskCancelSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  reason: z.string().min(1),
});

// ─────────────────────────────────────────────────────────────────────────────
// Types de messages
// ─────────────────────────────────────────────────────────────────────────────

export const WORKER_MESSAGE = {
  // worker → cœur
  hello: "worker.hello",
  authenticate: "worker.authenticate",
  register: "worker.register",
  heartbeat: "worker.heartbeat",
  taskProgress: "worker.task_progress",
  taskResult: "worker.task_result",
  error: "worker.error",

  // cœur → worker
  challenge: "worker.challenge",
  session: "worker.session",
  registered: "worker.registered",
  heartbeatAck: "worker.heartbeat_ack",
  taskDispatch: "worker.task_dispatch",
  taskCancel: "worker.task_cancel",
} as const;

export type WorkerMessageType = (typeof WORKER_MESSAGE)[keyof typeof WORKER_MESSAGE];

/** Schéma de charge utile par type de message. */
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
  /** Enveloppe d'origine — utile pour le diagnostic et la corrélation. */
  envelope: z.infer<typeof envelopeSchema>;
}

/**
 * Décode une trame du canal worker.
 *
 * Retourne `undefined` sur un type inconnu, comme `parseNexusEvent` : un worker
 * plus ancien que le cœur doit ignorer ce qu'il ne comprend pas, pas tomber.
 * Une charge utile **malformée pour un type connu**, en revanche, lève : c'est
 * un défaut de programmation ou une falsification, pas une différence de
 * version.
 */
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

/** Construit une enveloppe du canal worker. */
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
