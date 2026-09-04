import { uuidv7 } from "@nexus/shared";
import {
  CLIENT_TO_SERVER,
  EVENT_TO_CLIENT_MESSAGE,
  SERVER_TO_CLIENT,
  clientEnvelope,
  parseClientRequest,
  type ClientRequestPayload,
  type Envelope,
  type NexusEvent,
  type ServerToClientType,
} from "@nexus/protocol";
import type { ServiceContainer } from "../services/container.js";

/**
 * Canal temps réel des clients.
 *
 * Trois responsabilités, et pas une de plus :
 *
 *  1. **authentifier** la connexion — un jeton d'accès, puis un appareil qui
 *     appartient à l'utilisateur de ce jeton ;
 *  2. **traiter les demandes montantes**, chacune passant par les mêmes
 *     autorisations que la route REST équivalente ;
 *  3. **traduire les événements internes** en messages descendants.
 *
 * Ce qu'il ne fait pas : parler à un exécutant. Aucun message de ce canal ne
 * désigne un worker, et le seul chemin vers une machine passe par
 * `TaskCoordinator`, qui applique ses propres contrôles.
 *
 * La synchronisation entre l'iPhone et le portable ne demande aucun code
 * spécifique : `EventRouter` diffuse déjà à tous les clients de l'utilisateur,
 * l'appareil d'origine servi en premier. Ce canal ne fait que brancher une
 * connexion dessus.
 */

/** Une socket, réduite à ce dont ce module a besoin. */
export interface ClientSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface ClientConnectionContext {
  userId: string;
  sessionId: string;
  deviceId: string;
}

export interface ClientChannelOptions {
  services: ServiceContainer;
  now?: () => Date;
  newId?: () => string;
  onError?: (error: unknown, context: { type: string }) => void;
}

export class ClientChannel {
  readonly #services: ServiceContainer;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #onError: ClientChannelOptions["onError"];

  readonly #sockets = new Map<string, ClientSocket>();

  constructor(options: ClientChannelOptions) {
    this.#services = options.services;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#onError = options.onError;
  }

  get connectedDeviceIds(): string[] {
    return [...this.#sockets.keys()];
  }

  /**
   * Authentifie une connexion entrante.
   *
   * Deux preuves sont exigées, et la seconde n'est pas redondante : le jeton dit
   * *qui* se connecte, l'appareil dit *d'où*. Sans le second contrôle, un jeton
   * volé permettrait de se déclarer n'importe quel appareil et de détourner les
   * événements destinés à celui-ci.
   */
  async authenticate(input: {
    accessToken: string;
    deviceId: string;
  }): Promise<ClientConnectionContext> {
    const claims = this.#services.tokens.verifyAccessToken(input.accessToken);
    await this.#services.auth.assertSessionActive(claims.sid);

    const device = await this.#services.deviceRegistry.requireDevice(input.deviceId);
    if (device.userId !== claims.sub) {
      throw new Error("Appareil n'appartenant pas à l'utilisateur du jeton");
    }
    if (device.trust !== "TRUSTED" || device.revokedAt !== null) {
      throw new Error("Appareil non approuvé ou révoqué");
    }

    return { userId: claims.sub, sessionId: claims.sid, deviceId: device.id };
  }

  /**
   * Attache une connexion authentifiée.
   *
   * Le rattachement au routeur livre immédiatement ce qui a été manqué : un
   * iPhone rallumé après deux heures reçoit la file en attente avant tout
   * message neuf. C'est ce qui fait que les deux clients convergent au lieu de
   * diverger.
   */
  async attach(context: ClientConnectionContext, socket: ClientSocket): Promise<number> {
    this.#sockets.set(context.deviceId, socket);

    const backlog = await this.#services.router.attach({
      deviceId: context.deviceId,
      userId: context.userId,
      send: (event) => {
        this.#deliver(context.deviceId, event);
      },
    });

