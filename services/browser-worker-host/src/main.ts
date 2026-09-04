import { ConsoleWorkerLogger, type WorkerLink, type WorkerLogger } from "@nexus/worker-core";
import { loadBrowserHostConfig, describeConfig, type BrowserHostConfig } from "./config.js";
import { assembleBrowserHost } from "./assemble.js";
import { CoreLink, FileCredentialSigner } from "./connection/link.js";
import { BrowserWorkerHost, WORKER_VERSION } from "./worker.js";

/**
 * Point d'entrée de l'exécutant navigateur.
 *
 * Même forme que `main.ts` du démon Windows et de l'application Android :
 * configuration, capacités, canal, signature, démarrage. C'est voulu — trois
 * exécutants, un seul cycle de vie.
 *
 * ## Ce que ce processus est
 *
 * Un **hôte**, pas un navigateur. Il ne connaît ni `browser-use` ni Chromium :
 * il traduit des capacités NEXUS en appels au worker Python, qui tourne à côté
 * (ADR-006). Le séparer garde trois propriétés : un Chromium qui plante ne
 * fait pas tomber la session avec le cœur, la mémoire du navigateur est
 * cloisonnée, et le processus qui visite du contenu hostile ne détient pas la
 * clé de l'appareil.
 *
 * ## Ce qu'il n'est pas
 *
 * Il n'écoute sur aucun port. Il n'accepte aucune connexion entrante. Il ne
 * décide d'aucune permission : le cœur autorise, le worker Python restreint les
 * actions, et cet hôte transporte.
 */

export interface StartOptions {
  /**
   * Canal vers le cœur.
   *
   * Fourni par les tests, qui branchent une boucle locale sur une vraie
   * `WorkerGateway`. Absent en service : l'hôte ouvre sa WebSocket sortante.
   */
  link?: WorkerLink;
  env?: Record<string, string | undefined>;
  logger?: WorkerLogger;
}

export interface StartedBrowserHost {
  host: BrowserWorkerHost;
  config: BrowserHostConfig;
  logger: WorkerLogger;
}

/**
 * Construit et démarre l'hôte.
 *
 * @throws {WorkerConfigurationError} si la configuration est incomplète. On
 *   refuse de démarrer plutôt que de s'annoncer sans savoir joindre le
 *   navigateur : le sélecteur choisirait cet exécutant, et chaque étape
 *   échouerait après avoir écarté quelqu'un qui aurait su faire.
 */
export async function startBrowserWorkerHost(
  options: StartOptions = {},
): Promise<StartedBrowserHost> {
  const env = options.env ?? process.env;
  const config = loadBrowserHostConfig(env);

  const logger =
    options.logger ??
    new ConsoleWorkerLogger({ level: config.logLevel, bindings: { WORKER_VERSION } });

  const { capabilities, client, sessions } = assembleBrowserHost({ config });

  // `describeConfig` ne rend que des noms et des présences : ni le jeton du
  // worker Python, ni le chemin de la clé de l'appareil n'y figurent.
  logger.info("configuration chargée", describeConfig(config));

  const link = options.link ?? new CoreLink({ backendUrl: config.backendUrl });

  const host = new BrowserWorkerHost({
    config,
    capabilities,
    client,
    sessions,
    link,
    signer: new FileCredentialSigner(config.deviceKeyPath),
    logger,
  });

  await host.start();
  return { host, config, logger };
}

/**
 * Démarre l'hôte et l'arrête proprement sur signal.
 *
 * Un arrêt brutal laisserait deux traces : le cœur attendrait des résultats qui
 * n'arriveront jamais, et des Chromium resteraient ouverts jusqu'à expiration
 * de leur TTL. On annule, on remonte les échecs, on ferme les navigateurs.
 */
export async function runBrowserWorkerHost(options: StartOptions = {}): Promise<void> {
  const { host, logger } = await startBrowserWorkerHost(options);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;

    void host
      .stop(`signal ${signal}`)
      .catch((cause: unknown) => {
        logger.error("arrêt incomplet", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}
