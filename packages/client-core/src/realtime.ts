import { uuidv7 } from "@nexus/shared";
import {
  CLIENT_HELLO,
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
  WsCloseCode,
  clientEnvelope,
  envelopeSchema,
  type ClientToServerType,
  type ServerToClientType,
} from "@nexus/protocol";
import type { NetworkMonitor, SocketTransport, TimerPort } from "./ports.js";
import { systemTimers } from "./ports.js";
import type { SessionManager } from "./session.js";
import type { ClientAction, ConnectionState } from "./store.js";

/**
 * Le canal temps réel, vu du téléphone.
 *
 * Un mobile perd le réseau en permanence : ascenseur, métro, passage du Wi-Fi à
 * la 5G, écran verrouillé. La reconnexion n'est donc pas un cas d'erreur, c'est
 * le régime **normal** de fonctionnement, et tout ce fichier est écrit avec ça
 * en tête.
 *
 * Trois décisions qui en découlent :
 *
 *  1. **Attente exponentielle avec bruit.** Sans bruit, l'iPhone et le portable
 *     reconnectent à la même milliseconde après une coupure du cœur et le font
 *     retomber au moment où il redémarre.
 *  2. **Aucune tentative hors ligne.** Quand le système dit que le réseau est
 *     absent, on ne compose pas dans le vide : on attend le signal de retour.
 *     Réessayer sans réseau vide la batterie et n'aboutit jamais.
 *  3. **La poignée de main est refaite en entier** après chaque coupure. Une
 *     session dont on ne sait pas si elle est encore valide n'est pas une
 *     session.
 */

export interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

export interface RealtimeClientOptions {
  socket: SocketTransport;
  session: SessionManager;
  /** URL du canal client, par exemple `wss://nexus.exemple.fr/ws/client`. */
  url: string;
  dispatch: (action: ClientAction) => void;
  network?: NetworkMonitor;
  timers?: TimerPort;
  now?: () => Date;
  newId?: () => string;
  random?: () => number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Délai au-delà duquel une demande sans accusé est abandonnée. */
  requestTimeoutMs?: number;
}

export class RealtimeClient {
  readonly #socket: SocketTransport;
  readonly #session: SessionManager;
  readonly #url: string;
  readonly #dispatch: (action: ClientAction) => void;
  readonly #network: NetworkMonitor | undefined;
  readonly #timers: TimerPort;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #random: () => number;
  readonly #minMs: number;
  readonly #maxMs: number;
  readonly #requestTimeoutMs: number;

  readonly #pending = new Map<string, PendingRequest>();

  #state: ConnectionState = "offline";
  #attempt = 0;
  #reconnectHandle: unknown;
  #reconnecting = false;
  #stopped = true;

