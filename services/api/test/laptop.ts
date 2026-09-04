import { z } from "zod";
import {
  LocalCapabilityRegistry,
  LoopbackLink,
  MemoryWorkerLogger,
  WorkerRuntime,
  type CredentialSigner,
  type HealthSource,
  type TimerPort,
} from "@nexus/worker-core";
import { RealtimeClient, SessionManager } from "@nexus/client-core";
import type {
  HttpClient,
  HttpResponse,
  SecureStorage,
  SocketState,
  SocketTransport,
} from "@nexus/client-core";
import type { Envelope } from "@nexus/protocol";
import type { WorkerConnection } from "@nexus/devices";
import { initialState, reduce, type ClientAction, type ClientState } from "@nexus/client-core";
import { signNonce, type Account, type ApiHarness, type RegisteredDevice } from "./harness.js";

/**
 * Le portable Windows, monté pour de vrai.
 *
 * Ce fichier assemble, dans un seul processus, exactement ce qui tourne sur la
 * machine — **le vrai code des deux côtés** :
 *
 *  - le client : `SessionManager`, `RealtimeClient` et le réducteur de
 *    `@nexus/client-core`, ceux-là mêmes que la fenêtre Windows et l'iPhone
 *    exécutent ;
 *  - l'exécutant : `WorkerRuntime` de `@nexus/worker-core`, celui du démon ;
 *  - le cœur : l'API Fastify complète, avec ses vraies autorisations, sa vraie
 *    passerelle et son vrai coordinateur.
 *
 * Seuls deux éléments sont remplacés, et tous deux sont des **frontières
 * externes** : le transport réseau, remplacé par un branchement direct sur les
 * canaux (mêmes enveloppes, mêmes schémas), et les appels système du worker,
 * remplacés par des capacités en mémoire — on ne veut pas qu'une suite de tests
 * lance un processus sur la machine de qui la lance.
 *
 * Ce qui n'est **pas** remplacé mérite d'être dit, parce que c'est ce que les
 * tests prétendent démontrer : les signatures Ed25519 sont vraies, les jetons
 * sont vrais, la vérification de propriété des appareils est vraie, la sélection
 * d'exécutant est vraie.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Côté client : brancher `SocketTransport` sur `ClientChannel`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transport client en mémoire.
 *
 * Le `RealtimeClient` croit parler à une WebSocket ; il parle en réalité au
 * canal client de l'API. Les trames qui transitent sont **les mêmes octets**
 * que sur le fil : sérialisées, validées par `envelopeSchema`, décodées par
 * `parseClientRequest`.
 *
 * La poignée de main est traitée ici parce que c'est le transport qui en est
 * chargé en production aussi : `client.hello` n'est pas une demande routée, c'est
 * ce qui ouvre la session.
 */
export class ChannelSocket implements SocketTransport {
  #state: SocketState = "idle";
  #onMessage: ((data: string) => void) | undefined;
  #onClose: ((reason: string, code?: number) => void) | undefined;
  #context: { userId: string; sessionId: string; deviceId: string } | undefined;

  readonly #harness: ApiHarness;
  /** Trames montantes observées, pour ce que les tests veulent inspecter. */
  readonly sent: Envelope[] = [];

  constructor(harness: ApiHarness) {
    this.#harness = harness;
  }

  get state(): SocketState {
    return this.#state;
  }

  get deviceId(): string | undefined {
    return this.#context?.deviceId;
  }

  connect(): Promise<void> {
    this.#state = "open";
    return Promise.resolve();
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Envelope;
    this.sent.push(envelope);

    void (async () => {
      if (this.#context === undefined) {
        await this.#open(envelope);
        return;
      }
      await this.#harness.app.clientChannel.handle(this.#context, envelope);
    })();
  }

  async #open(envelope: Envelope): Promise<void> {
    const payload = envelope.payload as { accessToken?: string; deviceId?: string };

