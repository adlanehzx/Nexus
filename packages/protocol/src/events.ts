import { z } from "zod";

/**
 * Événements NEXUS.
 *
 * Ils vivent dans `@nexus/protocol` — et pas dans le cœur — parce que trois
 * mondes les partagent : le cœur qui les émet, les clients qui les affichent,
 * les workers qui en produisent. Un type d'événement est un **contrat public**.
 *
 * Deux règles d'évolution, tenues :
 *
 *  1. **Versionné.** Chaque enveloppe porte `v`. Une version majeure différente
 *     fait fermer la connexion plutôt que d'être mal interprétée.
 *  2. **Additif.** On ajoute des types d'événements, jamais on n'en retire ni
 *     n'en renomme. Un client du magasin d'applications a des mois de retard —
 *     il doit pouvoir ignorer ce qu'il ne connaît pas sans casser.
 */

export const EVENT_SCHEMA_VERSION = 1;

/**
 * Ce qui accompagne tout événement.
 *
 * `originClientDeviceId` est le fil de routage : la tâche part de l'iPhone,
 * s'exécute sur le poste fixe, et ses événements reviennent à l'iPhone. Sans ce
 * champ transporté de bout en bout, il faudrait le retrouver à chaque saut.
 */
export const eventEnvelopeSchema = z.object({
  v: z.literal(EVENT_SCHEMA_VERSION),
  id: z.string().min(1),
  type: z.string().min(1),
  at: z.iso.datetime(),
  userId: z.string().min(1),
  correlationId: z.string().min(1),
  /** Appareil d'où part la demande. Null pour un événement issu du système. */
  originClientDeviceId: z.string().nullable(),
});

/**
 * Socle commun, **sans** `type` : chaque événement déclare son propre littéral.
 *
 * Le garder ici ferait fusionner `z.string()` avec un `z.literal(...)`, et le
 * type inféré retomberait sur `never` — l'union discriminée cesserait
 * silencieusement de discriminer quoi que ce soit.
 */
const { type: _discriminator, ...baseShape } = eventEnvelopeSchema.shape;

const withBase = <T extends z.ZodRawShape>(shape: T) => z.object({ ...baseShape, ...shape });

// ─────────────────────────────────────────────────────────────────────────────
// Agent — le raisonnement
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Tâches — l'exécution répartie
// ─────────────────────────────────────────────────────────────────────────────

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
    /**
     * Machine qui vient d'exécuter l'étape.
     *
     * `null` tant qu'aucune n'a été retenue — une étape refusée à
     * l'autorisation n'atteint jamais d'exécutant. Ce champ descend jusqu'aux
     * clients, parce qu'« en cours » sans dire *où* n'apprend rien à
     * l'utilisateur : c'est la différence entre « ça travaille » et « le poste
     * fixe compile pendant que je regarde mon téléphone ».
     */
    deviceId: z.string().nullable().default(null),
    /** Progression du plan entier, de 0 à 100. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Appareils
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Workers — l'exécution vue depuis l'appareil
// ─────────────────────────────────────────────────────────────────────────────

const workerEvents = [
  // `device.connected` dit « le registre a vu cette machine ». `worker.connected`
  // dit « le canal d'exécution est ouvert ». Un appareil peut être connu et
  // joignable sans être prêt à exécuter — la distinction sert au diagnostic.
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
    /** Étapes interrompues par la coupure : elles seront reprises ailleurs. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Confirmations et notifications
// ─────────────────────────────────────────────────────────────────────────────

const confirmationEvents = [
  withBase({
    type: z.literal("confirmation.required"),
    confirmationId: z.string(),
    taskId: z.string().nullable(),
    stepId: z.string().nullable(),
    /** Capacité demandée, telle qu'elle apparaîtra dans les réglages. */
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
    /** Appareil qui a tranché — pas forcément celui qui a demandé. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Union
// ─────────────────────────────────────────────────────────────────────────────

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

/** Tous les types connus. Sert aux abonnements et aux tests d'exhaustivité. */
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

/** Famille d'un événement — sert au filtrage d'abonnement côté client. */
export function eventFamily(type: NexusEventType): string {
  return type.split(".")[0] ?? type;
}

/**
 * Valide un événement entrant.
 *
 * Un type inconnu est **ignoré**, pas rejeté : c'est ce qui permet d'ajouter des
 * événements sans casser les clients déjà déployés.
 */
export function parseNexusEvent(input: unknown): NexusEvent | undefined {
  const result = nexusEventSchema.safeParse(input);
  return result.success ? result.data : undefined;
}
