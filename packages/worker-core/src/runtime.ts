import { uuidv7 } from "@nexus/shared";
import {
  WORKER_MESSAGE,
  parseWorkerMessage,
  workerEnvelope,
  type WorkerMessageType,
  type WorkerPayload,
} from "@nexus/protocol";
import type { WorkerLogger } from "./logging.js";
import type { LocalCapabilityRegistry } from "./capabilities.js";
import type { CredentialSigner, HealthSource, TimerPort } from "./ports.js";
import { systemTimers } from "./ports.js";
import type { WorkerLink } from "./link.js";
import { Backoff } from "./backoff.js";
import { TaskRunner } from "./task-runner.js";
import { WorkerNotAuthenticatedError } from "./errors.js";

/**
 * Le runtime d'un exécutant, quelle que soit la plateforme.
 *
 * **Rien ici ne sait sur quoi il tourne.** Ni le système d'exploitation, ni le
 * nom de la machine, ni son rôle, ni ses permissions n'apparaissent dans ce
 * fichier : ils viennent de la configuration et du registre côté cœur. Le poste
 * fixe Windows, le portable et le téléphone Android exécutent ces mêmes lignes.
 *
 * Ce qui les distingue tient dans trois ports — signature, santé, minuteries —
 * et dans les capacités enregistrées. Dupliquer ce fichier par plateforme
 * garantirait qu'un correctif appliqué d'un seul côté fasse diverger les deux.
 *
 * Cycle de vie, dans l'ordre :
 *
 *     start → connect → hello → challenge → authenticate → session
 *           → register → heartbeat ⇄ receive/execute → shutdown
 *
 * Une coupure à n'importe quel point ramène à `connect`, avec attente
 * exponentielle. L'état d'authentification n'est pas conservé au travers d'une
 * coupure : le worker refait la poignée de main complète. Une session dont on ne
 * sait pas si elle est encore valide n'est pas une session.
 */

export type WorkerState =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "registering"
  | "ready"
  | "reconnecting"
  | "stopping";

/**
 * Ce que le runtime a besoin de savoir, indépendamment de la plateforme.
 *
 * Le **rôle** n'y figure pas : il appartient au registre, côté cœur. Un worker
 * qui déciderait lui-même de son rôle pourrait se l'élargir.
 */
export interface WorkerRuntimeConfig {
  deviceId: string;
  /** `WINDOWS`, `ANDROID`… Renseigne la trame de présentation, rien de plus. */
  platform: string;
  workerVersion: string;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

export interface WorkerRuntimeOptions {
  config: WorkerRuntimeConfig;
  link: WorkerLink;
  signer: CredentialSigner;
  capabilities: LocalCapabilityRegistry;
  logger: WorkerLogger;
  health: HealthSource;
  now?: () => Date;
  newId?: () => string;
  /** Injectables pour éprouver la reprise sans attendre réellement. */
  timers?: TimerPort;
  random?: () => number;
}

export class WorkerRuntime {
  readonly #config: WorkerRuntimeConfig;
  readonly #link: WorkerLink;
  readonly #signer: CredentialSigner;
  readonly #capabilities: LocalCapabilityRegistry;
  readonly #logger: WorkerLogger;
  readonly #health: HealthSource;
  readonly #runner: TaskRunner;
  readonly #backoff: Backoff;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #state: WorkerState = "stopped";
  #sessionToken: string | undefined;
  #sessionId: string | undefined;
  #grantedCapabilities: string[] = [];
  #heartbeatHandle: unknown;
  #reconnectHandle: unknown;
  /** Empêche deux boucles de reconnexion de coexister après une double coupure. */
  #reconnecting = false;

  constructor(options: WorkerRuntimeOptions) {
    this.#config = options.config;
    this.#link = options.link;
    this.#signer = options.signer;
    this.#capabilities = options.capabilities;
    this.#logger = options.logger.child({ deviceId: options.config.deviceId });
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    const timers = options.timers ?? systemTimers;
    this.#setTimer = (callback, delayMs) => timers.set(callback, delayMs);
    this.#clearTimer = (handle) => {
      timers.clear(handle);
    };

