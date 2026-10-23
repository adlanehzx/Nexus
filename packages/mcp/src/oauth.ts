import { createHash, randomBytes } from "node:crypto";
import { McpSecurityError } from "./errors.js";

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generates RFC 7636 PKCE code_verifier and code_challenge using S256.
 */
export function generateMcpPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export interface PendingOAuthSession {
  serverName: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Single-use in-memory store for anti-replay protection of OAuth authorization states.
 */
export class SingleUseOAuthStateStore {
  readonly #pending = new Map<string, PendingOAuthSession>();
  readonly #defaultTtlMs: number;
  readonly #now: () => number;

  constructor(options?: { defaultTtlMs?: number; now?: () => number }) {
    this.#defaultTtlMs = options?.defaultTtlMs ?? 10 * 60 * 1000; // 10 minutes default
    this.#now = options?.now ?? Date.now;
  }

  /**
   * Registers a single-use OAuth state record.
   */
  createState(metadata: {
    serverName: string;
    codeVerifier: string;
    redirectUri: string;
    ttlMs?: number;
  }): string {
    this.#cleanupExpired();
    const state = randomBytes(24).toString("base64url");
    const now = this.#now();
    const expiresAt = now + (metadata.ttlMs ?? this.#defaultTtlMs);

    this.#pending.set(state, {
      serverName: metadata.serverName,
      codeVerifier: metadata.codeVerifier,
      redirectUri: metadata.redirectUri,
      createdAt: now,
      expiresAt,
    });

    return state;
  }

  /**
   * Retrieves and immediately consumes the OAuth state.
   * Throws McpSecurityError if state is missing, already used, or expired.
   */
  consumeState(state: string): PendingOAuthSession {
    this.#cleanupExpired();
    const session = this.#pending.get(state);

    if (!session) {
      throw new McpSecurityError(
        "oauth",
        "OAuth state is invalid or has already been consumed (anti-replay violation).",
      );
    }

    // Single-use: delete immediately
    this.#pending.delete(state);

    if (this.#now() > session.expiresAt) {
      throw new McpSecurityError(session.serverName, "OAuth authorization state has expired.");
    }

    return session;
  }

  get pendingCount(): number {
    this.#cleanupExpired();
    return this.#pending.size;
  }

  #cleanupExpired(): void {
    const now = this.#now();
    for (const [key, session] of this.#pending.entries()) {
      if (now > session.expiresAt) {
        this.#pending.delete(key);
      }
    }
  }
}

export interface BuildAuthUrlOptions {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  serverName: string;
  scopes?: string[];
  stateStore: SingleUseOAuthStateStore;
  additionalParams?: Record<string, string>;
}

export interface AuthUrlResult {
  url: string;
  state: string;
  codeVerifier: string;
}

/**
 * Builds an official OAuth authorization URL using PKCE S256 and single-use state.
 */
export function buildMcpAuthorizationUrl(options: BuildAuthUrlOptions): AuthUrlResult {
  const { codeVerifier, codeChallenge } = generateMcpPkcePair();
  const state = options.stateStore.createState({
    serverName: options.serverName,
    codeVerifier,
    redirectUri: options.redirectUri,
  });

  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  if (options.scopes && options.scopes.length > 0) {
    url.searchParams.set("scope", options.scopes.join(" "));
  }

  for (const [k, v] of Object.entries(options.additionalParams ?? {})) {
    url.searchParams.set(k, v);
  }

  return {
    url: url.toString(),
    state,
    codeVerifier,
  };
}

export interface ExchangeCodeOptions {
  tokenEndpoint: string;
  code: string;
  state: string;
  clientId: string;
  clientSecret?: string;
  stateStore: SingleUseOAuthStateStore;
  fetchFn?: typeof fetch;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  scope?: string;
}

/**
 * Exchanges the authorization code for tokens, consuming the single-use state
 * and verifying PKCE verifier.
 */
export async function exchangeMcpAuthorizationCode(
  options: ExchangeCodeOptions,
): Promise<OAuthTokens> {
  const session = options.stateStore.consumeState(options.state);
  const fetchImpl = options.fetchFn ?? fetch;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: session.redirectUri,
    client_id: options.clientId,
    code_verifier: session.codeVerifier,
  });

  if (options.clientSecret) {
    body.set("client_secret", options.clientSecret);
  }

  const response = await fetchImpl(options.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new McpSecurityError(
      session.serverName,
      `OAuth token exchange failed (HTTP ${response.status}): ${errorBody}`,
    );
  }

  const rawJson = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof rawJson.access_token === "string" ? rawJson.access_token : "";
  if (!accessToken) {
    throw new McpSecurityError(
      session.serverName,
      "OAuth token endpoint did not return an access_token.",
    );
  }

  const refreshToken =
    typeof rawJson.refresh_token === "string" ? rawJson.refresh_token : undefined;
  const tokenType = typeof rawJson.token_type === "string" ? rawJson.token_type : "Bearer";

  return {
    accessToken,
    tokenType,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(typeof rawJson.expires_in === "number" ? { expiresIn: rawJson.expires_in } : {}),
    ...(typeof rawJson.scope === "string" ? { scope: rawJson.scope } : {}),
  };
}

export type VaultWriter = (ref: string, value: string) => Promise<void>;

/**
 * Stores OAuth tokens strictly in the NEXUS secret vault under canonical keys.
 * Never stores plain tokens in configs, URLs, or frontend-visible structures.
 */
export async function storeMcpTokensInVault(
  vaultWriter: VaultWriter,
  serverName: string,
  tokens: OAuthTokens,
): Promise<{ accessTokenRef: string; refreshTokenRef?: string }> {
  const accessTokenRef = `vault:mcp:${serverName}:access_token`;
  await vaultWriter(accessTokenRef, tokens.accessToken);

  let refreshTokenRef: string | undefined;
  if (tokens.refreshToken) {
    refreshTokenRef = `vault:mcp:${serverName}:refresh_token`;
    await vaultWriter(refreshTokenRef, tokens.refreshToken);
  }

  return {
    accessTokenRef,
    ...(refreshTokenRef !== undefined ? { refreshTokenRef } : {}),
  };
}
