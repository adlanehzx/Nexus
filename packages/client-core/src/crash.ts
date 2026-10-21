import { redactText, truncate } from "@nexus/shared";

/**
 * Crash telemetry, local by default.
 *
 * ## What "telemetry" means here
 *
 * Writing a crash trace **on local storage** so it can be reviewed later.
 * Nothing leaves the device: no collection endpoint, no API key, no outbound request.
 * A crash report contains file paths, conversation names, and sometimes fragments
 * of user data — sending it by default is a decision an AI assistant must not take
 * on behalf of its user.
 *
 * `share()` provides formatted text when the user explicitly chooses to export it.
 * The module itself has no network capabilities.
 *
 * ## Why a module instead of a try/catch
 *
 * Three failure modes routinely happen when written ad-hoc:
 *
 *  1. **Secrets.** Traces contain headers, URLs with query tokens, or credentials.
 *     Redaction uses the central shared redact function.
 *  2. **Size.** A repeating crash could write thousands of reports and fill the disk.
 *  3. **Repetition.** Repeating the same trace 100 times drowns out other causes.
 */

export interface CrashReport {
  id: string;
  at: number;
  /** Error name, e.g. `TypeError`. */
  kind: string;
  message: string;
  stack: string;
  /** Application version to identify crash context. */
  version: string;
  /** How many times this identical trace was observed. */
  occurrences: number;
  /** Application execution context — never user payload data. */
  context: Record<string, string>;
}

export interface CrashStore {
  all(): Promise<CrashReport[]>;
  save(reports: readonly CrashReport[]): Promise<void>;
}

export class InMemoryCrashStore implements CrashStore {
  #reports: CrashReport[] = [];

  all(): Promise<CrashReport[]> {
    return Promise.resolve(this.#reports.map((report) => ({ ...report })));
  }

  save(reports: readonly CrashReport[]): Promise<void> {
    this.#reports = reports.map((report) => ({ ...report }));
    return Promise.resolve();
  }
}

export interface CrashReporterOptions {
  store: CrashStore;
  version: string;
  now?: () => number;
  newId?: () => string;
  /** Number of reports retained before oldest are evicted. */
  capacity?: number;
  /** Maximum stack trace character count. */
  maxStackChars?: number;
}

export class CrashReporter {
  readonly #store: CrashStore;
  readonly #version: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #capacity: number;
  readonly #maxStackChars: number;

  constructor(options: CrashReporterOptions) {
    this.#store = options.store;
    this.#version = options.version;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => `crash-${String(this.#now())}`);
    this.#capacity = options.capacity ?? 20;
    this.#maxStackChars = options.maxStackChars ?? 4_000;
  }

  /**
   * Records a crash.
   *
   * An already seen stack increments occurrences instead of duplicating entries.
   */
  async record(error: unknown, context: Record<string, string> = {}): Promise<CrashReport> {
    const kind = error instanceof Error ? error.name : typeof error;
    const message = redactText(error instanceof Error ? error.message : String(error));
    const stack = truncate(
      redactText(error instanceof Error ? (error.stack ?? "") : ""),
      this.#maxStackChars,
    );

    const reports = await this.#store.all();
    const seen = reports.find(
      (report) => report.kind === kind && report.message === message && report.stack === stack,
    );

    if (seen !== undefined) {
      const updated: CrashReport = { ...seen, occurrences: seen.occurrences + 1, at: this.#now() };
      await this.#store.save(reports.map((report) => (report.id === seen.id ? updated : report)));
      return updated;
    }

    const report: CrashReport = {
      id: this.#newId(),
      at: this.#now(),
      kind,
      message,
      stack,
      version: this.#version,
      occurrences: 1,
      context: Object.fromEntries(
        Object.entries(context).map(([key, value]) => [key, redactText(truncate(value, 200))]),
      ),
    };

    await this.#store.save([...reports, report].slice(-this.#capacity));
    return report;
  }

  list(): Promise<CrashReport[]> {
    return this.#store.all();
  }

  /**
   * Formats a human-readable report, ready to share if explicitly decided.
   *
   * The module has no network capabilities.
   */
  async share(id: string): Promise<string | undefined> {
    const report = (await this.#store.all()).find((candidate) => candidate.id === id);
    if (report === undefined) return undefined;
    return [
      `NEXUS ${report.version}`,
      `${report.kind}: ${report.message}`,
      `seen ${String(report.occurrences)} time(s), last at ${new Date(report.at).toISOString()}`,
      ...Object.entries(report.context).map(([key, value]) => `${key}: ${value}`),
      "",
      report.stack,
    ].join("\n");
  }

  async clear(): Promise<void> {
    await this.#store.save([]);
  }
}
