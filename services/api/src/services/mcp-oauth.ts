import {
  MCP_OAUTH_PRESETS,
  SingleUseOAuthStateStore,
  buildMcpAuthorizationUrl,
  exchangeMcpAuthorizationCode,
  findMcpOAuthPreset,
  type McpManager,
} from "@nexus/mcp";
import type { RuntimeConfigurationStore, SecretVault } from "./runtime-configuration.js";

export interface McpOAuthProviderStatus {
  id: string;
  name: string;
  description: string;
  icon: string;
  docUrl: string;
  defaultScopes: string[];
  supportsPkce: boolean;
  connected: boolean;
  activeInRuntime: boolean;
  clientIdConfigured: boolean;
  vaultRef: string;
}

export interface McpOAuthServiceOptions {
  vault?: SecretVault;
  runtimeConfiguration?: RuntimeConfigurationStore;
  mcpManager?: McpManager;
  stateStore?: SingleUseOAuthStateStore;
}

export class McpOAuthService {
  readonly #vault: SecretVault | undefined;
  readonly #runtime: RuntimeConfigurationStore | undefined;
  readonly #mcpManager: McpManager | undefined;
  readonly #stateStore: SingleUseOAuthStateStore;

  constructor(options: McpOAuthServiceOptions) {
    this.#vault = options.vault;
    this.#runtime = options.runtimeConfiguration;
    this.#mcpManager = options.mcpManager;
    this.#stateStore =
      options.stateStore ?? new SingleUseOAuthStateStore({ defaultTtlMs: 15 * 60 * 1000 });
  }

