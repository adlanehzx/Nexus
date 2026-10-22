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
 * Real-time client channel.
 *
 * Three responsibilities, and no more:
 *
 *  1. **Authenticate** the connection — an access token, then a device
 *     belonging to the user of that token;
 *  2. **Handle upstream requests**, each passing through the same
 *     authorizations as the equivalent REST route;
 *  3. **Translate internal events** into downstream messages.
 *
 * What it does not do: talk directly to an executor. No message on this channel
 * addresses a worker, and the only path to a machine passes through
 * `TaskCoordinator`, which applies its own controls.
 *
 * Synchronization between iPhone and laptop requires no specific code:
 * `EventRouter` already broadcasts to all of the user's clients,
 * serving the origin device first. This channel merely connects a socket to it.
 */

/** A socket, reduced to what this module requires. */
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
   * Authenticates an incoming connection.
   *
   * Two proofs are required, and the second is not redundant: the token states
   * *who* is connecting, the device states *from where*. Without the second check,
   * a stolen token would allow impersonating any device and hijacking events intended for it.
   */
  async authenticate(input: {
    accessToken: string;
    deviceId: string;
  }): Promise<ClientConnectionContext> {
    const claims = this.#services.tokens.verifyAccessToken(input.accessToken);
    await this.#services.auth.assertSessionActive(claims.sid);

    const device = await this.#services.deviceRegistry.requireDevice(input.deviceId);
    if (device.userId !== claims.sub) {
      throw new Error("Device does not belong to token user");
    }
    if (device.trust !== "TRUSTED" || device.revokedAt !== null) {
      throw new Error("Device not approved or revoked");
    }

    return { userId: claims.sub, sessionId: claims.sid, deviceId: device.id };
  }

  /**
   * Attaches an authenticated connection.
   *
   * Attaching to the router immediately delivers what was missed: an iPhone
   * powered on after two hours receives the queued backlog before any new message.
   * This is what ensures the two clients converge rather than diverge.
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
   * Handles an upstream frame.
   *
   * Never throws: any outcome becomes an acknowledgment. An uncaught exception
   * would tear down the connection, and the client would also lose events unrelated to its request.
   */
  async handle(context: ClientConnectionContext, raw: unknown): Promise<void> {
    let request: ReturnType<typeof parseClientRequest>;

    try {
      request = parseClientRequest(raw);
    } catch (cause) {
      // Known type, invalid payload: programming error or forgery, and the client must know.
      this.#ack(context.deviceId, undefined, {
        ok: false,
        data: null,
        error: { code: "INVALID_PAYLOAD", message: describe(cause) },
      });
      return;
    }

    // Unreadable framing or unknown type: silently ignored. A client newer
    // than the server must not have its connection severed.
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
        // Subscription is implicit: the router already broadcasts everything
        // concerning the user. We confirm the requested scope so the client knows
        // what to expect, without creating a second filtering mechanism that could diverge.
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

        // The origin device is **enforced**, not accepted: a client does not choose its identity.
        // The authenticated connection dictates it.
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
          throw new Error("Unknown conversation");
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

        // Any device belonging to the user may decide: the request lives centrally,
        // not in the client that displayed it.
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
          throw new Error("Unknown task");
        }

        return { cancelled: this.#services.supervisor.cancel(input.taskId, context.userId) };
      }

      case CLIENT_TO_SERVER.agentCancel: {
        const input = payload as ClientRequestPayload<"agent.cancel">;
        // An agent run is cancelled via the same path as a task: the supervisor
        // tracks in-flight executions regardless of trigger — and checks ownership.
        return { cancelled: this.#services.supervisor.cancel(input.runId, context.userId) };
      }

      default:
        throw new Error(`Unhandled request type: ${type}`);
    }
  }

  /**
   * Translates an internal event into a downstream message.
   *
   * The mapping table is **partial**, and that is the point: whatever is not in it
   * is not sent down. `worker.*` events describe machine actions; clients see
   * `task.*`, which describes what they must render. Broadcasting the former
   * would unnecessarily expose fleet topology to every client.
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

  /** Sends a non-event message — agent response stream. */
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
  // An `AppError` message is safe to display; that of an unknown exception
  // might contain a path or a request fragment.
  if (cause !== null && typeof cause === "object" && "userMessage" in cause) {
    return String(cause.userMessage);
  }
  return cause instanceof Error ? cause.message : "Unexpected error";
}

function codeOf(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "code" in cause) {
    return String(cause.code);
  }
  return "INTERNAL_ERROR";
}