    try {
      const context = await this.#harness.app.clientChannel.authenticate({
        accessToken: payload.accessToken ?? "",
        deviceId: payload.deviceId ?? "",
      });

      await this.#harness.app.clientChannel.attach(context, {
        send: (data) => {
          this.#onMessage?.(data);
        },
        close: (code, reason) => {
          this.#state = "closed";
          this.#onClose?.(reason, code);
        },
      });

      this.#context = context;
    } catch {
      // 4401 : le cœur a refusé la session. Le client le distingue d'une
      // coupure réseau et fait tourner son jeton avant de réessayer.
      this.#state = "closed";
      this.#onClose?.("authentification refusée", 4401);
    }
  }

  close(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";

    if (this.#context !== undefined) {
      this.#harness.app.clientChannel.detach(this.#context.deviceId);
      this.#context = undefined;
    }
    this.#onClose?.(reason, 1000);
  }

  onMessage(handler: (data: string) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string, code?: number) => void): void {
    this.#onClose = handler;
  }
}

/** Client HTTP branché sur `app.inject()` — pas de port ouvert. */
export class InjectHttpClient implements HttpClient {
  readonly #harness: ApiHarness;
  readonly requests: { method: string; path: string }[] = [];

  constructor(harness: ApiHarness) {
    this.#harness = harness;
  }

  async request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    this.requests.push({ method: input.method, path: input.path });

    const response = await this.#harness.app.inject({
      method: input.method,
      url: input.path,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.body === undefined ? {} : { payload: input.body as never }),
    });

    // 204, page d'erreur d'un proxy : rien de tout cela ne doit faire échouer
    // l'appelant sur une exception d'analyse.
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = null;
    }

    return { status: response.statusCode, body };
  }
}

export class MemoryStorage implements SecureStorage {
  readonly values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

export interface ClientRig {
  session: SessionManager;
  realtime: RealtimeClient;
  socket: ChannelSocket;
  state: () => ClientState;
  actions: ClientAction[];
}

/**
 * Monte un client complet pour un appareil donné.
 *
 * Le jeton est celui du compte : c'est lui qui authentifie. L'appareil dit
 * seulement d'où l'on parle, et le cœur vérifie qu'il appartient bien au
 * porteur du jeton.
 */
export async function mountClient(
  harness: ApiHarness,
  account: Account,
  device: RegisteredDevice,
): Promise<ClientRig> {
  const storage = new MemoryStorage();
  storage.values.set("nexus.access", account.accessToken);
  storage.values.set("nexus.refresh", account.refreshToken);
  storage.values.set("nexus.device", device.device.id);

  const session = new SessionManager({ http: new InjectHttpClient(harness), storage });
  await session.restore();

  let state = initialState;
  const actions: ClientAction[] = [];
  const socket = new ChannelSocket(harness);

  const realtime = new RealtimeClient({
    socket,
    session,
    url: "wss://nexus.test/ws/client",
    dispatch: (action) => {
      actions.push(action);
      state = reduce(state, action);
    },
    timers: NO_TIMERS,
  });

  await realtime.start();
  return { session, realtime, socket, actions, state: () => state };
}

/**
 * Minuteries inertes.
 *
 * Les tests ne veulent ni délai d'expiration de demande ni reconnexion
 * programmée : ils vérifient l'acheminement, et un minuteur réel les rendrait
 * lents puis instables.
 */
const NO_TIMERS: TimerPort = {
  set: () => 0,
  clear: () => undefined,
};

// ─────────────────────────────────────────────────────────────────────────────
// Côté exécutant : brancher `WorkerLink` sur `WorkerChannel`
// ─────────────────────────────────────────────────────────────────────────────

class StaticSigner implements CredentialSigner {
  readonly #pem: string;

  constructor(privateKeyPem: string) {
    this.#pem = privateKeyPem;
  }

