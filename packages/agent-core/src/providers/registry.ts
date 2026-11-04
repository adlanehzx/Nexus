/**
 * NEXUS Next-Gen Provider Architecture - Registry, Instance & Session Management (LOT C)
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProviderType } from "@nexus/protocol";
import type {
  ProviderDriver,
  ProviderSession,
  ProviderSessionConfig,
  ModelDescriptor,
} from "./types.js";

export interface ProviderInstanceConfig {
  instanceId: string;
  providerType: ProviderType;
  displayName: string;
  priority: number;
  credentials?: Record<string, string>;
  settings?: Record<string, unknown>;
  enabled: boolean;
}

export interface ProviderInstanceHealth {
  status: "healthy" | "degraded" | "unreachable" | "cooling_down";
  latencyMs?: number | undefined;
  consecutiveFailures: number;
  lastCheckedAt: string;
  cooldownUntil?: string | undefined;
}

export class ProviderInstance {
  readonly id: string;
  readonly providerType: ProviderType;
  readonly driver: ProviderDriver;
  private config: ProviderInstanceConfig;
  private health: ProviderInstanceHealth;

  constructor(driver: ProviderDriver, config: ProviderInstanceConfig) {
    this.id = config.instanceId;
    this.providerType = config.providerType;
    this.driver = driver;
    this.config = { ...config };
    this.health = {
      status: "healthy",
      consecutiveFailures: 0,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  getConfig(): ProviderInstanceConfig {
    return { ...this.config };
  }

  getHealth(): ProviderInstanceHealth {
    return { ...this.health };
  }

  isAvailable(): boolean {
    if (!this.config.enabled) return false;
    if (this.health.status === "cooling_down") {
      if (this.health.cooldownUntil && new Date(this.health.cooldownUntil).getTime() > Date.now()) {
        return false;
      }
      // Cooldown expired
      this.health.status = "healthy";
    }
    return this.health.status !== "unreachable";
  }

  recordSuccess(latencyMs?: number): void {
    this.health = {
      status: "healthy",
      latencyMs,
      consecutiveFailures: 0,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  recordFailure(cooldownDurationMs = 60000): void {
    const consecutiveFailures = this.health.consecutiveFailures + 1;
    const cooldownUntil =
      consecutiveFailures >= 3
        ? new Date(Date.now() + cooldownDurationMs).toISOString()
        : undefined;

    this.health = {
      status: cooldownUntil ? "cooling_down" : "degraded",
      consecutiveFailures,
      lastCheckedAt: new Date().toISOString(),
      cooldownUntil,
    };
  }

  async createSession(sessionConfig: ProviderSessionConfig): Promise<ProviderSession> {
    return this.driver.createSession(sessionConfig);
  }
}

export class ProviderRegistry {
  private readonly drivers = new Map<ProviderType, ProviderDriver>();
  private readonly instances = new Map<string, ProviderInstance>();

  registerDriver(driver: ProviderDriver): void {
    this.drivers.set(driver.id, driver);
  }

  getDriver(type: ProviderType): ProviderDriver | undefined {
    return this.drivers.get(type);
  }

  listDrivers(): ProviderDriver[] {
    return [...this.drivers.values()];
  }

  registerInstance(instance: ProviderInstance): void {
    this.instances.set(instance.id, instance);
  }

  getInstance(instanceId: string): ProviderInstance | undefined {
    return this.instances.get(instanceId);
  }

  listInstances(providerType?: ProviderType): ProviderInstance[] {
    let list = [...this.instances.values()];
    if (providerType) {
      list = list.filter((i) => i.providerType === providerType);
    }
    return list.sort((a, b) => a.getConfig().priority - b.getConfig().priority);
  }

  async listAllModels(): Promise<ModelDescriptor[]> {
    const models: ModelDescriptor[] = [];
    for (const driver of this.drivers.values()) {
      const driverModels = await driver.listModels();
      models.push(...driverModels);
    }
    return models;
  }

  async resolveBestInstance(providerType: ProviderType): Promise<ProviderInstance | undefined> {
    const instances = this.listInstances(providerType);
    return instances.find((i) => i.isAvailable());
  }
}
