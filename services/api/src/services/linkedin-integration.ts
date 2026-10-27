import {
  LinkedInClient,
  LinkedInOAuthStateStore,
  buildLinkedInAuthorizationUrl,
  createLinkedInTools,
  exchangeLinkedInAuthorizationCode,
  linkedInTokensSchema,
} from "@nexus/linkedin";
import type { ToolRegistry } from "@nexus/tools";
import type {
  LinkedInRuntimeConfig,
  RuntimeConfigurationStore,
  SecretVault,
} from "./runtime-configuration.js";

const TOOL_NAMES = [
  "linkedin.profile.read",
  "linkedin.post.publish",
  "linkedin.comment.publish",
] as const;

export class LinkedInIntegrationService {
  readonly #runtime: RuntimeConfigurationStore;
  readonly #vault: Pick<SecretVault, "get" | "set" | "delete">;
  readonly #registry: ToolRegistry;
  readonly #states = new LinkedInOAuthStateStore();
  readonly #fetch: typeof fetch;

  constructor(input: {
    runtime: RuntimeConfigurationStore;
    vault: Pick<SecretVault, "get" | "set" | "delete">;
    registry: ToolRegistry;
    fetchFn?: typeof fetch;
  }) {
    this.#runtime = input.runtime;
    this.#vault = input.vault;
    this.#registry = input.registry;
    this.#fetch = input.fetchFn ?? fetch;
  }

  async initialize(): Promise<void> {
    const config = await this.#runtime.loadLinkedIn();
    if (config !== null && (await this.#vault.get(config.tokenRef)) !== undefined) {
      this.#registerTools(config);
    }
  }

  async status(): Promise<{ configured: boolean; connected: boolean; tools: string[] }> {
    const config = await this.#runtime.loadLinkedIn();
    const connected = config !== null && (await this.#vault.get(config.tokenRef)) !== undefined;
    return { configured: config !== null, connected, tools: connected ? [...TOOL_NAMES] : [] };
  }

  async start(config: LinkedInRuntimeConfig): Promise<{ authorizationUrl: string }> {
    await this.#runtime.saveLinkedIn(config);
    const state = this.#states.create(config.redirectUri);
    return {
      authorizationUrl: buildLinkedInAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
      }),
    };
  }

  async complete(input: { code: string; state: string }): Promise<string> {
    const pending = this.#states.consume(input.state);
    if (pending === undefined) throw new Error("Invalid or expired LinkedIn OAuth state.");
    const config = await this.#runtime.loadLinkedIn();
    if (config?.redirectUri !== pending.redirectUri) {
      throw new Error("LinkedIn OAuth configuration changed during authorization.");
    }
    const secret = await this.#vault.get(config.clientSecretRef);
    if (secret === undefined) throw new Error("LinkedIn client secret is missing from the vault.");
    const tokens = await exchangeLinkedInAuthorizationCode({
      code: input.code,
      clientId: config.clientId,
      clientSecret: secret,
      redirectUri: config.redirectUri,
      fetchFn: this.#fetch,
    });
    await this.#vault.set(config.tokenRef.replace("vault://nexus/", ""), JSON.stringify(tokens));
    this.#registerTools(config);
    return new URL("/settings?linkedin=connected", config.redirectUri).toString();
  }

  async disconnect(): Promise<void> {
    const config = await this.#runtime.loadLinkedIn();
    if (config !== null) await this.#vault.delete(config.tokenRef.replace("vault://nexus/", ""));
    for (const name of TOOL_NAMES) this.#registry.unregister(name);
  }

  #registerTools(config: LinkedInRuntimeConfig): void {
    const client = new LinkedInClient({
      fetchFn: this.#fetch,
      accessToken: async () => {
        const raw = await this.#vault.get(config.tokenRef);
        if (raw === undefined) throw new Error("LinkedIn is not connected.");
        const tokens = linkedInTokensSchema.parse(JSON.parse(raw));
        if (Date.now() >= tokens.expiresAt) throw new Error("LinkedIn authorization has expired.");
        return tokens.accessToken;
      },
    });
    for (const tool of createLinkedInTools({ client }))
      this.#registry.register(tool, { replace: true });
  }
}
