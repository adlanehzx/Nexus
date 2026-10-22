import { LocalCapabilityRegistry, type LocalCapability } from "@nexus/worker-core";
import { BrowserWorkerClient } from "@nexus/browser-client";
import type { BrowserHostConfig } from "./config.js";
import { SessionPool } from "./runtime/session-pool.js";
import { createBrowseCapabilities } from "./capabilities/browse.js";

/**
 * Assemble the browser worker host.
 *
 * Connects the HTTP client, session pool, and capabilities in a single location.
 */

export interface AssembleOptions {
  config: BrowserHostConfig;
  /** Injected by tests. In production, constructed from config. */
  client?: BrowserWorkerClient;
}

export interface AssembledBrowserHost {
  capabilities: LocalCapabilityRegistry;
  client: BrowserWorkerClient;
  sessions: SessionPool;
}

export function assembleBrowserHost(options: AssembleOptions): AssembledBrowserHost {
  const { config } = options;

  const client =
    options.client ??
    new BrowserWorkerClient({
      baseUrl: config.browserWorkerUrl,
      token: config.browserWorkerToken,
    });

  const sessions = new SessionPool({
    client,
    allowedDomains: config.allowedDomains,
    prohibitedDomains: config.prohibitedDomains,
    ttlSeconds: config.sessionTtlSeconds,
    headless: config.headless,
    // The owner reported to the Python worker is the device ID.
    ownerId: config.deviceId,
  });

  const registry = new LocalCapabilityRegistry(config.declaredCapabilities);

  registry.registerAll(
    createBrowseCapabilities({
      client,
      sessions,
      maxSteps: config.maxSteps,
    }) as unknown as LocalCapability<never, unknown>[],
  );

  return { capabilities: registry, client, sessions };
}
