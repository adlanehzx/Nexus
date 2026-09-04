import { uuidv7 } from "@nexus/shared";
import {
  WORKER_MESSAGE,
  parseWorkerMessage,
  workerEnvelope,
  type Envelope,
  type WorkerHealth,
  type WorkerMessageType,
  type WorkerPayload,
} from "@nexus/protocol";
import { deviceCapabilitySchema, type DeviceCapability, type DeviceHealth } from "./types.js";
import { DeviceAuthenticationError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import type { DeviceSessionService } from "./sessions.js";
import type { EventRouter } from "./router.js";
import type { WorkerDispatch, WorkerResult, WorkerTransport } from "./coordinator.js";

/**
 * Passerelle vers les exécutants.
 *
 * C'est **l'implémentation de `WorkerTransport`** déclaré par le coordinateur.
 * Rien d'autre n'a changé côté cœur : `TaskCoordinator`, `DeviceSelector` et
 * `TaskPlan` ignorent qu'un vrai worker existe désormais.
 *
 * Le sens de la connexion est le point important. Le worker ouvre la connexion
 * vers le cœur ; le cœur ne sait pas joindre une machine Windows. Il répond sur
 * un canal déjà ouvert. Conséquence directe : aucune redirection de port, aucune
 * machine exposée, et un worker derrière un réseau domestique ou un partage de
 * connexion mobile fonctionne sans configuration.
 *
 * La passerelle ne connaît pas le WebSocket : elle parle à `WorkerConnection`,
 * un port. Le transport réel s'y branchera sans toucher une ligne d'ici.
 */

/**
 * Challenges qu'une même socket peut réclamer.
 *
 * Trois suffisent à couvrir une reprise après un challenge expiré. Au-delà,
 * c'est un abus : chaque nonce est retenu une minute, et l'appel précède toute
 * authentification.
 */
const MAX_HELLO_PER_CONNECTION = 3;

/** Canal ouvert par un exécutant. */
export interface WorkerConnection {
  /**
   * Identité de la **socket**, attribuée par le transport.
   *
   * Distincte de `deviceId`, et c'est tout l'objet de ce champ. `deviceId` est
   * *annoncé* par le pair dans sa première trame : il est public, et il ne
   * prouve rien. `connectionId` désigne la connexion physique, que la passerelle
   * associe à un appareil **une fois la signature vérifiée**, et jamais avant.
   *
   * Sans cette distinction, une socket qui se contente d'annoncer l'identifiant
   * d'un appareil est traitée comme cet appareil.
   */
  connectionId: string;
  /** Ce que le pair prétend être. Sert à adresser la réponse, à rien d'autre. */
  deviceId: string;
  send(envelope: Envelope): void | Promise<void>;
  close(code: number, reason: string): void | Promise<void>;
  /** Adresse distante, pour la trace de session. Jamais journalisée seule. */
  remoteAddress?: string;
}

/**
 * Fournit le matériel cryptographique d'un appareil.
 *
 * Port séparé du registre : une clé publique n'a pas la même durée de vie ni le
 * même cycle de révocation qu'un appareil, et le jour où elles vivront dans un
 * coffre, seul ce port changera.
 */
export interface DeviceCredentialProvider {
  /** Clé publique PEM de l'appareil, ou `undefined` s'il n'en a pas. */
  publicKeyFor(deviceId: string): Promise<string | undefined>;
}

export class InMemoryCredentialProvider implements DeviceCredentialProvider {
  readonly #keys = new Map<string, string>();

  set(deviceId: string, publicKeyPem: string): this {
    this.#keys.set(deviceId, publicKeyPem);
    return this;
  }

  revoke(deviceId: string): void {
    this.#keys.delete(deviceId);
  }

  publicKeyFor(deviceId: string): Promise<string | undefined> {
    return Promise.resolve(this.#keys.get(deviceId));
  }
}

interface PendingStep {
  deviceId: string;
  taskId: string;
  stepId: string;
  settle: (result: WorkerResult) => void;
  onProgress: (progress: { percent?: number; label?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export interface WorkerGatewayOptions {
  registry: DeviceRegistry;
  sessions: DeviceSessionService;
  credentials: DeviceCredentialProvider;
  /** Facultatif : sans routeur, la passerelle n'émet pas d'événements. */
  router?: EventRouter;
  now?: () => Date;
  newId?: () => string;
  /** Marge ajoutée au délai de l'étape avant que le cœur abandonne. */
  dispatchGraceMs?: number;
}

export class WorkerGateway implements WorkerTransport {
  readonly #registry: DeviceRegistry;
  readonly #sessions: DeviceSessionService;
  readonly #credentials: DeviceCredentialProvider;
  readonly #router: EventRouter | undefined;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #graceMs: number;

  readonly #connections = new Map<string, WorkerConnection>();
  readonly #pending = new Map<string, PendingStep>();

  /**
   * Connexions authentifiées : `connectionId` → `deviceId`.
   *
   * La seule source de vérité sur « qui parle ». Tout ce qui suit la poignée de
   * main s'y réfère ; `connection.deviceId` n'est plus consulté pour décider de
   * quoi que ce soit.
   */
  readonly #authenticated = new Map<string, string>();

  /** Challenges réclamés par connexion. Voir `MAX_HELLO_PER_CONNECTION`. */
  readonly #helloCount = new Map<string, number>();

  constructor(options: WorkerGatewayOptions) {
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#credentials = options.credentials;
    this.#router = options.router;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#graceMs = options.dispatchGraceMs ?? 5_000;
  }

  // ── Poignée de main ─────────────────────────────────────────────────────

  /**
   * Traite une trame entrante du canal worker.
   *
   * Point d'entrée unique : le transport réel n'aura qu'à appeler ceci. Une
   * trame illisible ou d'un type inconnu est ignorée — un worker plus récent
   * que le cœur ne doit pas le faire tomber.
   */
  async handleMessage(connection: WorkerConnection, raw: unknown): Promise<void> {
    const message = parseWorkerMessage(raw);
    if (message === undefined) return;

    switch (message.type) {
      case WORKER_MESSAGE.hello:
        await this.#onHello(connection, message.payload as WorkerPayload<"worker.hello">);
        return;
      case WORKER_MESSAGE.authenticate:
        await this.#onAuthenticate(
          connection,
          message.payload as WorkerPayload<"worker.authenticate">,
        );
        return;
      case WORKER_MESSAGE.register:
        await this.#onRegister(connection, message.payload as WorkerPayload<"worker.register">);
        return;
      case WORKER_MESSAGE.heartbeat:
        await this.#onHeartbeat(connection, message.payload as WorkerPayload<"worker.heartbeat">);
        return;
      case WORKER_MESSAGE.taskProgress:
        this.#onProgress(connection, message.payload as WorkerPayload<"worker.task_progress">);
        return;
      case WORKER_MESSAGE.taskResult:
        await this.#onResult(connection, message.payload as WorkerPayload<"worker.task_result">);
        return;
      default:
        // Les messages descendants n'ont rien à faire ici.
        return;
    }
  }

  async #onHello(connection: WorkerConnection, payload: WorkerPayload<"worker.hello">) {
    // Chaque challenge est un nonce retenu une minute. Sans plafond, une seule
    // socket suffit à faire enfler la mémoire du cœur — et l'appel précède
    // toute authentification, donc n'importe qui peut le faire.
    const seen = (this.#helloCount.get(connection.connectionId) ?? 0) + 1;
    this.#helloCount.set(connection.connectionId, seen);

    if (seen > MAX_HELLO_PER_CONNECTION) {
      throw new DeviceAuthenticationError(
        payload.deviceId,
        "trop de challenges demandés sur une même connexion",
      );
    }

    // Un `deviceId` ne prouve rien : il est public. On répond par un challenge,
    // et rien d'autre n'est accordé tant qu'il n'est pas signé.
    const challenge = await this.#sessions.createChallenge(payload.deviceId);
    await this.#send(connection, WORKER_MESSAGE.challenge, {
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt.toISOString(),
    });
  }

  async #onAuthenticate(
    connection: WorkerConnection,
    payload: WorkerPayload<"worker.authenticate">,
  ) {
    this.#sessions.assertNotReplayed(payload.requestId, new Date(payload.timestamp));

    const publicKey = await this.#credentials.publicKeyFor(payload.deviceId);
    if (publicKey === undefined) {
      throw new DeviceAuthenticationError(payload.deviceId, "aucune clé publique enregistrée");
    }

    const { session, token } = await this.#sessions.authenticate(
      {
        deviceId: payload.deviceId,
        nonce: payload.nonce,
        signature: payload.signature,
        capabilities: payload.capabilities,
        ...(connection.remoteAddress === undefined
          ? {}
          : { remoteAddress: connection.remoteAddress }),
      },
      publicKey,
    );

    // C'est **ici**, et nulle part ailleurs, qu'une socket devient un appareil.
    this.#authenticated.set(connection.connectionId, session.deviceId);
    this.#connections.set(session.deviceId, connection);

    // Le jeton ne traverse ce point qu'une fois. Il n'est ni journalisé, ni
    // replacé dans un événement, ni conservé ailleurs que dans son empreinte.
    await this.#send(connection, WORKER_MESSAGE.session, {
      sessionId: session.id,
      token,
      expiresAt: session.expiresAt.toISOString(),
      capabilities: session.capabilities,
    });

    const device = await this.#registry.requireDevice(payload.deviceId);
    await this.#emit("worker.connected", device.userId, {
      deviceId: device.id,
      deviceName: device.name,
      workerVersion: device.agentVersion ?? "inconnu",
    });
  }

  /**
   * Enregistre les capacités déclarées.
   *
   * Le worker fait autorité sur ce qu'il *sait* faire ; le cœur reste
   * autoritaire sur ce qu'il a le *droit* de faire. Une capacité déclarée mais
   * non accordée en permission est acceptée ici et refusée à l'exécution — deux
   * questions distinctes qu'on ne mélange pas.
   */
  async #onRegister(connection: WorkerConnection, payload: WorkerPayload<"worker.register">) {
    const deviceId = this.#requireAuthenticated(connection);
    const accepted: string[] = [];
    const rejected: { name: string; reason: string }[] = [];
    const capabilities: DeviceCapability[] = [];

    for (const declared of payload.capabilities) {
      const parsed = deviceCapabilitySchema.safeParse(declared);
      if (!parsed.success) {
        rejected.push({ name: declared.name, reason: "définition de capacité invalide" });
        continue;
      }
      capabilities.push(parsed.data);
      accepted.push(parsed.data.name);
    }

    // Relevé **avant** la mise à jour : c'est la différence qui intéresse les
    // clients, pas la liste. Un worker qui réannonce à l'identique — cas normal
    // après une reconnexion — ne doit pas produire d'événement.
    const previous = ((await this.#registry.getDevice(deviceId))?.capabilities ?? [])
      .map((capability) => capability.name)
      .sort();

    await this.#registry.updateCapabilities(deviceId, capabilities);
    await this.#registry.updateHealth(deviceId, toDeviceHealth(payload.health));

    await this.#send(connection, WORKER_MESSAGE.registered, {
      accepted: accepted.sort(),
      rejected,
    });

    const device = await this.#registry.requireDevice(deviceId);
    const current = accepted.sort();

    await this.#emit("worker.ready", device.userId, {
      deviceId: device.id,
      capabilities: current,
      maxConcurrentTasks: device.health.maxConcurrentTasks,
    });

    // Le mécanisme par lequel un worker signale qu'il sait faire autre chose
    // qu'il y a une minute. Sur Android, c'est la règle et non l'exception :
    // l'utilisateur désactive le service d'accessibilité et trois capacités
    // disparaissent.
    if (previous.join("|") !== current.join("|")) {
      await this.#emit("device.capabilities_changed", device.userId, {
        deviceId: device.id,
        capabilities: current,
      });
    }
  }

  async #onHeartbeat(connection: WorkerConnection, payload: WorkerPayload<"worker.heartbeat">) {
    const deviceId = this.#requireAuthenticated(connection);
    this.#sessions.assertNotReplayed(payload.requestId, new Date(payload.timestamp));
    await this.#registry.updateHeartbeat(deviceId, toDeviceHealth(payload.health));

    await this.#send(connection, WORKER_MESSAGE.heartbeatAck, {
      at: this.#now().toISOString(),
      rotateSession: false,
    });
  }

  // ── Connexion ───────────────────────────────────────────────────────────

  isConnected(deviceId: string): boolean {
    return this.#connections.has(deviceId);
  }

  get connectedDeviceIds(): string[] {
    return [...this.#connections.keys()];
  }

  /**
   * Le canal s'est fermé.
   *
   * Les étapes en vol sont résolues **réessayables** : la machine a disparu,
   * mais la tâche n'a pas échoué au sens métier. Le coordinateur peut la
   * reprendre ailleurs — c'est exactement ce que fait `failoverToAnotherDevice`.
   * Les laisser en attente les ferait expirer beaucoup plus tard, pour rien.
   */
  /**
   * Une socket se ferme.
   *
   * Point d'entrée du transport. Le détachement complet — mise hors ligne,
   * révocation des sessions, abandon des étapes en vol — n'a lieu que si la
   * connexion **était authentifiée**, et seulement pour l'appareil auquel elle
   * était liée.
   *
   * Sans cette condition, annoncer l'identifiant public d'un appareil puis
   * raccrocher suffit à le mettre hors ligne et à révoquer ses sessions : une
   * socket et un identifiant, pour couper une machine de la flotte.
   */
  async detachConnection(connectionId: string, reason: string): Promise<void> {
    this.#helloCount.delete(connectionId);

    const deviceId = this.#authenticated.get(connectionId);
    if (deviceId === undefined) return;

    this.#authenticated.delete(connectionId);

    // Une connexion plus récente a pu prendre la place : on ne détache pas
    // l'appareil sur la fermeture d'une socket qu'il a déjà remplacée.
    if (this.#connections.get(deviceId)?.connectionId !== connectionId) return;

    await this.detach(deviceId, reason);
  }

  /** Connexion authentifiée pour cette socket, s'il y en a une. */
  authenticatedDeviceId(connectionId: string): string | undefined {
    return this.#authenticated.get(connectionId);
  }

  async detach(deviceId: string, reason: string): Promise<void> {
    const connection = this.#connections.get(deviceId);
    if (connection !== undefined) this.#authenticated.delete(connection.connectionId);
    this.#connections.delete(deviceId);

    const orphaned = [...this.#pending.values()].filter((p) => p.deviceId === deviceId);
    for (const pending of orphaned) {
      pending.cleanup();
      pending.settle({
        ok: false,
        error: {
          code: "WORKER_DISCONNECTED",
          message: `L'exécutant s'est déconnecté (${reason}).`,
          retryable: true,
        },
      });
    }

    const device = await this.#registry.getDevice(deviceId);
    await this.#registry.markOffline(deviceId);
    await this.#sessions.revokeAllForDevice(deviceId);

    if (device !== undefined) {
      await this.#emit("worker.disconnected", device.userId, {
        deviceId,
        reason,
        inFlightSteps: orphaned.length,
      });
    }
  }

  // ── WorkerTransport ─────────────────────────────────────────────────────

  /**
   * Envoie une étape à un exécutant et attend son verdict.
   *
   * Trois façons d'en sortir, toutes traitées : le worker répond, le délai
   * expire, ou le coordinateur annule. Aucune ne laisse d'entrée en suspens dans
   * la table — une fuite ici retiendrait une promesse pour toujours.
   */
  dispatch(input: WorkerDispatch): Promise<WorkerResult> {
    const connection = this.#connections.get(input.deviceId);
    if (connection === undefined) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "WORKER_UNAVAILABLE",
          message: "L'exécutant n'est pas connecté.",
          retryable: true,
        },
      });
    }

    const key = stepKey(input.taskId, input.stepId);
    if (this.#pending.has(key)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "STEP_ALREADY_RUNNING",
          message: "Cette étape est déjà en cours sur un exécutant.",
          retryable: false,
        },
      });
    }

    return new Promise<WorkerResult>((resolve) => {
      let settled = false;
      const settle = (result: WorkerResult) => {
        if (settled) return;
        settled = true;
        this.#pending.delete(key);
        resolve(result);
      };

      const onAbort = () => {
        void this.cancel(input.deviceId, input.taskId, input.stepId);
        cleanup();
        settle({
          ok: false,
          error: { code: "STEP_CANCELLED", message: "Étape annulée.", retryable: false },
        });
      };

      const timer = setTimeout(() => {
        void this.cancel(input.deviceId, input.taskId, input.stepId);
        cleanup();
        settle({
          ok: false,
          error: {
            code: "STEP_TIMEOUT",
            message: "L'exécutant n'a pas répondu dans le délai imparti.",
            retryable: true,
          },
        });
      }, input.timeoutMs + this.#graceMs);

      const cleanup = () => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
      };

      input.signal.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(key, {
        deviceId: input.deviceId,
        taskId: input.taskId,
        stepId: input.stepId,
        settle,
        onProgress: input.onProgress,
        timer,
        cleanup,
      });

      void this.#send(connection, WORKER_MESSAGE.taskDispatch, {
        taskId: input.taskId,
        stepId: input.stepId,
        capability: input.capability,
        tool: input.tool,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs,
        riskLevel: "MEDIUM",
        requestId: this.#newId(),
      }).catch(() => {
        cleanup();
        settle({
          ok: false,
          error: {
            code: "WORKER_UNREACHABLE",
            message: "L'ordre n'a pas pu être transmis.",
            retryable: true,
          },
        });
      });
    });
  }

  async cancel(deviceId: string, taskId: string, stepId: string): Promise<void> {
    const connection = this.#connections.get(deviceId);
    if (connection === undefined) return;

    await this.#send(connection, WORKER_MESSAGE.taskCancel, {
      taskId,
      stepId,
      reason: "annulée par NEXUS",
    }).catch(() => undefined);

    const device = await this.#registry.getDevice(deviceId);
    if (device !== undefined) {
      await this.#emit("worker.task_cancelled", device.userId, {
        taskId,
        stepId,
        deviceId,
        reason: "annulée par NEXUS",
      });
    }
  }

  // ── Retours du worker ───────────────────────────────────────────────────

  #onProgress(connection: WorkerConnection, payload: WorkerPayload<"worker.task_progress">): void {
    const deviceId = this.#requireAuthenticated(connection);
    const pending = this.#pending.get(stepKey(payload.taskId, payload.stepId));
    if (pending === undefined) return;

    this.#assertOwnsStep(pending, deviceId, payload.taskId, payload.stepId);

    pending.onProgress({
      ...(payload.percent === null ? {} : { percent: payload.percent }),
      ...(payload.label === null ? {} : { label: payload.label }),
    });
  }

  #onResult(
    connection: WorkerConnection,
    payload: WorkerPayload<"worker.task_result">,
  ): Promise<void> {
    const deviceId = this.#requireAuthenticated(connection);
    const key = stepKey(payload.taskId, payload.stepId);
    const pending = this.#pending.get(key);
    // Un résultat sans étape en attente est le cas normal après un délai
    // dépassé : le worker a fini juste trop tard. On l'ignore sans bruit.
    if (pending === undefined) return Promise.resolve();

    this.#assertOwnsStep(pending, deviceId, payload.taskId, payload.stepId);

    pending.cleanup();
    pending.settle(
      payload.ok
        ? { ok: true, result: payload.result, sensitiveResult: payload.sensitiveResult }
        : {
            ok: false,
            error: payload.error ?? {
              code: "WORKER_ERROR",
              message: "Échec sans détail.",
              retryable: false,
            },
          },
    );
    return Promise.resolve();
  }

  // ── Gardes ──────────────────────────────────────────────────────────────

  /**
   * L'appareil auquel cette **socket** est liée.
   *
   * Rien de ce qui suit la poignée de main ne lit `connection.deviceId` : il est
   * annoncé par le pair, donc contrôlé par lui. Une connexion qui n'a pas signé
   * son challenge n'a pas d'appareil, et l'exception ferme la socket — l'ignorer
   * en silence laisserait l'attaquant réessayer indéfiniment.
   */
  #requireAuthenticated(connection: WorkerConnection): string {
    const deviceId = this.#authenticated.get(connection.connectionId);
    if (deviceId === undefined) {
      throw new DeviceAuthenticationError(
        connection.deviceId,
        "trame reçue sur une connexion non authentifiée",
      );
    }
    return deviceId;
  }

  /**
   * L'étape a-t-elle bien été confiée à cet exécutant ?
   *
   * C'est la frontière entre machines. Sans elle, le téléphone Android — la
   * machine la moins digne de confiance de la flotte — peut prétendre avoir
   * exécuté une étape confiée au poste fixe, et injecter le résultat de son
   * choix dans la boucle de l'agent. Une authentification qui ne dit pas *pour
   * quoi* on est authentifié ne sépare rien.
   */
  #assertOwnsStep(pending: PendingStep, deviceId: string, taskId: string, stepId: string): void {
    if (pending.deviceId === deviceId) return;

    throw new DeviceAuthenticationError(
      deviceId,
      "réponse pour une étape confiée à un autre exécutant",
      { taskId, stepId, dispatchedTo: pending.deviceId },
    );
  }

  // ── Interne ─────────────────────────────────────────────────────────────

  async #send<T extends WorkerMessageType>(
    connection: WorkerConnection,
    type: T,
    payload: WorkerPayload<T>,
  ): Promise<void> {
    await connection.send(workerEnvelope(type, payload, { id: this.#newId(), at: this.#now() }));
  }

  async #emit(
    type:
      | "worker.connected"
      | "worker.ready"
      | "worker.disconnected"
      | "worker.task_cancelled"
      | "device.capabilities_changed",
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.#router === undefined) return;
    await this.#router.emit({
      type,
      userId,
      correlationId: this.#newId(),
      originClientDeviceId: null,
      payload,
    });
  }
}

function stepKey(taskId: string, stepId: string): string {
  return `${taskId}:${stepId}`;
}

/** Santé déclarée par un worker → santé du modèle d'appareil. */
function toDeviceHealth(health: WorkerHealth): Partial<DeviceHealth> {
  return {
    ...(health.cpuLoad === undefined ? {} : { cpuLoad: health.cpuLoad }),
    ...(health.memoryFreeMb === undefined ? {} : { memoryFreeMb: health.memoryFreeMb }),
    ...(health.diskFreeMb === undefined ? {} : { diskFreeMb: health.diskFreeMb }),
    ...(health.batteryPercent === undefined ? {} : { batteryPercent: health.batteryPercent }),
    ...(health.onBattery === undefined ? {} : { onBattery: health.onBattery }),
    activeTasks: health.activeTasks,
    maxConcurrentTasks: health.maxConcurrentTasks,
  };
}
