import { ConsoleWorkerLogger, type WorkerLink, type WorkerLogger } from "@nexus/worker-core";
import { loadAndroidConfig, type AndroidWorkerConfig } from "./config.js";
import { assembleCapabilities } from "./assemble.js";
import {
  createAndroidPlatform,
  KeystoreCredentialSigner,
  type NexusNative,
} from "./bridge/native-bridge.js";
import { AndroidWebSocketLink } from "./connection/websocket-link.js";
import { readPairingIdentity, type PairingIdentity } from "./pairing.js";
import { AndroidWorker, WORKER_VERSION } from "./worker.js";

/**
 * Point d'entrée du worker Android.
 *
 * Le pendant de `main.ts` du démon Windows, et volontairement la même forme :
 * configuration, capacités, canal, signature, démarrage. Ce qui change tient en
 * deux lignes — la clé vit dans le magasin de clés d'Android, et le canal est le
 * `WebSocket` de React Native.
 *
 * **Ce n'est pas un client NEXUS.** Le téléphone exécute ; il ne pilote pas. Il
 * n'y a ici ni session utilisateur, ni jeton d'accès, ni flux d'événements
 * client : le worker s'authentifie comme *appareil*, avec la clé de l'appareil,
 * et ne reçoit que ce que le cœur lui confie.
 *
 * ## Ce que cette fonction ne fait pas
 *
 * Elle ne demande aucune permission et n'active aucun service. Le service
 * d'accessibilité ne s'active que dans les réglages du téléphone, par
 * l'utilisateur — aucune API ne permet de le faire par programme, et ce worker
 * ne cherche pas à contourner cette règle. Ce qui n'est pas accordé n'est
 * simplement pas annoncé au cœur, et l'écran de gestion dit où l'accorder.
 */

export interface StartAndroidWorkerOptions {
  /**
   * Le module natif, tel que React Native l'expose.
   *
   * Injecté plutôt qu'importé : `NativeModules` n'existe pas hors du téléphone,
   * et l'importer ici rendrait ce fichier — donc tout le point d'entrée —
   * impossible à charger dans un test.
   */
  native: NexusNative;
  /**
   * Configuration. Sur Android il n'y a pas de `process.env` : les valeurs sont
   * empaquetées à la construction, et l'hôte les passe telles quelles.
   */
  env: Record<string, string | undefined>;
  /**
   * Canal vers le cœur.
   *
   * Fourni par les tests, qui branchent une boucle locale sur une vraie
   * `WorkerGateway`. Absent en production : le worker ouvre alors sa WebSocket
   * sortante.
   */
  link?: WorkerLink;
  logger?: WorkerLogger;
}

export interface StartedAndroidWorker {
  worker: AndroidWorker;
  config: AndroidWorkerConfig;
  logger: WorkerLogger;
  /**
   * De quoi appairer l'appareil au cœur.
   *
   * `undefined` si le magasin de clés a refusé : le worker démarre quand même,
   * il échouera simplement à la signature du défi. Refuser de démarrer
   * priverait l'utilisateur de l'écran qui lui explique ce qui ne va pas.
   */
  pairing?: PairingIdentity;
}

/**
 * Construit et démarre le worker.
 *
 * @throws {WorkerConfigurationError} si la configuration est incomplète ou
 *   incohérente. On refuse de démarrer plutôt que de tourner à moitié configuré :
 *   un worker qui s'annonce sans savoir joindre le cœur se ferait choisir par le
 *   sélecteur, puis échouerait tâche après tâche.
 */
export async function startAndroidWorker(
  options: StartAndroidWorkerOptions,
): Promise<StartedAndroidWorker> {
  const config = loadAndroidConfig(options.env);

  const logger =
    options.logger ??
    new ConsoleWorkerLogger({ level: config.logLevel, bindings: { WORKER_VERSION } });

  const platform = createAndroidPlatform(options.native);
  const { capabilities } = assembleCapabilities({ config, platform });

  const link =
    options.link ??
    new AndroidWebSocketLink({
      backendUrl: config.backendUrl,
      userAgent: `nexus-android-worker/${WORKER_VERSION}`,
    });

  const worker = new AndroidWorker({
    config,
    platform,
    capabilities,
    link,
    // L'alias, jamais la clé. La signature est calculée dans le magasin de clés
    // d'Android ; l'application ne lit pas le secret, elle demande un résultat.
    signer: new KeystoreCredentialSigner(options.native, config.keyAlias),
    logger,
  });

  // Lue avant le démarrage : c'est aussi ce qui **crée** la clé au premier
  // lancement, et le défi qui suit en a besoin.
  let pairing: PairingIdentity | undefined;
  try {
    pairing = await readPairingIdentity(options.native, {
      deviceId: config.deviceId,
      keyAlias: config.keyAlias,
    });
    // Une clé publique se publie : la journaliser ne divulgue rien, et c'est le
    // moyen le plus simple de la récupérer sur un téléphone branché.
    logger.info("identité de l'appareil", {
      deviceId: pairing.deviceId,
      publicKeyPem: pairing.publicKeyPem,
    });
  } catch {
    logger.warn("clé de l'appareil illisible : l'appairage ne pourra pas se faire");
  }

  await worker.start();

  return {
    worker,
    config,
    logger,
    ...(pairing === undefined ? {} : { pairing }),
  };
}
