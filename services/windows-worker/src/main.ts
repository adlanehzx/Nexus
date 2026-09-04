import { loadWorkerConfig } from "./config.js";
import { ConsoleWorkerLogger } from "@nexus/worker-core";
import { assembleCapabilities } from "./assemble.js";
import { FileCredentialSigner } from "./connection/signer.js";
import { WebSocketLink } from "./connection/websocket-link.js";
import { publicStateOf, publishWorkerState } from "./runtime/state-file.js";
import { createWindowsWorker, WORKER_PLATFORM, WORKER_VERSION } from "./worker.js";
import type { WorkerRuntime } from "@nexus/worker-core";
import type { WorkerLink } from "@nexus/worker-core";

/**
 * Point d'entrée du démon exécutant.
 *
 * **Un processus séparé de l'interface.** Sur le portable, les deux tournent en
 * même temps et servent le même utilisateur, mais ils ne se parlent pas : le
 * démon détient la clé privée de la machine et se connecte au canal exécutant ;
 * la fenêtre détient les jetons de l'utilisateur et se connecte au canal client.
 *
 * Quand l'utilisateur demande depuis la fenêtre quelque chose que ce poste doit
 * faire, la demande sort par le réseau, remonte au cœur, y est autorisée, puis
 * redescend ici. Le trajet paraît long pour deux processus voisins ; il est ce
 * qui garantit qu'aucune interface ne devient une console d'administration.
 */

export interface StartOptions {
  /**
   * Canal vers le cœur.
   *
   * Fourni par les tests, qui branchent une boucle locale sur une vraie
   * `WorkerGateway`. Absent en production : le démon ouvre alors sa WebSocket
   * sortante.
   */
  link?: WorkerLink;
  env?: Record<string, string | undefined>;
}

export async function startWorker(options: StartOptions = {}): Promise<WorkerRuntime> {
  const env = options.env ?? process.env;
  const config = loadWorkerConfig(env);
  const logger = new ConsoleWorkerLogger({ level: config.logLevel, bindings: { WORKER_VERSION } });

  const { capabilities } = assembleCapabilities({ config, env });

  const link =
    options.link ??
    new WebSocketLink({
      backendUrl: config.backendUrl,
      userAgent: `nexus-windows-worker/${WORKER_VERSION}`,
      ...(config.coreFingerprint === undefined
        ? {}
        : { corePublicKeyFingerprint: config.coreFingerprint }),
    });

  const worker = createWindowsWorker({
    config,
    link,
    signer: new FileCredentialSigner(config.credentialPath),
    capabilities,
    logger,
  });

  // Carte de visite pour l'interface installée sur la même machine. En échec,
  // on continue : la fenêtre affichera « aucun exécutant détecté », ce qui est
  // gênant et sans conséquence — refuser de démarrer, non.
  const statePath = await publishWorkerState(
    config.statePath,
    publicStateOf({
      deviceId: config.deviceId,
      platform: WORKER_PLATFORM,
      workerVersion: WORKER_VERSION,
      now: new Date(),
    }),
  );
  if (statePath === undefined) {
    logger.warn("état public non publié : l'interface locale ne détectera pas cet exécutant");
  }

  // Un arrêt brutal laisserait le cœur attendre des résultats qui n'arriveront
  // jamais. On annule proprement, on remonte les échecs, puis on ferme.
  const shutdown = (signal: string) => {
    void worker.stop(`signal ${signal}`).finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  await worker.start();
  return worker;
}
