import { PluginSecurityError, PluginSandbox } from "./sandbox.js";
import {
  PluginPolicyGuard,
  type LocalSecurityPolicy,
  type PublicReputationAdvisory,
} from "./policy-guard.js";
import type {
  PluginManifest,
  PluginState,
  PluginPolicyApproval,
  PluginExecutionResult,
} from "./types.js";
import { pluginManifestSchema } from "./types.js";

export interface ManagedPluginEntry {
  manifest: PluginManifest;
  state: PluginState;
  approval?: PluginPolicyApproval | undefined;
  reputation?: PublicReputationAdvisory | undefined;
  installedAt: string;
  versionHistory: PluginManifest[];
  revocationReason?: string | undefined;
}

export class PluginLifecycleManager {
  private plugins = new Map<string, ManagedPluginEntry>();
  private readonly sandbox: PluginSandbox = new PluginSandbox();
  private readonly policyGuard: PluginPolicyGuard;

  constructor(localPolicy: LocalSecurityPolicy) {
    this.policyGuard = new PluginPolicyGuard(localPolicy);
  }

  /**
   * Installs a third-party plugin.
   * Rule 6: Third-party plugins remain disabled until their policy is validated.
   */
  installPlugin(rawManifest: unknown, reputation?: PublicReputationAdvisory): ManagedPluginEntry {
    const manifest = pluginManifestSchema.parse(rawManifest);

    if (this.plugins.has(manifest.id)) {
      throw new PluginSecurityError(
        `Plugin '${manifest.id}' is already installed. Use updatePlugin to upgrade.`,
        "ALREADY_INSTALLED",
      );
    }

    const entry: ManagedPluginEntry = {
      manifest,
      state: "INSTALLED_DISABLED", // Always disabled upon install!
      reputation,
      installedAt: new Date().toISOString(),
      versionHistory: [manifest],
    };

    this.plugins.set(manifest.id, entry);
    return entry;
  }

  /**
   * Validates local security policy and approvals for an installed plugin.
   * Transitions plugin to POLICY_VALIDATED state.
   */
  validatePolicy(pluginId: string, approval: PluginPolicyApproval): ManagedPluginEntry {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      throw new PluginSecurityError(`Plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
    }

    if (entry.state === "REVOKED") {
      throw new PluginSecurityError(
        `Cannot validate policy for revoked plugin: ${entry.revocationReason}`,
        "PLUGIN_REVOKED",
      );
    }

    // Assert local security policy compliance (reputation cannot override local policy)
    this.policyGuard.assertLocalPolicyCompliance(entry.manifest, approval, entry.reputation);

    entry.approval = approval;
    entry.state = "POLICY_VALIDATED";
    return entry;
  }

  /**
   * Enables a plugin for execution.
   * Only permitted if the plugin's policy has been validated.
   */
  enablePlugin(pluginId: string): ManagedPluginEntry {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      throw new PluginSecurityError(`Plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
    }

    if (entry.state === "REVOKED") {
      throw new PluginSecurityError(
        `Cannot enable revoked plugin: ${entry.revocationReason}`,
        "PLUGIN_REVOKED",
      );
    }

    // Rule 6: Third-party plugins remain disabled until their policy is validated
    if (entry.state === "INSTALLED_DISABLED" || !entry.approval) {
      throw new PluginSecurityError(
        `Cannot enable plugin '${pluginId}': policy has not been validated and approved`,
        "POLICY_NOT_VALIDATED",
      );
    }

    entry.state = "ACTIVE";
    return entry;
  }

