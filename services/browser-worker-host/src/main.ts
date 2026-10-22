import { ConsoleWorkerLogger, type WorkerLink, type WorkerLogger } from "@nexus/worker-core";
import { loadBrowserHostConfig, describeConfig, type BrowserHostConfig } from "./config.js";
import { assembleBrowserHost } from "./assemble.js";
import { CoreLink, FileCredentialSigner } from "./connection/link.js";
import { BrowserWorkerHost, WORKER_VERSION } from "./worker.js";

/**
 * Entry point for the browser worker host daemon.
 */

export interface StartOptions {
  /** Core link transport. Injected by tests, defaults to outbound WebSocket. */
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
 * Construct and start the browser worker host.
 *
 * @throws {WorkerConfigurationError} if configuration is incomplete.
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

  logger.info("configuration loaded", describeConfig(config));

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
 * Start host and wire graceful shutdown on OS process signals.
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
        logger.error("shutdown incomplete", {
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
