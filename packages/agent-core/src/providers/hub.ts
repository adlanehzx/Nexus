/**
 * NEXUS Unified Provider Architecture - Provider Hub
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProviderType } from "@nexus/protocol";
import type {
  ModelDescriptor,
  ProviderDriver,
  ProviderSession,
  ProviderSessionConfig,
} from "./types.js";
import { ModelCatalog } from "./catalog.js";
import { AcpProviderDriver } from "./acp-driver.js";
import { ClaudeProviderDriver } from "./claude-driver.js";
import { CursorProviderDriver } from "./cursor-driver.js";
import { GrokProviderDriver } from "./grok-driver.js";

export class ProviderHub {
  private readonly drivers = new Map<ProviderType, ProviderDriver>();
  private readonly activeSessions = new Map<string, ProviderSession>();
  public readonly catalog: ModelCatalog;

  constructor(catalog: ModelCatalog = new ModelCatalog()) {
    this.catalog = catalog;

    // Register built-in unified drivers
    this.registerDriver(new AcpProviderDriver());
    this.registerDriver(new ClaudeProviderDriver());
    this.registerDriver(new CursorProviderDriver());
    this.registerDriver(new GrokProviderDriver());
  }

  registerDriver(driver: ProviderDriver): void {
    this.drivers.set(driver.id, driver);
  }

  getDriver(provider: ProviderType): ProviderDriver | undefined {
    return this.drivers.get(provider);
  }

  listDrivers(): ProviderDriver[] {
    return Array.from(this.drivers.values());
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const driver = this.drivers.get(config.model.provider);
    if (!driver) {
      throw new Error(`Unsupported agent provider: '${config.model.provider}'`);
    }

    const session = await driver.createSession(config);
    this.activeSessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): ProviderSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return false;
    }
    await session.close();
    this.activeSessions.delete(sessionId);
    return true;
  }

  async closeAll(): Promise<void> {
    const promises = Array.from(this.activeSessions.values()).map((s) => s.close());
    await Promise.allSettled(promises);
    this.activeSessions.clear();
  }

  resolveFallback(preferredProvider: ProviderType, preferredModelId?: string): ModelDescriptor {
    const directMatch = preferredModelId
      ? this.catalog.get(preferredProvider, preferredModelId)
      : this.catalog.getDefault(preferredProvider);

    if (directMatch) {
      return directMatch;
    }

    // Default global fallback
    const fallback = this.catalog.getDefault();
    if (!fallback) {
      throw new Error("No available models found in catalog");
    }
    return fallback;
  }
}
