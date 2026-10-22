// `multistream` lives on pino's namespace, not on the named exported function next to it.
// The default import is the only one that provides both.
import pino, { type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "@nexus/config";

/**
 * Structured logging.
 *
 * A log is an EVENT, not a sentence: `event` is a stable enumeration
 * that can be aggregated, unlike free-form messages. The content of user messages
 * never appears at the `info` level — only in `debug`, disabled in production.
 */

/**
 * Systematically redacted fields. The list is deliberately broad: missing a
 * redaction is infinitely more costly than having one too many.
 */
const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.secret",
  "*.masterKey",
  "*.privateKey",
  "*.authorization",
];

/**
 * Additional destination.
 *
 * `LogBuffer` is one: the dashboard displays the latest lines, and
 * they must reach it. A destination must **never throw** — it is called from
 * the error handler, where an exception would turn an incident into an outage.
 */
export interface LogDestination {
  write(line: string): void;
}

export function createLogger(config: AppConfig, extra: LogDestination[] = []): Logger {
  const isDevelopment = config.NODE_ENV === "development";

  const options: LoggerOptions = {
    level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
    // A human-readable level is better than an integer in an aggregator.
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: "api",
      env: config.NODE_ENV,
    },
    // The `pino-pretty` transport and multiple destinations are mutually exclusive:
    // the former offloads writing to a worker thread where the latter does not exist.
    // As soon as a destination is attached — i.e. as soon as the dashboard is active —
    // NDJSON is written to standard output.
    //
    // In development, `pnpm dev | npx pino-pretty` provides readability without changing the pipeline.
    ...(isDevelopment && extra.length === 0
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname,service",
            },
          },
        }
      : {}),
  };

  if (extra.length === 0) return pino(options);

  return pino(
    options,
    pino.multistream([
      { stream: process.stdout },
      ...extra.map((destination) => ({ stream: destination as NodeJS.WritableStream })),
    ]),
  );
}
