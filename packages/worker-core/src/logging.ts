import { redact } from "@nexus/shared";

/**
 * Worker logging utilities.
 *
 * Core requirement: all log payloads pass through `redact`.
 * Emits structured JSON. The sink is injectable with zero Node.js runtime assumptions,
 * allowing execution on Android Hermes or desktop services.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface WorkerLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): WorkerLogger;
}

export interface LogRecord {
  level: LogLevel;
  message: string;
  at: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  sink?: LogSink;
  now?: () => Date;
}

export class ConsoleWorkerLogger implements WorkerLogger {
  readonly #level: LogLevel;
  readonly #bindings: Record<string, unknown>;
  readonly #sink: LogSink;
  readonly #now: () => Date;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#bindings = options.bindings ?? {};
    this.#sink = options.sink ?? defaultSink;
    this.#now = options.now ?? (() => new Date());
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.#write("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.#write("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.#write("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.#write("error", message, context);
  }

  child(bindings: Record<string, unknown>): WorkerLogger {
    return new ConsoleWorkerLogger({
      level: this.#level,
      bindings: { ...this.#bindings, ...bindings },
      sink: this.#sink,
      now: this.#now,
    });
  }

  #write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;

    // Redaction applies to bindings and context to prevent leaks across child loggers.
    const redacted = redact({ ...this.#bindings, ...(context ?? {}) }) as Record<string, unknown>;

    this.#sink({ level, message, at: this.#now().toISOString(), ...redacted });
  }
}

/**
 * Default log sink using global console.
 */
function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "error") globalThis.console.error(line);
  else globalThis.console.warn(line);
}

/** Test logger retaining structured records in memory. */
export class MemoryWorkerLogger implements WorkerLogger {
  readonly records: LogRecord[] = [];
  readonly #bindings: Record<string, unknown>;

  constructor(bindings: Record<string, unknown> = {}, shared?: LogRecord[]) {
    this.#bindings = bindings;
    if (shared !== undefined) this.records = shared;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.#push("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.#push("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.#push("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.#push("error", message, context);
  }

  child(bindings: Record<string, unknown>): WorkerLogger {
    return new MemoryWorkerLogger({ ...this.#bindings, ...bindings }, this.records);
  }

  /** Serialized log buffer for test assertions verifying absence of credentials. */
  get text(): string {
    return JSON.stringify(this.records);
  }

  #push(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const redacted = redact({ ...this.#bindings, ...(context ?? {}) }) as Record<string, unknown>;
    this.records.push({ level, message, at: new Date().toISOString(), ...redacted });
  }
}
