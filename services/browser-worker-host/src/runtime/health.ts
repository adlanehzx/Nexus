import type { WorkerHealth } from "@nexus/protocol";
import type { HealthSource } from "@nexus/worker-core";
import type { BrowserWorkerClient } from "@nexus/browser-client";

/**
 * Health source for the browser worker host.
 *
 * Describes the state of the underlying browser service.
 * Refreshed explicitly rather than synchronously during heartbeats.
 */

export interface BrowserHealthOptions {
  client: BrowserWorkerClient;
  maxConcurrentTasks: number;
  /** Active tasks on the host, read from runtime. */
  activeTasks: () => number;
}

export class BrowserHealthSource implements HealthSource {
  readonly #options: BrowserHealthOptions;

  /** Last known status of the Python worker. `undefined` = not yet queried. */
  #status: "ok" | "degraded" | "unreachable" | undefined;
  #openSessions = 0;
  #browserUseVersion: string | null = null;

  constructor(options: BrowserHealthOptions) {
    this.#options = options;
  }

  get status(): string {
    return this.#status ?? "unknown";
  }

  get browserUseVersion(): string | null {
    return this.#browserUseVersion;
  }

  /** Probe the Python worker. Called at startup and periodically. */
  async refresh(): Promise<void> {
    try {
      const health = await this.#options.client.health();
      this.#status = health.status;
      this.#openSessions = health.openSessions;
      this.#browserUseVersion = health.browserUseVersion;
    } catch {
      this.#status = "unreachable";
      this.#openSessions = 0;
    }
  }

  snapshot(): WorkerHealth {
    return {
      activeTasks: this.#options.activeTasks(),
      maxConcurrentTasks: this.#options.maxConcurrentTasks,
    };
  }

  hasCapacity(): boolean {
    if (this.#status === "unreachable") return false;
    return this.#options.activeTasks() < this.#options.maxConcurrentTasks;
  }

  isDegraded(): boolean {
    return this.#status === "degraded" || this.#status === "unreachable";
  }

  /** Safe diagnostic metadata for logging. */
  describe(): Record<string, unknown> {
    return {
      status: this.status,
      openSessions: this.#openSessions,
      browserUseVersion: this.#browserUseVersion,
      activeTasks: this.#options.activeTasks(),
      maxConcurrentTasks: this.#options.maxConcurrentTasks,
    };
  }
}