    this.#runner = new TaskRunner({
      capabilities: options.capabilities,
      logger: this.#logger,
      sendProgress: (payload) => this.#send(WORKER_MESSAGE.taskProgress, payload),
      sendResult: (payload) => this.#send(WORKER_MESSAGE.taskResult, payload),
      maxConcurrentTasks: options.config.maxConcurrentTasks,
      defaultTimeoutMs: options.config.taskTimeoutMs,
      now: this.#now,
    });

    this.#health = options.health;

    this.#backoff = new Backoff({
      minMs: options.config.reconnectMinMs,
      maxMs: options.config.reconnectMaxMs,
      ...(options.random === undefined ? {} : { random: options.random }),
    });

    this.#link.onMessage((envelope) => {
      void this.#onEnvelope(envelope);
    });
    this.#link.onClose((reason) => {
      this.#onClose(reason);
    });
  }

  get state(): WorkerState {
    return this.#state;
  }

  get grantedCapabilities(): readonly string[] {
    return this.#grantedCapabilities;
  }

  get activeTaskCount(): number {
    return this.#runner.activeCount;
  }

  get isAuthenticated(): boolean {
    return this.#sessionToken !== undefined;
  }

  // ── Cycle de vie ────────────────────────────────────────────────────────

  /**
   * Démarre le worker et ouvre le canal.
   *
   * Les sondes de disponibilité tournent **avant** la connexion : le worker doit
   * savoir ce qu'il sait faire avant de l'annoncer. Annoncer Docker puis
   * découvrir qu'il n'est pas installé ferait échouer une tâche après avoir
   * écarté une machine capable.
   */
  async start(): Promise<void> {
    this.#state = "connecting";
    await this.#capabilities.probeAll();

    this.#logger.info("capacités locales sondées", {
      disponibles: this.#capabilities.declare().map((capability) => capability.name),
    });

    await this.#connect();
  }

  /**
   * Arrêt propre.
   *
   * Les étapes en cours sont annulées et leur échec est **remonté au cœur avant
   * la fermeture**. Sans cela, le coordinateur attendrait un résultat pendant
   * tout le délai de l'étape avant de comprendre qu'il n'arrivera pas.
   */
  async stop(reason = "arrêt demandé"): Promise<void> {
    this.#state = "stopping";
    this.#stopHeartbeat();

    if (this.#reconnectHandle !== undefined) {
      this.#clearTimer(this.#reconnectHandle);
      this.#reconnectHandle = undefined;
    }
    this.#reconnecting = false;

    const cancelled = this.#runner.cancelAll(reason);
    if (cancelled > 0) {
      // Une boucle d'événements de plus : les résultats d'annulation partent
      // avant que le canal ne se ferme.
      await Promise.resolve();
    }

    await this.#link.close(reason).catch(() => undefined);
    this.#sessionToken = undefined;
    this.#sessionId = undefined;
    this.#state = "stopped";

    this.#logger.info("worker arrêté", { reason, étapesAnnulées: cancelled });
  }

  // ── Connexion et poignée de main ────────────────────────────────────────

  async #connect(): Promise<void> {
    try {
      await this.#link.connect();
    } catch (cause) {
      this.#logger.warn("connexion impossible", {
        raison: cause instanceof Error ? cause.message : "inconnue",
      });
      this.#scheduleReconnect("connexion impossible");
      return;
    }

    this.#state = "authenticating";
    // `hello` n'authentifie rien : il déclenche le challenge. Un identifiant
    // d'appareil est public, il ne donne accès à rien par lui-même.
    await this.#send(WORKER_MESSAGE.hello, {
      deviceId: this.#config.deviceId,
      workerVersion: this.#config.workerVersion,
      platform: this.#config.platform,
    });
  }

  async #onEnvelope(raw: unknown): Promise<void> {
    const message = parseWorkerMessage(raw);
    if (message === undefined) {
      // Type inconnu : un cœur plus récent que ce worker. On ignore plutôt que
      // de tomber — c'est ce qui rend les mises à jour indépendantes.
      return;
    }

    try {
      switch (message.type) {
        case WORKER_MESSAGE.challenge:
          await this.#onChallenge(message.payload as WorkerPayload<"worker.challenge">);
          return;
        case WORKER_MESSAGE.session:
          await this.#onSession(message.payload as WorkerPayload<"worker.session">);
          return;
        case WORKER_MESSAGE.registered:
          this.#onRegistered(message.payload as WorkerPayload<"worker.registered">);
          return;
        case WORKER_MESSAGE.heartbeatAck:
          this.#onHeartbeatAck(message.payload as WorkerPayload<"worker.heartbeat_ack">);
          return;
        case WORKER_MESSAGE.taskDispatch:
          await this.#onDispatch(message.payload as WorkerPayload<"worker.task_dispatch">);
          return;
        case WORKER_MESSAGE.taskCancel:
          this.#onCancel(message.payload as WorkerPayload<"worker.task_cancel">);
          return;
        default:
          return;
      }
    } catch (cause) {
      this.#logger.error("trame non traitée", {
        type: message.type,
        raison: cause instanceof Error ? cause.message : "inconnue",
      });
    }
  }

  async #onChallenge(payload: WorkerPayload<"worker.challenge">): Promise<void> {
    const signature = await this.#signer.sign(payload.nonce);

    // `requestId` et `timestamp` alimentent l'anti-rejeu du cœur : une trame
    // d'authentification capturée ne peut pas être renvoyée.
    await this.#send(WORKER_MESSAGE.authenticate, {
      deviceId: this.#config.deviceId,
      nonce: payload.nonce,
      signature,
      capabilities: this.#capabilities.declare().map((capability) => capability.name),
      requestId: this.#newId(),
      timestamp: this.#now().toISOString(),
    });
  }

  async #onSession(payload: WorkerPayload<"worker.session">): Promise<void> {
    this.#sessionToken = payload.token;
    this.#sessionId = payload.sessionId;
    this.#grantedCapabilities = [...payload.capabilities];
    this.#backoff.reset();
    this.#state = "registering";

    // Le jeton n'apparaît nulle part dans le journal — seulement l'identifiant
    // de session, qui n'ouvre rien.
    this.#logger.info("session ouverte", {
      sessionId: payload.sessionId,
      capacitésAccordées: payload.capabilities.length,
    });

    await this.#send(WORKER_MESSAGE.register, {
      capabilities: this.#capabilities.declare(),
      health: this.#health.snapshot(),
    });
  }

  #onRegistered(payload: WorkerPayload<"worker.registered">): void {
    this.#state = "ready";
    this.#startHeartbeat();

    // **Le cœur fait autorité.** La liste retenue est celle qu'il a acceptée,
    // pas celle que le worker a demandée. Celle négociée à l'ouverture de
    // session est nécessairement vide au premier appairage — l'appareil n'a
    // encore rien enregistré — et ne peut donc pas servir de référence.
    this.#grantedCapabilities = [...payload.accepted];

    this.#logger.info("worker prêt", {
      acceptées: payload.accepted.length,
      refusées: payload.rejected.length,
    });

    for (const rejected of payload.rejected) {
      this.#logger.warn("capacité refusée par le cœur", {
        capacité: rejected.name,
        raison: rejected.reason,
      });
    }
  }

  #onHeartbeatAck(payload: WorkerPayload<"worker.heartbeat_ack">): void {
    if (!payload.rotateSession) return;

    // Le cœur demande une rotation : on refait la poignée de main complète
    // plutôt que d'ajouter un second chemin d'obtention de jeton.
    this.#logger.info("rotation de session demandée");
    void this.#send(WORKER_MESSAGE.hello, {
      deviceId: this.#config.deviceId,
      workerVersion: this.#config.workerVersion,
      platform: this.#config.platform,
    });
  }

  async #onDispatch(payload: WorkerPayload<"worker.task_dispatch">): Promise<void> {
    // Un ordre ne s'exécute jamais hors session. Le cas ne devrait pas se
    // produire — le cœur ne dispatche que vers un worker authentifié — mais un
    // worker qui exécuterait sur simple réception ferait reposer toute la
    // sécurité sur le bon comportement de l'autre bout.
    if (this.#sessionToken === undefined) {
      this.#logger.warn("ordre reçu hors session, ignoré", {
        taskId: payload.taskId,
        stepId: payload.stepId,
      });
      throw new WorkerNotAuthenticatedError("ordre reçu avant l'ouverture de session");
    }

    await this.#runner.handleDispatch(payload);
  }

  #onCancel(payload: WorkerPayload<"worker.task_cancel">): void {
    this.#runner.cancel(payload.taskId, payload.stepId, payload.reason);
  }

  // ── Battement de cœur ───────────────────────────────────────────────────

  #startHeartbeat(): void {
    this.#stopHeartbeat();

    const beat = () => {
      if (this.#state !== "ready") return;

      void this.#send(WORKER_MESSAGE.heartbeat, {
        requestId: this.#newId(),
        timestamp: this.#now().toISOString(),
        health: this.#health.snapshot(),
      }).catch((cause: unknown) => {
        this.#logger.warn("battement de cœur non transmis", {
          raison: cause instanceof Error ? cause.message : "inconnue",
        });
      });

      this.#heartbeatHandle = this.#setTimer(beat, this.#config.heartbeatIntervalMs);
    };

    this.#heartbeatHandle = this.#setTimer(beat, this.#config.heartbeatIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatHandle === undefined) return;
    this.#clearTimer(this.#heartbeatHandle);
    this.#heartbeatHandle = undefined;
  }

  /**
   * Réannonce les capacités au cœur.
   *
   * Les sondes sont rejouées d'abord : c'est le point. Sur un téléphone, la
   * disponibilité change sous les pieds du worker — l'utilisateur désactive le
   * service d'accessibilité, révoque les notifications, et trois capacités
   * disparaissent. Le cœur doit l'apprendre tout de suite, sinon le sélecteur
   * continue de choisir cet appareil pour des tâches qu'il ne peut plus honorer.
   *
   * Sans effet hors de l'état « prêt » : une réannonce pendant la poignée de
   * main doublerait l'enregistrement.
   */
  async announceCapabilities(): Promise<boolean> {
    if (this.#state !== "ready") return false;

    await this.#capabilities.probeAll();
    await this.#send(WORKER_MESSAGE.register, {
      capabilities: this.#capabilities.declare(),
      health: this.#health.snapshot(),
    });
    return true;
  }

  /** Envoie un battement immédiatement — utilisé par les tests et au diagnostic. */
  async sendHeartbeat(): Promise<void> {
    await this.#send(WORKER_MESSAGE.heartbeat, {
      requestId: this.#newId(),
      timestamp: this.#now().toISOString(),
      health: this.#health.snapshot(),
    });
  }

  // ── Reprise ─────────────────────────────────────────────────────────────

  #onClose(reason: string): void {
    if (this.#state === "stopping" || this.#state === "stopped") return;

    this.#stopHeartbeat();
    this.#sessionToken = undefined;
    this.#sessionId = undefined;

    // Les étapes en cours n'aboutiront pas : le canal qui devait porter leur
    // résultat est fermé. Le cœur les a déjà libérées de son côté.
    const cancelled = this.#runner.cancelAll("connexion perdue");

    this.#logger.warn("connexion perdue", { raison: reason, étapesAnnulées: cancelled });
    this.#scheduleReconnect(reason);
  }

  #scheduleReconnect(reason: string): void {
    if (this.#reconnecting) return;
    this.#reconnecting = true;
    this.#state = "reconnecting";

    const delayMs = this.#backoff.next();
    this.#logger.info("reconnexion programmée", {
      raison: reason,
      délaiMs: delayMs,
      tentative: this.#backoff.attempt,
    });

    this.#reconnectHandle = this.#setTimer(() => {
      this.#reconnecting = false;
      this.#reconnectHandle = undefined;
      if (this.#state === "stopping" || this.#state === "stopped") return;
      void this.#connect();
    }, delayMs);
  }

  // ── Émission ────────────────────────────────────────────────────────────

  async #send<T extends WorkerMessageType>(type: T, payload: WorkerPayload<T>): Promise<void> {
    await this.#link.send(workerEnvelope(type, payload, { id: this.#newId(), at: this.#now() }));
  }

  /** État interne, pour le diagnostic. Ne contient aucun secret. */
  describe(): Record<string, unknown> {
    return {
      state: this.#state,
      sessionId: this.#sessionId ?? null,
      authenticated: this.isAuthenticated,
      activeTasks: this.#runner.activeCount,
      grantedCapabilities: this.#grantedCapabilities,
      health: this.#health.snapshot(),
    };
  }
}
