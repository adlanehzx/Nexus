import { LocalCapabilityRegistry, type LocalCapability } from "@nexus/worker-core";
import { BrowserWorkerClient } from "@nexus/browser-client";
import type { BrowserHostConfig } from "./config.js";
import { SessionPool } from "./runtime/session-pool.js";
import { createBrowseCapabilities } from "./capabilities/browse.js";

/**
 * Assemblage de l'exécutant navigateur.
 *
 * Un seul endroit relie le client HTTP, le pool de sessions et les capacités.
 * Le reste du code ne construit rien : il reçoit ce dont il a besoin. C'est ce
 * qui permet aux tests de remplacer le worker Python par un double et
 * d'éprouver toute la chaîne — validation, session, progression, annulation,
 * erreurs — sans navigateur, sans Chromium et sans clé de modèle.
 */

export interface AssembleOptions {
  config: BrowserHostConfig;
  /** Injecté par les tests. En service, construit depuis la configuration. */
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
    // Le propriétaire vu par le worker Python est l'appareil, pas l'humain :
    // le registre du cœur lie déjà cet appareil à un utilisateur, et le nom de
    // l'utilisateur n'a rien à faire dans un service qui visite des sites tiers.
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
