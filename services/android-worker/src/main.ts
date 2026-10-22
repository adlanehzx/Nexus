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
 * Entry point for Android worker.
 */

export interface StartAndroidWorkerOptions {
  native: NexusNative;
  env: Record<string, string | undefined>;
  link?: WorkerLink;
  logger?: WorkerLogger;
}

export interface StartedAndroidWorker {
  worker: AndroidWorker;
  config: AndroidWorkerConfig;
  logger: WorkerLogger;
  pairing?: PairingIdentity;
}

/**
 * Builds and starts the worker.
 *
 * @throws {WorkerConfigurationError} if configuration is incomplete or invalid.
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
    signer: new KeystoreCredentialSigner(options.native, config.keyAlias),
    logger,
  });

  let pairing: PairingIdentity | undefined;
  try {
    pairing = await readPairingIdentity(options.native, {
      deviceId: config.deviceId,
      keyAlias: config.keyAlias,
    });
    logger.info("device identity", {
      deviceId: pairing.deviceId,
      publicKeyPem: pairing.publicKeyPem,
    });
  } catch {
    logger.warn("device key unreadable: pairing will not succeed");
  }

  await worker.start();

  return {
    worker,
    config,
    logger,
    ...(pairing === undefined ? {} : { pairing }),
  };
}
