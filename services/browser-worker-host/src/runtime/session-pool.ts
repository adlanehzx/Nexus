import type { BrowserWorkerClient } from "@nexus/browser-client";
import { BrowserWorkerUnreachableError } from "../errors.js";

/**
 * Sessions navigateur, une par tâche NEXUS.
 *
 * ## Pourquoi une par tâche, et pas une par étape
 *
 * « Connecte-toi sur ce site, puis commande » est une tâche à deux étapes. Si
 * chaque étape ouvrait son propre navigateur, la seconde repartirait déconnectée
 * et la tâche serait impossible. Les étapes d'une même tâche partagent donc
 * cookies, onglets et historique.
 *
 * ## Pourquoi pas une seule pour tout
 *
 * C'est le point d'isolation. Deux tâches ne partagent **jamais** de session :
 * une tâche qui s'est connectée à une banque ne doit pas laisser sa session
 * ouverte à la tâche suivante, qui visitera peut-être un site hostile. Une
 * session qui traînerait entre deux tâches transformerait une navigation
 * anodine en accès authentifié.
 *
 * L'appareil, lui, appartient à un seul utilisateur : le registre du cœur lie
 * chaque appareil à un `userId` à l'appairage, et un exécutant navigateur
 * n'échappe pas à la règle. Il n'y a donc pas de cloisonnement inter-utilisateur
 * à faire ici — il est déjà fait un cran au-dessus.
 */

export interface SessionPoolOptions {
  client: BrowserWorkerClient;
  /** Restreint la navigation. Appliqué par le worker Python, pas ici. */
  allowedDomains: readonly string[];
  prohibitedDomains: readonly string[];
  ttlSeconds: number;
  headless: boolean;
  /** Identifiant de l'appareil, transmis comme propriétaire de la session. */
  ownerId: string;
}

export class SessionPool {
  readonly #options: SessionPoolOptions;
  /** `taskId` → identifiant de session navigateur. */
  readonly #byTask = new Map<string, string>();
  /** Ouvertures en cours, pour que deux étapes simultanées n'en ouvrent pas deux. */
  readonly #pending = new Map<string, Promise<string>>();

  constructor(options: SessionPoolOptions) {
    this.#options = options;
  }

  get openSessions(): number {
    return this.#byTask.size;
  }

  /**
   * Session de cette tâche, ouverte au besoin.
   *
   * Deux étapes de la même tâche lancées en même temps obtiennent la même
   * session : sans la file d'attentes en cours, elles ouvriraient deux
   * navigateurs et l'une des deux fuirait.
   */
  async acquire(taskId: string, signal?: AbortSignal): Promise<string> {
    const existing = this.#byTask.get(taskId);
    if (existing !== undefined) return existing;

    const inFlight = this.#pending.get(taskId);
    if (inFlight !== undefined) return inFlight;

    const opening = this.#open(taskId, signal);
    this.#pending.set(taskId, opening);

    try {
      const sessionId = await opening;
      this.#byTask.set(taskId, sessionId);
      return sessionId;
    } finally {
      this.#pending.delete(taskId);
    }
  }

  async #open(taskId: string, signal?: AbortSignal): Promise<string> {
    try {
      const session = await this.#options.client.createSession(
        {
          ownerId: this.#options.ownerId,
          allowedDomains: [...this.#options.allowedDomains],
          prohibitedDomains: [...this.#options.prohibitedDomains],
          headless: this.#options.headless,
          ttlSeconds: this.#options.ttlSeconds,
          // Aucune donnée de la tâche : le titre d'une tâche peut nommer une
          // personne ou un montant, et ces métadonnées vivent dans le worker
          // qui visite des sites tiers.
          metadata: { taskId },
        },
        signal,
      );
      return session.sessionId;
    } catch (cause) {
      throw new BrowserWorkerUnreachableError(
        cause instanceof Error ? cause.message : "erreur inconnue",
      );
    }
  }

  /**
   * Ferme la session d'une tâche terminée.
   *
   * Un échec de fermeture n'est pas propagé : la tâche est finie, et le worker
   * Python purge de toute façon les sessions inactives après leur TTL. Faire
   * échouer une étape réussie parce que le ménage a raté serait absurde.
   */
  async release(taskId: string): Promise<void> {
    const sessionId = this.#byTask.get(taskId);
    if (sessionId === undefined) return;

    this.#byTask.delete(taskId);
    try {
      await this.#options.client.closeSession(sessionId);
    } catch {
      // Silencieux, et le TTL reprendra la main.
    }
  }

  /** Ferme tout. Appelé à l'arrêt de l'hôte, pour ne pas laisser de Chromium. */
  async releaseAll(): Promise<void> {
    const tasks = [...this.#byTask.keys()];
    await Promise.allSettled(tasks.map((taskId) => this.release(taskId)));
  }
}
