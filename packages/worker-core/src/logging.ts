import { redact } from "@nexus/shared";

/**
 * Journalisation du worker.
 *
 * Une seule règle, appliquée sans exception : **tout ce qui entre dans un
 * journal passe par `redact`**. Pas « tout ce qui semble sensible » — tout. Un
 * champ innocemment nommé `value` finit toujours par contenir une clé d'API, et
 * personne ne s'en aperçoit avant de lire le journal.
 *
 * La sortie est en JSON : un journal d'exécutant est lu par un collecteur, pas
 * par un humain devant un terminal.
 *
 * Le puits est **injectable et sans dépendance à Node**. Ce module tourne aussi
 * bien dans un service Windows que sur Hermes, le moteur JavaScript d'Android,
 * où `process.stdout` n'existe pas.
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

    // La rédaction s'applique aux liaisons **et** au contexte : un identifiant
    // de session attaché une fois au logger enfant fuirait sinon à chaque ligne.
    const redacted = redact({ ...this.#bindings, ...(context ?? {}) }) as Record<string, unknown>;

    this.#sink({ level, message, at: this.#now().toISOString(), ...redacted });
  }
}

/**
 * Puits par défaut.
 *
 * Volontairement pauvre, et sans dépendance à Node : ce module tourne aussi sur
 * Hermes, le moteur JavaScript d'Android, où `process.stdout` n'existe pas. Un
 * exécutant qui journalise pour de vrai fournit son propre puits — celui d'un
 * service Windows écrit sur la sortie standard, celui d'Android passe par
 * Logcat.
 */
function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "error") globalThis.console.error(line);
  else globalThis.console.warn(line);
}

/** Journal de test : conserve les enregistrements au lieu de les écrire. */
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

  /** Tout le journal en une chaîne — sert aux assertions d'absence de secret. */
  get text(): string {
    return JSON.stringify(this.records);
  }

  #push(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const redacted = redact({ ...this.#bindings, ...(context ?? {}) }) as Record<string, unknown>;
    this.records.push({ level, message, at: new Date().toISOString(), ...redacted });
  }
}