  constructor(options: RealtimeClientOptions) {
    this.#socket = options.socket;
    this.#session = options.session;
    this.#url = options.url;
    this.#dispatch = options.dispatch;
    this.#network = options.network;
    this.#timers = options.timers ?? systemTimers;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#random = options.random ?? Math.random;
    this.#minMs = options.reconnectMinMs ?? 1_000;
    this.#maxMs = options.reconnectMaxMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

    this.#socket.onMessage((data) => {
      this.#onMessage(data);
    });
    this.#socket.onClose((reason, code) => {
      this.#onClose(reason, code);
    });

    this.#network?.onChange((online) => {
      this.#dispatch({ kind: "network", online });

      // Le retour du réseau relance immédiatement, sans attendre le prochain
      // palier d'attente : l'utilisateur vient de sortir du tunnel et regarde
      // son écran.
      if (online && !this.#stopped && this.#state !== "connected") {
        this.#attempt = 0;
        void this.#connect();
      }
    });
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#connect();
  }

  /**
   * Arrêt délibéré.
   *
   * Les demandes en vol sont rejetées : leur réponse ne viendra jamais, et une
   * promesse jamais résolue fige l'écran qui l'attend.
   */
  stop(reason = "arrêt demandé"): void {
    this.#stopped = true;
    this.#cancelReconnect();
    this.#rejectAllPending(new Error(reason));

    this.#socket.close(reason);
    this.#setState("offline");
  }

  // ── Demandes ────────────────────────────────────────────────────────────

  /**
   * Envoie une demande et attend son accusé.
   *
   * Chaque demande porte un `requestId` : le serveur le renvoie dans l'accusé,
   * ce qui permet d'avoir plusieurs demandes en vol sans les confondre. Une
   * demande sans réponse est abandonnée au bout du délai — sinon une socket
   * silencieuse laisserait des promesses ouvertes indéfiniment.
   */
  request<T = unknown>(type: ClientToServerType, payload: unknown): Promise<T> {
    if (this.#state !== "connected") {
      return Promise.reject(new Error("Pas de connexion au cœur NEXUS."));
    }

    const requestId = this.#newId();

    return new Promise<T>((resolve, reject) => {
      const timer = this.#timers.set(() => {
        this.#pending.delete(requestId);
        reject(new Error("Le cœur NEXUS n'a pas répondu."));
      }, this.#requestTimeoutMs);

      this.#pending.set(requestId, {
        resolve: (data) => {
          resolve(data as T);
        },
        reject,
        timer,
      });

      this.#send(type, payload, requestId);
    });
  }

  /** Envoie un message dans la conversation. */
  sendMessage(input: { conversationId: string | null; text: string }) {
    return this.request<{ conversationId: string; messageId: string }>(
      CLIENT_TO_SERVER.messageSend,
      input,
    );
  }

  cancelTask(taskId: string, reason = "annulé par l'utilisateur") {
    return this.request<{ cancelled: boolean }>(CLIENT_TO_SERVER.taskCancel, { taskId, reason });
  }

  cancelAgentRun(runId: string, reason = "annulé par l'utilisateur") {
    return this.request<{ cancelled: boolean }>(CLIENT_TO_SERVER.agentCancel, { runId, reason });
  }

  respondToConfirmation(confirmationId: string, decision: "approved" | "rejected") {
    return this.request<{ accepted: boolean }>(CLIENT_TO_SERVER.confirmationRespond, {
      confirmationId,
      decision,
    });
  }

  /**
   * Liste la flotte.
   *
   * La forme reprend exactement ce que le canal renvoie — nom, rôle, statut,
   * capacités actives. Un type plus étroit que la réalité n'ajoute aucune
   * sécurité : il oblige seulement l'appelant à écrire une conversion, où
   * l'erreur devient invisible.
   */
  listDevices(workersOnly = false) {
    return this.request<{
      devices: { id: string; name: string; role: string; status: string; capabilities: string[] }[];
    }>(CLIENT_TO_SERVER.deviceList, { workersOnly });
  }

  subscribe(conversationId: string | null) {
    return this.request(CLIENT_TO_SERVER.conversationSubscribe, { conversationId });
  }

  // ── Connexion ───────────────────────────────────────────────────────────

  async #connect(): Promise<void> {
    // Composer sans réseau ne fait qu'échouer plus vite et vider la batterie.
    if (this.#network?.isOnline() === false) {
      this.#setState("offline");
      return;
    }

    this.#setState("connecting");

    try {
      await this.#socket.connect(this.#url);
    } catch {
      this.#scheduleReconnect("connexion impossible");
      return;
    }

    this.#setState("authenticating");

    try {
      // La poignée de main complète, à chaque fois. Le jeton est relu depuis la
      // session, qui l'a peut-être rafraîchi entre-temps.
      this.#send(
        CLIENT_HELLO as ClientToServerType,
        {
          accessToken: this.#session.accessToken(),
          deviceId: this.#session.deviceId,
        },
        this.#newId(),
      );
    } catch {
      // Pas de jeton : inutile de reconnecter en boucle, il faut se reconnecter
      // au sens de l'utilisateur.
      this.#setState("offline");
      this.#socket.close("session absente");
      return;
    }

    this.#attempt = 0;
    this.#setState("connected");
  }

  #onMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Une trame illisible n'est pas une raison de fermer : le reste du flux
      // est peut-être parfaitement valide.
      return;
    }

    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) return;

    const type = envelope.data.type as ServerToClientType;
    const payload = (envelope.data.payload ?? {}) as Record<string, unknown>;

    if (type === SERVER_TO_CLIENT.ack) {
      this.#settleRequest(envelope.data.requestId, payload);
      return;
    }

    this.#dispatch({
      kind: "server",
      type,
      // L'horodatage de l'enveloppe accompagne la charge utile : le magasin
      // affichera l'heure du serveur, pas celle du téléphone.
      payload: { ...payload, ts: envelope.data.ts },
    });
  }

  #settleRequest(requestId: string | undefined, payload: Record<string, unknown>): void {
    if (requestId === undefined) return;

    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;

    this.#pending.delete(requestId);
    this.#timers.clear(pending.timer);

    if (payload.ok === true) {
      pending.resolve(payload.data);
      return;
    }

    const error = payload.error as { code?: string; message?: string } | null;
    const failure = new Error(error?.message ?? "Demande refusée.");
    // Le code voyage avec l'erreur : l'interface distingue « permission
    // manquante » de « le cœur n'a pas répondu ».
    (failure as Error & { code?: string }).code = error?.code ?? "REQUEST_FAILED";

    pending.reject(failure);
  }

  #onClose(reason: string, code?: number): void {
    if (this.#stopped) return;

    // Les demandes en vol ne recevront jamais leur accusé.
    this.#rejectAllPending(new Error("Connexion perdue."));

    // Le cœur a refusé la session, pas la connexion. C'est le cas d'un poste
    // resté ouvert toute la nuit : le jeton d'accès a expiré pendant que la
    // socket, elle, tenait. Reconnecter avec le même jeton échouerait à chaque
    // tentative, indéfiniment et sans rien changer.
    //
    // On le fait donc tourner **une fois** avant de réessayer. Une seule, parce
    // qu'un rafraîchissement refusé efface la session : la tentative suivante
    // n'aura plus de jeton du tout et s'arrêtera d'elle-même, au lieu de
    // marteler le cœur avec un secret mort.
    if (code === WsCloseCode.UNAUTHENTICATED) {
      void this.#session
        .refresh()
        .catch(() => undefined)
        .finally(() => {
          this.#scheduleReconnect(reason);
        });
      return;
    }

    this.#scheduleReconnect(reason);
  }

  #scheduleReconnect(reason: string): void {
    if (this.#reconnecting || this.#stopped) return;

    this.#reconnecting = true;
    this.#setState("reconnecting");

    const delay = this.#backoffDelay();
    this.#dispatch({
      kind: "error",
      code: "CONNECTION_LOST",
      message: `Connexion perdue (${reason}). Nouvelle tentative dans ${String(
        Math.round(delay / 1000),
      )} s.`,
      at: this.#now().toISOString(),
    });

    this.#reconnectHandle = this.#timers.set(() => {
      this.#reconnecting = false;
      this.#reconnectHandle = undefined;
      if (!this.#stopped) void this.#connect();
    }, delay);
  }

  /**
   * Attente exponentielle, plafonnée, bruitée.
   *
   * Le bruit disperse les reconnexions de plusieurs appareils du même
   * utilisateur ; le plafond évite qu'une longue coupure ne repousse la reprise
   * à plusieurs minutes, alors que l'utilisateur est peut-être revenu.
   */
  #backoffDelay(): number {
    const base = Math.min(this.#minMs * 2 ** this.#attempt, this.#maxMs);
    this.#attempt += 1;

    const spread = base * 0.3;
    const delay = base - spread + this.#random() * spread * 2;

    return Math.round(Math.min(Math.max(delay, this.#minMs), this.#maxMs));
  }

  #cancelReconnect(): void {
    if (this.#reconnectHandle === undefined) return;
    this.#timers.clear(this.#reconnectHandle);
    this.#reconnectHandle = undefined;
    this.#reconnecting = false;
  }

  #rejectAllPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      this.#timers.clear(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(type: ClientToServerType, payload: unknown, requestId: string): void {
    this.#socket.send(
      JSON.stringify(
        clientEnvelope(type as never, payload as never, {
          id: this.#newId(),
          at: this.#now(),
          requestId,
        }),
      ),
    );
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#dispatch({ kind: "connection", state });
  }
}
