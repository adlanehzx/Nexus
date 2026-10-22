import type { WorkerLogger } from "@nexus/worker-core";
import type { AndroidPlatform } from "../ports.js";

/**
 * Capability availability monitoring.
 */

export interface AvailabilitySnapshot {
  accessibility: boolean;
  screenshot: boolean;
  notifications: boolean;
}

export interface AvailabilityWatcherOptions {
  platform: AndroidPlatform;
  logger: WorkerLogger;
  /** Called when availability changes. Re-announces capabilities to core. */
  onChange: (snapshot: AvailabilitySnapshot) => Promise<void> | void;
}

export class AvailabilityWatcher {
  readonly #platform: AndroidPlatform;
  readonly #logger: WorkerLogger;
  readonly #onChange: AvailabilityWatcherOptions["onChange"];

  #last: AvailabilitySnapshot | undefined;

  constructor(options: AvailabilityWatcherOptions) {
    this.#platform = options.platform;
    this.#logger = options.logger;
    this.#onChange = options.onChange;
  }

  get last(): AvailabilitySnapshot | undefined {
    return this.#last;
  }

  /**
   * Reads state without notifying.
   */
  async prime(): Promise<AvailabilitySnapshot> {
    this.#last = await this.probe();
    return this.#last;
  }

  /** Queries system. Each check is independent. */
  async probe(): Promise<AvailabilitySnapshot> {
    const [accessibility, screenshot, notifications] = await Promise.all([
      this.#safely(() => this.#platform.ui.isAccessibilityEnabled()),
      this.#safely(() => this.#platform.screenshots.isAvailable()),
      this.#safely(() => this.#platform.notifications.canPostNotifications()),
    ]);

    return { accessibility, screenshot, notifications };
  }

  /**
   * Probes and notifies if anything changed.
   */
  async check(): Promise<boolean> {
    const snapshot = await this.probe();

    if (this.#last !== undefined && sameSnapshot(this.#last, snapshot)) {
      this.#last = snapshot;
      return false;
    }

    const previous = this.#last;
    this.#last = snapshot;

    this.#logger.info(previous === undefined ? "initial availability" : "availability changed", {
      accessibility: snapshot.accessibility,
      screenshot: snapshot.screenshot,
      notifications: snapshot.notifications,
    });

    await this.#onChange(snapshot);
    return true;
  }

  /** A failing probe is treated as unavailable. */
  async #safely(probe: () => Promise<boolean>): Promise<boolean> {
    try {
      return await probe();
    } catch {
      return false;
    }
  }
}

function sameSnapshot(a: AvailabilitySnapshot, b: AvailabilitySnapshot): boolean {
  return (
    a.accessibility === b.accessibility &&
    a.screenshot === b.screenshot &&
    a.notifications === b.notifications
  );
}