  disablePlugin(pluginId: string): ManagedPluginEntry {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      throw new PluginSecurityError(`Plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
    }
    if (entry.state !== "REVOKED") {
      entry.state = "SUSPENDED";
    }
    return entry;
  }

  updatePlugin(pluginId: string, rawNewManifest: unknown): ManagedPluginEntry {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      throw new PluginSecurityError(`Plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
    }
    if (entry.state === "REVOKED") {
      throw new PluginSecurityError("Cannot update revoked plugin", "PLUGIN_REVOKED");
    }

    const newManifest = pluginManifestSchema.parse(rawNewManifest);
    if (newManifest.id !== pluginId) {
      throw new PluginSecurityError("New manifest ID must match target plugin ID", "ID_MISMATCH");
    }

    entry.versionHistory.push(newManifest);
    entry.manifest = newManifest;
    // New version requires policy validation again!
    entry.state = "INSTALLED_DISABLED";
    entry.approval = undefined;

    return entry;
  }

  rollbackPlugin(pluginId: string): ManagedPluginEntry {
    const entry = this.plugins.get(pluginId);
    if (!entry || entry.versionHistory.length < 2) {
      throw new PluginSecurityError(
        `No previous version available to roll back plugin '${pluginId}'`,
        "NO_ROLLBACK_VERSION",
      );
    }

    entry.versionHistory.pop(); // Remove latest
    const previousManifest = entry.versionHistory[entry.versionHistory.length - 1]!;
    entry.manifest = previousManifest;
    entry.state = "INSTALLED_DISABLED";
    entry.approval = undefined;

    return entry;
  }

  revokePlugin(pluginId: string, reason: string): ManagedPluginEntry {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      throw new PluginSecurityError(`Plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
    }

    entry.state = "REVOKED";
    entry.revocationReason = reason;
    return entry;
  }

  /**
   * Executes a declared plugin tool with sandbox and tenant isolation.
   */
  async executePluginTool(
    pluginId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: {
      tenantId?: string | undefined;
      secrets?: Record<string, string> | undefined;
    },
  ): Promise<PluginExecutionResult> {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      throw new PluginSecurityError(`Plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
    }

    // State check
    if (entry.state !== "ACTIVE") {
      throw new PluginSecurityError(
        `Cannot execute tool '${toolName}': plugin '${pluginId}' is currently ${entry.state}`,
        "PLUGIN_NOT_ACTIVE",
      );
    }

    // Tenant check: plugin cannot access other tenants
    if (
      entry.manifest.tenantId &&
      options?.tenantId &&
      entry.manifest.tenantId !== options.tenantId
    ) {
      throw new PluginSecurityError(
        `Tenant isolation violation: plugin tenant '${entry.manifest.tenantId}' cannot be executed by tenant '${options.tenantId}'`,
        "TENANT_ISOLATION_VIOLATION",
      );
    }

    // Undeclared tool check: cannot execute undeclared tool
    const declaredTool = entry.manifest.declaredTools.find((t) => t.name === toolName);
    if (!declaredTool) {
      throw new PluginSecurityError(
        `Tool '${toolName}' is not declared in plugin manifest`,
        "UNDECLARED_TOOL",
      );
    }

    // Secret isolation: only inject secrets referenced by the plugin's own manifest
    const injectedSecrets: Record<string, string> = {};
    if (options?.secrets) {
      for (const secretKey of Object.keys(entry.manifest.secretRefs)) {
        if (options.secrets[secretKey]) {
          injectedSecrets[secretKey] = options.secrets[secretKey]!;
        }
      }
    }

    const start = Date.now();
    const output = await this.sandbox.executeToolHandler(
      toolName,
      declaredTool.handlerCode,
      input,
      {
        pluginId,
        tenantId: options?.tenantId,
        injectedSecrets,
        allowedEgress: entry.manifest.allowedEgress,
      },
    );

    return {
      success: true,
      pluginId,
      toolName,
      output,
      durationMs: Date.now() - start,
    };
  }

  getPlugin(pluginId: string): ManagedPluginEntry | undefined {
    return this.plugins.get(pluginId);
  }

  listPlugins(): ManagedPluginEntry[] {
    return Array.from(this.plugins.values());
  }
}
