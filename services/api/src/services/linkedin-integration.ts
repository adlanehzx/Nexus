import {
  LinkedInClient,
  LinkedInOAuthStateStore,
  buildLinkedInAuthorizationUrl,
  createLinkedInTools,
  exchangeLinkedInAuthorizationCode,
  linkedInTokensSchema,
} from "@nexus/linkedin";
import type { ToolContext, ToolRegistry } from "@nexus/tools";
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
    if (config !== null) {
      this.#registerTools();
    }
  }

  async status(
    userId?: string,
  ): Promise<{ configured: boolean; connected: boolean; tools: string[] }> {
    const config = await this.#runtime.loadLinkedIn();
    if (config === null) {
      return { configured: false, connected: false, tools: [] };
    }
    const baseKey = config.tokenRef.replace("vault://nexus/", "");
    const raw = userId
      ? await this.#vault.get(`${baseKey}/${userId}`)
      : await this.#vault.get(baseKey);
    const connected = raw !== undefined;
    return { configured: true, connected, tools: connected ? [...TOOL_NAMES] : [] };
  }

  async start(
    config: LinkedInRuntimeConfig,
    userId?: string,
  ): Promise<{ authorizationUrl: string }> {
    await this.#runtime.saveLinkedIn(config);
    const state = this.#states.create(config.redirectUri, userId);
    return {
      authorizationUrl: buildLinkedInAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
      }),
    };
  }

  async complete(input: { code: string; state: string }, userId?: string): Promise<string> {
    const pending = this.#states.consume(input.state);
    if (pending === undefined) throw new Error("Invalid or expired LinkedIn OAuth state.");
    if (pending.userId && userId && pending.userId !== userId) {
      throw new Error(
        "OAuth state user mismatch: callback cannot be completed on behalf of a different user.",
      );
    }
    const targetUserId = userId ?? pending.userId;
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
    const baseKey = config.tokenRef.replace("vault://nexus/", "");
    const serializedTokens = JSON.stringify(tokens);
    const targetKey = targetUserId ? `${baseKey}/${targetUserId}` : baseKey;
    await this.#vault.set(targetKey, serializedTokens);
    this.#registerTools();
    return new URL("/settings?linkedin=connected", config.redirectUri).toString();
  }

  async storeUserTokens(
    userId: string,
    tokens: { accessToken: string; expiresAt: number },
  ): Promise<void> {
    const config = await this.#runtime.loadLinkedIn();
    if (config === null) {
      throw new Error("LinkedIn runtime configuration is not initialized.");
    }
    const baseKey = config.tokenRef.replace("vault://nexus/", "");
    await this.#vault.set(`${baseKey}/${userId}`, JSON.stringify(tokens));
    this.#registerTools();
  }

  async disconnect(userId?: string): Promise<void> {
    const config = await this.#runtime.loadLinkedIn();
    if (config !== null) {
      const baseKey = config.tokenRef.replace("vault://nexus/", "");
      if (userId) {
        await this.#vault.delete(`${baseKey}/${userId}`);
      } else {
        await this.#vault.delete(baseKey);
        for (const name of TOOL_NAMES) {
          this.#registry.unregister(name);
        }
      }
    }
  }

  async resolveClient(context: ToolContext): Promise<LinkedInClient> {
    if (!context.userId || context.userId.trim() === "" || context.userId === "anonymous") {
      throw new Error(
        "Unauthenticated user: LinkedIn actions require an authenticated user context.",
      );
    }
    const config = await this.#runtime.loadLinkedIn();
    if (!config) {
      throw new Error("LinkedIn integration is not configured on this system.");
    }
    const baseKey = config.tokenRef.replace("vault://nexus/", "");
    // Strictly isolate: lookup tokens belonging to context.userId only. ZERO global fallback.
    const raw = await this.#vault.get(`${baseKey}/${context.userId}`);
    if (raw === undefined) {
      throw new Error(`LinkedIn is not connected for user '${context.userId}'.`);
    }
    const tokens = linkedInTokensSchema.parse(JSON.parse(raw));
    if (Date.now() >= tokens.expiresAt) {
      throw new Error("LinkedIn authorization has expired.");
    }
    return new LinkedInClient({
      fetchFn: this.#fetch,
      accessToken: tokens.accessToken,
    });
  }

  #registerTools(): void {
    const tools = createLinkedInTools({
      resolveClient: (context: ToolContext) => this.resolveClient(context),
    });
    for (const tool of tools) {
      this.#registry.register(tool, { replace: true });
    }
  }
}
