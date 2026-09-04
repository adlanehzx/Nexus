// `multistream` vit sur l'espace de noms de pino, pas sur la fonction nommee
// exportee a cote. L'import par defaut est le seul qui donne les deux.
import pino, { type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "@nexus/config";

/**
 * Journalisation structurée.
 *
 * Un log est un ÉVÉNEMENT, pas une phrase : `event` est une énumération stable
 * qu'on peut agréger, contrairement à un message libre. Le contenu des messages
 * utilisateur n'apparaît jamais au niveau `info` — uniquement en `debug`, désactivé
 * en production.
 */

/**
 * Champs systématiquement masqués. La liste est volontairement large : rater une
 * rédaction coûte infiniment plus cher qu'en faire une de trop.
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
 * Destination supplementaire.
 *
 * `LogBuffer` en est une : le tableau de bord affiche les dernieres lignes, et
 * il faut bien qu'elles lui parviennent. Une destination doit **ne jamais
 * lever** — elle est appelee depuis le gestionnaire d'erreurs, ou une exception
 * transformerait un incident en panne.
 */
export interface LogDestination {
  write(line: string): void;
}

export function createLogger(config: AppConfig, extra: LogDestination[] = []): Logger {
  const isDevelopment = config.NODE_ENV === "development";

  const options: LoggerOptions = {
    level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
    // Un niveau lisible par un humain vaut mieux qu'un entier dans un agrégateur.
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: "api",
      env: config.NODE_ENV,
    },
    // Le transport `pino-pretty` et une destination multiple s'excluent : le
    // premier deporte l'ecriture dans un thread worker, ou la seconde n'existe
    // pas. Des qu'une destination est branchee — c'est-a-dire des que le
    // tableau de bord est actif — on ecrit du NDJSON sur la sortie standard.
    //
    // En developpement, `pnpm dev | npx pino-pretty` rend la lisibilite sans
    // rien changer au pipeline.
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