  sign(nonce: string): Promise<string> {
    return Promise.resolve(signNonce(this.#pem, nonce));
  }
}

class SimpleHealth implements HealthSource {
  active = 0;
  max = 2;
  degraded = false;

  snapshot() {
    return { activeTasks: this.active, maxConcurrentTasks: this.max };
  }
  hasCapacity(): boolean {
    return this.active < this.max;
  }
  isDegraded(): boolean {
    return this.degraded;
  }
}

export interface WorkerRig {
  runtime: WorkerRuntime;
  link: LoopbackLink;
  health: SimpleHealth;
  logger: MemoryWorkerLogger;
  /** Ce que la capacité de test a réellement reçu. */
  executed: { capability: string; input: unknown }[];
  /** Coupe le canal — la machine s'éteint, le câble tombe. */
  disconnect(reason?: string): void;
}

/**
 * Comportement d'une capacité simulée.
 *
 * Une capacité de test n'a pas à être muette : un scénario de bout en bout doit
 * pouvoir émettre de la progression, échouer, ou ne jamais rendre la main. Ce
 * sont les trois formes que prend un exécutant réel.
 */
export type CapabilityBehaviour = (
  input: Record<string, unknown>,
  context: { onProgress: (progress: { percent?: number; label?: string }) => void },
) => Promise<unknown>;

/**
 * Monte un exécutant complet pour un appareil donné.
 *
 * Ses capacités sont des doubles en mémoire — on n'exécute rien sur la machine
 * qui lance les tests. Tout le reste est le vrai runtime : poignée de main,
 * signature, enregistrement, dispatch, progression, résultat, reprise.
 */
export function mountWorker(
  harness: ApiHarness,
  device: RegisteredDevice,
  options: {
    capabilities?: readonly string[];
    connectionId?: string;
    platform?: string;
    /** Comportement par capacité. À défaut, une réussite immédiate. */
    behaviours?: Readonly<Record<string, CapabilityBehaviour>>;
  } = {},
): WorkerRig {
  const names = options.capabilities ?? ["filesystem.read", "terminal.execute"];
  const executed: { capability: string; input: unknown }[] = [];

  const registry = new LocalCapabilityRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `Capacité de test : ${name}`,
      inputSchema: z.record(z.string(), z.unknown()).default({}),
      riskLevel: "SAFE",
      execute: async (input: Record<string, unknown>, context) => {
        executed.push({ capability: name, input });

        const behaviour = options.behaviours?.[name];
        if (behaviour === undefined) return { ok: true, capability: name };

        return behaviour(input, { onProgress: context.onProgress });
      },
    });
  }

  const link = new LoopbackLink();
  const health = new SimpleHealth();
  const logger = new MemoryWorkerLogger();
  const connectionId = options.connectionId ?? `conn-${device.device.id}`;

  // Le canal worker de l'API reçoit ce que le runtime envoie, et lui renvoie ce
  // que la passerelle produit. Les deux extrémités échangent les enveloppes du
  // protocole, validées par les mêmes schémas que sur le fil.
  const connection: WorkerConnection = {
    connectionId,
    deviceId: device.device.id,
    send: (envelope: Envelope) => {
      link.deliver(envelope);
    },
    close: () => {
      link.drop("fermé par le cœur");
    },
  };

  link.outbound = async (envelope) => {
    await harness.services.gateway.handleMessage(connection, envelope);
  };

  const runtime = new WorkerRuntime({
    config: {
      deviceId: device.device.id,
      platform: options.platform ?? "WINDOWS",
      workerVersion: "0.1.0",
      heartbeatIntervalMs: 60_000,
      taskTimeoutMs: 5_000,
      maxConcurrentTasks: 2,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 10_000,
    },
    link,
    signer: new StaticSigner(device.privateKeyPem),
    capabilities: registry,
    logger,
    health,
    timers: NO_TIMERS,
  });

  return {
    runtime,
    link,
    health,
    logger,
    executed,
    disconnect: (reason = "la machine s'est éteinte") => {
      // Deux gestes, comme sur le fil : la socket tombe côté worker — ce qui
      // déclenche sa reprise — et le transport prévient la passerelle, sans
      // quoi le cœur croirait la machine toujours là et attendrait un résultat
      // qui ne viendra jamais.
      //
      // `link.onClose` ne convient pas : le port n'a qu'un seul emplacement de
      // gestionnaire, et le runtime y a déjà posé le sien.
      link.drop(reason);
      void harness.services.gateway.detachConnection(connectionId, reason);
    },
  };
}