  async listProviders(): Promise<McpOAuthProviderStatus[]> {
    const activeServers = (await this.#runtime?.loadMcp()) ?? [];
    const activeServerNames = new Set(activeServers.map((s) => s.name));

    return Promise.all(
      MCP_OAUTH_PRESETS.map(async (preset) => {
        let connected = false;
        if (this.#vault !== undefined) {
          try {
            const token = await this.#vault.get(preset.vaultRef);
            connected = typeof token === "string" && token.trim().length > 0;
          } catch {
            connected = false;
          }
        }

        const envClientId = this.#resolveEnvClientId(preset.id);
        const clientIdConfigured = envClientId !== undefined && envClientId.trim().length > 0;

        return {
          id: preset.id,
          name: preset.name,
          description: preset.description,
          icon: preset.icon,
          docUrl: preset.docUrl,
          defaultScopes: preset.defaultScopes,
          supportsPkce: preset.supportsPkce,
          connected,
          activeInRuntime: activeServerNames.has(preset.id),
          clientIdConfigured,
          vaultRef: preset.vaultRef,
        };
      }),
    );
  }

  startAuthorization(
    providerId: string,
    options?: {
      clientId?: string | undefined;
      scopes?: string[] | undefined;
      redirectUri?: string | undefined;
    },
  ): Promise<{ authorizationUrl: string; state: string; providerId: string }> {
    const preset = findMcpOAuthPreset(providerId);
    if (!preset) {
      return Promise.reject(new Error(`Unsupported MCP OAuth provider: ${providerId}`));
    }

    const clientId = options?.clientId ?? this.#resolveEnvClientId(preset.id);
    if (!clientId || clientId.trim().length === 0) {
      return Promise.reject(
        new Error(
          `OAuth Client ID is required for ${preset.name}. Provide it or configure ${this.#envPrefix(preset.id)}_CLIENT_ID.`,
        ),
      );
    }

    const redirectUri = options?.redirectUri ?? "http://127.0.0.1:8080/api/v1/mcp/oauth/callback";

    const { url, state } = buildMcpAuthorizationUrl({
      authorizationEndpoint: preset.authorizationEndpoint,
      clientId,
      redirectUri,
      serverName: preset.id,
      scopes: options?.scopes && options.scopes.length > 0 ? options.scopes : preset.defaultScopes,
      stateStore: this.#stateStore,
    });

    return Promise.resolve({
      authorizationUrl: url,
      state,
      providerId: preset.id,
    });
  }

  async completeAuthorization(
    providerId: string,
    options: {
      code: string;
      state: string;
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      redirectUri?: string | undefined;
    },
  ): Promise<{ success: boolean; providerId: string; connected: boolean }> {
    const preset = findMcpOAuthPreset(providerId);
    if (!preset) {
      throw new Error(`Unsupported MCP OAuth provider: ${providerId}`);
    }

    const clientId = options.clientId ?? this.#resolveEnvClientId(preset.id);
    if (!clientId) {
      throw new Error(`OAuth Client ID is required for token exchange (${preset.name}).`);
    }

    const clientSecret = options.clientSecret ?? this.#resolveEnvClientSecret(preset.id);

    const tokens = await exchangeMcpAuthorizationCode({
      tokenEndpoint: preset.tokenEndpoint,
      code: options.code,
      state: options.state,
      clientId,
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      ...(options.redirectUri !== undefined ? { redirectUri: options.redirectUri } : {}),
      stateStore: this.#stateStore,
    });

    // 1. Store tokens safely into Secret Vault
    if (this.#vault) {
      await this.#vault.set(preset.secretName, tokens.accessToken);
      if (tokens.refreshToken) {
        try {
          await this.#vault.set(`${preset.secretName}-refresh`, tokens.refreshToken);
        } catch {
          // Refresh token storage optional if key name exceeds constraint
        }
      }
    }

    // 2. Persist server in runtime configuration
    const serverConfig = preset.createServerConfig(preset.vaultRef);
    if (this.#runtime) {
      const current = await this.#runtime.loadMcp();
      const updated = current.filter((s) => s.name !== preset.id);
      updated.push(serverConfig);
      await this.#runtime.saveMcp(updated);
    }

    // 3. Hot-add server into runtime McpManager
    if (this.#mcpManager) {
      try {
        await this.#mcpManager.addServer(serverConfig);
      } catch (err) {
        // Log error but token is safely saved
        console.warn(`[McpOAuth] Failed to hot-start MCP server ${preset.id}:`, err);
      }
    }

    return {
      success: true,
      providerId: preset.id,
      connected: true,
    };
  }

  async disconnect(providerId: string): Promise<{ success: boolean; providerId: string }> {
    const preset = findMcpOAuthPreset(providerId);
    if (!preset) {
      throw new Error(`Unsupported MCP OAuth provider: ${providerId}`);
    }

    // 1. Remove from vault
    if (this.#vault) {
      try {
        await this.#vault.delete(preset.secretName);
      } catch {
        // Ignore if already deleted
      }
    }

    // 2. Remove from runtime config
    if (this.#runtime) {
      const current = await this.#runtime.loadMcp();
      const updated = current.filter((s) => s.name !== preset.id);
      await this.#runtime.saveMcp(updated);
    }

    // 3. Stop server in McpManager
    if (this.#mcpManager) {
      try {
        await this.#mcpManager.removeServer(preset.id);
      } catch {
        // Ignore if not running
      }
    }

    return {
      success: true,
      providerId: preset.id,
    };
  }

  #envPrefix(id: string): string {
    return id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  }

  #resolveEnvClientId(id: string): string | undefined {
    const prefix = this.#envPrefix(id);
    return (
      process.env[`NEXUS_MCP_${prefix}_CLIENT_ID`] ??
      process.env[`NEXUS_${prefix}_CLIENT_ID`] ??
      process.env[`${prefix}_CLIENT_ID`]
    );
  }

  #resolveEnvClientSecret(id: string): string | undefined {
    const prefix = this.#envPrefix(id);
    return (
      process.env[`NEXUS_MCP_${prefix}_CLIENT_SECRET`] ??
      process.env[`NEXUS_${prefix}_CLIENT_SECRET`] ??
      process.env[`${prefix}_CLIENT_SECRET`]
    );
  }
}
