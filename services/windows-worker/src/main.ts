import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDevicePolicy } from "@nexus/device-policy";
import { loadWorkerConfig } from "./config.js";
import { ConsoleWorkerLogger } from "@nexus/worker-core";
import { assembleCapabilities } from "./assemble.js";
import { FileCredentialSigner } from "./connection/signer.js";
import { WebSocketLink } from "./connection/websocket-link.js";
import { publicStateOf, publishWorkerState } from "./runtime/state-file.js";
import { createWindowsWorker, WORKER_VERSION } from "./worker.js";
import type { WorkerRuntime } from "@nexus/worker-core";
import type { WorkerLink } from "@nexus/worker-core";

/**
 * Worker daemon entrypoint.
 *
 * Runs as a separate process from user interface clients.
 */

export interface StartOptions {
  link?: WorkerLink;
  env?: Record<string, string | undefined>;
}

export async function startWorker(options: StartOptions = {}): Promise<WorkerRuntime> {
  const env = options.env ?? process.env;
  const config = loadWorkerConfig(env);
  const platform = config.platform ?? "WINDOWS";
  const logger = new ConsoleWorkerLogger({ level: config.logLevel, bindings: { WORKER_VERSION } });

  const policyPath = env.WORKER_POLICY_FILE ?? defaultDevicePolicyPath();
  const loaded = await loadDevicePolicy(policyPath);
  logger.info(
    loaded.source === "file"
      ? "local policy loaded"
      : "no local policy: using environment configuration",
    {
      event: "worker.policy",
      source: loaded.source,
      path: loaded.path ?? policyPath,
      allowedRoots: loaded.policy.filesystem.allow.length,
      exec: loaded.policy.exec.mode,
    },
  );

  const { capabilities } = assembleCapabilities({
    config,
    env,
    ...(loaded.source === "file" ? { devicePolicy: loaded.policy } : {}),
  });

  const link =
    options.link ??
    new WebSocketLink({
      backendUrl: config.backendUrl,
      userAgent: `nexus-${platform.toLowerCase()}-worker/${WORKER_VERSION}`,
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

  const statePath = await publishWorkerState(
    config.statePath,
    publicStateOf({
      deviceId: config.deviceId,
      platform,
      workerVersion: WORKER_VERSION,
      now: new Date(),
    }),
  );
  if (statePath === undefined) {
    logger.warn("public state not published: local interface will not detect this worker");
  }

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

function defaultDevicePolicyPath(): string {
  return join(homedir(), ".nexus", "device-policy.yaml");
}

const invokedAsProgram =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsProgram) {
  startWorker().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`NEXUS worker: ${message}\n`);
    process.exitCode = 1;
  });
}