    return backlog.length;
  }

  detach(deviceId: string): void {
    this.#sockets.delete(deviceId);
    this.#services.router.detach(deviceId);
  }

  /**
   * Traite une trame montante.
   *
   * Ne lève jamais : toute issue devient un accusé. Une exception qui remonterait
   * ferait tomber la connexion, et le client perdrait aussi les événements sans
   * rapport avec sa demande.
   */
  async handle(context: ClientConnectionContext, raw: unknown): Promise<void> {
    let request: ReturnType<typeof parseClientRequest>;

    try {
      request = parseClientRequest(raw);
    } catch (cause) {
      // Type connu, charge utile invalide : c'est une erreur de programmation ou
      // une falsification, et le client doit le savoir.
      this.#ack(context.deviceId, undefined, {
        ok: false,
        data: null,
        error: { code: "INVALID_PAYLOAD", message: describe(cause) },
      });
      return;
    }

    // Cadrage illisible ou type inconnu : ignoré en silence. Un client plus
    // récent que le serveur ne doit pas voir sa connexion fermée.
    if (request === undefined) return;

    try {
      const data = await this.#dispatch(context, request.type, request.payload);
      this.#ack(context.deviceId, request.requestId, { ok: true, data, error: null });
    } catch (cause) {
      this.#onError?.(cause, { type: request.type });
      this.#ack(context.deviceId, request.requestId, {
        ok: false,
        data: null,
        error: { code: codeOf(cause), message: describe(cause) },
      });
    }
  }

  async #dispatch(
    context: ClientConnectionContext,
    type: string,
    payload: unknown,
  ): Promise<unknown> {
    switch (type) {
      case CLIENT_TO_SERVER.conversationSubscribe: {
        // L'abonnement est implicite : le routeur diffuse déjà tout ce qui
        // concerne l'utilisateur. On confirme la portée demandée pour que le
        // client sache à quoi s'attendre, sans créer un second mécanisme de
        // filtrage qui divergerait du premier.
        const input = payload as ClientRequestPayload<"conversation.subscribe">;
        return { subscribed: true, conversationId: input.conversationId };
      }

      case CLIENT_TO_SERVER.deviceList: {
        const input = payload as ClientRequestPayload<"device.list">;
        const devices = input.workersOnly
          ? await this.#services.deviceRegistry.getWorkerDevices(context.userId)
          : await this.#services.deviceRegistry.listDevices(context.userId);

        return {
          devices: devices.map((device) => ({
            id: device.id,
            name: device.name,
            role: device.role,
            status: device.status,
            capabilities: device.capabilities.filter((c) => c.enabled).map((c) => c.name),
          })),
        };
      }

      case CLIENT_TO_SERVER.messageSend: {
        const input = payload as ClientRequestPayload<"message.send">;

        // L'appareil d'origine est **imposé**, pas accepté : un client ne
        // choisit pas son identité. C'est la connexion authentifiée qui le dit.
        const conversationId =
          input.conversationId ??
          (
            await this.#services.conversations.create({
              userId: context.userId,
              title: input.text.slice(0, 60),
            })
          ).id;

        const conversation = await this.#services.conversations.get(conversationId);
        if (conversation?.userId !== context.userId) {
          throw new Error("Conversation inconnue");
        }

        const message = await this.#services.conversations.appendMessage({
          conversationId,
          role: "user",
          content: input.text,
          originClientDeviceId: context.deviceId,
        });

        return { conversationId, messageId: message.id };
      }

      case CLIENT_TO_SERVER.confirmationRespond: {
        const input = payload as ClientRequestPayload<"confirmation.respond">;

        // N'importe quel appareil de l'utilisateur peut trancher : la demande
        // vit au centre, pas dans le client qui l'a affichée.
        const accepted = await this.#services.confirmationBroker.respondAndRecord(
          input.confirmationId,
          input.decision,
          context.userId,
        );
        return { accepted };
      }

      case CLIENT_TO_SERVER.taskCancel: {
        const input = payload as ClientRequestPayload<"task.cancel">;
        const plan = await this.#services.taskStore.get(input.taskId);

        if (plan?.userId !== context.userId) {
          throw new Error("Tâche inconnue");
        }

        return { cancelled: this.#services.supervisor.cancel(input.taskId, context.userId) };
      }

      case CLIENT_TO_SERVER.agentCancel: {
        const input = payload as ClientRequestPayload<"agent.cancel">;
        // Un run agent s'annule par le même chemin qu'une tâche : le
        // superviseur tient les exécutions en vol, quel que soit ce qui les a
        // déclenchées — et vérifie le propriétaire, comme pour une tâche. Ce
        // chemin-ci ne consultait aucun magasin et ne vérifiait donc rien.
        return { cancelled: this.#services.supervisor.cancel(input.runId, context.userId) };
      }

      default:
        throw new Error(`Type de demande non traité : ${type}`);
    }
  }

  /**
   * Traduit un événement interne en message descendant.
   *
   * La table de correspondance est **partielle**, et c'est le point : tout ce
   * qui n'y figure pas ne descend pas. Les événements `worker.*` décrivent ce
   * que fait une machine ; les clients voient `task.*`, qui décrit ce qu'ils
   * doivent afficher. Diffuser les premiers révélerait la topologie de la flotte
   * à chaque client sans raison.
   */
  #deliver(deviceId: string, event: NexusEvent): void {
    const type = EVENT_TO_CLIENT_MESSAGE[event.type];
    if (type === undefined) return;

    const socket = this.#sockets.get(deviceId);
    if (socket === undefined) return;

    socket.send(JSON.stringify(this.#toClientMessage(type, event)));
  }

  #toClientMessage(type: ServerToClientType, event: NexusEvent): Envelope {
    const { v: _v, id: _id, type: _type, at: _at, userId: _userId, ...rest } = event;

    return clientEnvelope(type, rest as never, {
      id: this.#newId(),
      at: new Date(event.at),
    });
  }

  #ack(
    deviceId: string,
    requestId: string | undefined,
    payload: { ok: boolean; data: unknown; error: { code: string; message: string } | null },
  ): void {
    const socket = this.#sockets.get(deviceId);
    if (socket === undefined) return;

    socket.send(
      JSON.stringify(
        clientEnvelope(SERVER_TO_CLIENT.ack, payload, {
          id: this.#newId(),
          at: this.#now(),
          requestId,
        }),
      ),
    );
  }

  /** Envoie un message hors événement — flux de réponse de l'agent. */
  push<T extends ServerToClientType>(
    deviceId: string,
    type: T,
    payload: Parameters<typeof clientEnvelope<T>>[1],
  ): boolean {
    const socket = this.#sockets.get(deviceId);
    if (socket === undefined) return false;

    socket.send(
      JSON.stringify(clientEnvelope(type, payload, { id: this.#newId(), at: this.#now() })),
    );
    return true;
  }
}

function describe(cause: unknown): string {
  // Le message d'une `AppError` est sûr à afficher ; celui d'une exception
  // inconnue peut contenir un chemin ou un fragment de requête.
  if (cause !== null && typeof cause === "object" && "userMessage" in cause) {
    return String(cause.userMessage);
  }
  return cause instanceof Error ? cause.message : "Erreur inattendue";
}

function codeOf(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "code" in cause) {
    return String(cause.code);
  }
  return "INTERNAL_ERROR";
}
