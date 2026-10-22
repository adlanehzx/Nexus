import type { BrowserWorkerClient } from "@nexus/browser-client";
import { BrowserWorkerUnreachableError } from "../errors.js";

/**
 * Browser session pool: one session per NEXUS task.
 *
 * Steps of the same task share cookies, tabs, and browsing history.
 * Distinct tasks never share sessions to prevent cross-task credential leakage.
 */

export interface SessionPoolOptions {
  client: BrowserWorkerClient;
  allowedDomains: readonly string[];
  prohibitedDomains: readonly string[];
  ttlSeconds: number;
  headless: boolean;
  ownerId: string;
}

export class SessionPool {
  readonly #options: SessionPoolOptions;
  /** `taskId` → browser session ID. */
  readonly #byTask = new Map<string, string>();
  /** In-flight creations to prevent race conditions across concurrent steps. */
  readonly #pending = new Map<string, Promise<string>>();

  constructor(options: SessionPoolOptions) {
    this.#options = options;
  }

  get openSessions(): number {
    return this.#byTask.size;
  }

  /**
   * Acquire a browser session for the specified task ID.
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
          metadata: { taskId },
        },
        signal,
      );
      return session.sessionId;
    } catch (cause) {
      throw new BrowserWorkerUnreachableError(
        cause instanceof Error ? cause.message : "unknown error",
      );
    }
  }

  /**
   * Release and close the browser session for a finished task.
   */
  async release(taskId: string): Promise<void> {
    const sessionId = this.#byTask.get(taskId);
    if (sessionId === undefined) return;

    this.#byTask.delete(taskId);
    try {
      await this.#options.client.closeSession(sessionId);
    } catch {
      // Swallowed: background TTL cleanup serves as fallback.
    }
  }

  /** Close all sessions on daemon shutdown. */
  async releaseAll(): Promise<void> {
    const tasks = [...this.#byTask.keys()];
    await Promise.allSettled(tasks.map((taskId) => this.release(taskId)));
  }
}
