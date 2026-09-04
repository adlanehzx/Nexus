import { uuidv7 } from "@nexus/shared";
import {
  EVENT_SCHEMA_VERSION,
  nexusEventSchema,
  type NexusEvent,
  type NexusEventType,
} from "@nexus/protocol";
import type { DeviceRegistry } from "./registry.js";
import { canReceiveEvents, type Device } from "./types.js";

/**
 * Routage et synchronisation des événements.
 *
 * Deux règles produisent tout le comportement attendu :
 *
 *  1. **L'appareil d'origine est prioritaire** — il reçoit d'abord, parce que
 *     c'est là que l'utilisateur regarde.
 *  2. **Tous les clients de l'utilisateur reçoivent quand même.** Une tâche
 *     lancée depuis le portable est visible sur l'iPhone, et réciproquement.
 *
 * La synchronisation passe **exclusivement par le centre**. Aucun client ne
 * parle à un autre : pas de pair-à-pair, pas d'état partagé hors du backend.
 * C'est ce qui garantit qu'un iPhone rallumé après deux heures voit le même état
 * que le portable resté connecté.
 */

/** Un canal ouvert vers un client connecté. */
export interface ClientConnection {
  deviceId: string;
  userId: string;
  send(event: NexusEvent): void | Promise<void>;
}

export interface DeliveryReport {
  event: NexusEvent;
  /** Clients qui ont réellement reçu l'événement. */
  deliveredTo: string[];
  /** Clients connus mais déconnectés — l'événement les attend en file. */
  queuedFor: string[];
  /** Vrai si l'appareil d'origine était joignable. */
  originReached: boolean;
}

/**
 * File d'attente d'un client déconnecté.
 *
 * Bornée : un iPhone éteint une semaine ne doit pas faire enfler la mémoire.
 * Au-delà, les plus anciens événements sont perdus — un client qui revient de
 * loin resynchronise son état complet plutôt que de rejouer l'historique.
 */
export interface PendingQueueOptions {
  maxPerDevice?: number;
}

export interface EventRouterOptions {
  registry: DeviceRegistry;
  queue?: PendingQueueOptions;
  now?: () => Date;
  newId?: () => string;
  /** Journalisation d'audit. Reçoit l'événement **déjà validé**. */
  onPublished?: (report: DeliveryReport) => void;
}

export interface EmitInput {
  type: NexusEventType;
  userId: string;
  correlationId: string;
  originClientDeviceId?: string | null;
  /** Charge utile propre au type d'événement. */
  payload: Record<string, unknown>;
}

export class EventRouter {
  readonly #registry: DeviceRegistry;
  readonly #connections = new Map<string, ClientConnection>();
  readonly #pending = new Map<string, NexusEvent[]>();
  readonly #maxPerDevice: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #onPublished: ((report: DeliveryReport) => void) | undefined;

  constructor(options: EventRouterOptions) {
    this.#registry = options.registry;
    this.#maxPerDevice = options.queue?.maxPerDevice ?? 200;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#onPublished = options.onPublished;
  }

  // ── Connexions ──────────────────────────────────────────────────────────

  /**
   * Attache un client connecté et lui livre ce qu'il a manqué.
   *
   * C'est ici que se joue la synchronisation : un iPhone qui se reconnecte
   * reçoit immédiatement les événements survenus pendant son absence.
   */
  async attach(connection: ClientConnection): Promise<NexusEvent[]> {
    this.#connections.set(connection.deviceId, connection);

    const backlog = this.#pending.get(connection.deviceId) ?? [];
    this.#pending.delete(connection.deviceId);

    for (const event of backlog) await connection.send(event);
    return backlog;
  }

  detach(deviceId: string): void {
    this.#connections.delete(deviceId);
  }

  isConnected(deviceId: string): boolean {
    return this.#connections.has(deviceId);
  }

  get connectedDeviceIds(): string[] {
    return [...this.#connections.keys()];
  }

  // ── Publication ─────────────────────────────────────────────────────────

  /**
   * Construit, valide et diffuse un événement.
   *
   * La validation n'est pas une formalité : un événement mal formé qui atteint
   * un client mobile y provoque une erreur de désérialisation, loin de sa cause.
   * On le refuse ici, là où la pile est encore lisible.
   */
  async emit(input: EmitInput): Promise<DeliveryReport> {
    const event = nexusEventSchema.parse({
      v: EVENT_SCHEMA_VERSION,
      id: this.#newId(),
      type: input.type,
      at: this.#now().toISOString(),
      userId: input.userId,
      correlationId: input.correlationId,
      originClientDeviceId: input.originClientDeviceId ?? null,
      ...input.payload,
    });

    return this.publish(event);
  }

  /** Diffuse un événement déjà construit. */
  async publish(event: NexusEvent): Promise<DeliveryReport> {
    const clients = await this.#registry.getClientDevices(event.userId);
    const targets = this.#orderTargets(clients, event.originClientDeviceId);

    const deliveredTo: string[] = [];
    const queuedFor: string[] = [];

    for (const device of targets) {
      const connection = this.#connections.get(device.id);
      if (connection === undefined) {
        this.#enqueue(device.id, event);
        queuedFor.push(device.id);
        continue;
      }

      try {
        await connection.send(event);
        deliveredTo.push(device.id);
      } catch {
        // Un envoi qui échoue vaut une déconnexion : on met en file et on
        // détache, plutôt que de perdre l'événement en silence.
        this.detach(device.id);
        this.#enqueue(device.id, event);
        queuedFor.push(device.id);
      }
    }

    const report: DeliveryReport = {
      event,
      deliveredTo,
      queuedFor,
      originReached:
        event.originClientDeviceId === null || deliveredTo.includes(event.originClientDeviceId),
    };

    try {
      this.#onPublished?.(report);
    } catch {
      // L'audit ne doit pas faire échouer une diffusion.
    }
    return report;
  }

  /**
   * Diffuse à **un seul** appareil, sans mise en file.
   *
   * Réservé à ce qui n'a de sens que pour son destinataire immédiat — la
   * réponse à une commande, par exemple. Tout ce qui décrit l'état de NEXUS
   * passe par `publish`, sinon les clients divergent.
   */
  async sendTo(deviceId: string, event: NexusEvent): Promise<boolean> {
    const connection = this.#connections.get(deviceId);
    if (connection === undefined) return false;

    try {
      await connection.send(event);
      return true;
    } catch {
      this.detach(deviceId);
      return false;
    }
  }

  /** Événements en attente pour un appareil — diagnostic et tests. */
  pendingFor(deviceId: string): readonly NexusEvent[] {
    return this.#pending.get(deviceId) ?? [];
  }

  /**
   * Ordonne les destinataires : l'origine d'abord.
   *
   * L'utilisateur regarde l'appareil depuis lequel il a lancé la demande ; c'est
   * lui qui doit réagir en premier, même de quelques millisecondes.
   */
  #orderTargets(clients: readonly Device[], originId: string | null): Device[] {
    const eligible = clients.filter((device) => canReceiveEvents(device.role));
    if (originId === null) return eligible;

    const origin = eligible.filter((device) => device.id === originId);
    const others = eligible.filter((device) => device.id !== originId);
    return [...origin, ...others];
  }

  #enqueue(deviceId: string, event: NexusEvent): void {
    const queue = this.#pending.get(deviceId) ?? [];
    queue.push(event);

    // File bornée : un appareil éteint longtemps resynchronisera son état
    // complet plutôt que de rejouer un historique interminable.
    if (queue.length > this.#maxPerDevice) queue.splice(0, queue.length - this.#maxPerDevice);
    this.#pending.set(deviceId, queue);
  }
}
