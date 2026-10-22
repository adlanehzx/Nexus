import { createHash, randomBytes } from "node:crypto";
import {
  type GoogleOAuthTokens,
  type GoogleWorkspaceScope,
  GOOGLE_WORKSPACE_SCOPES,
  googleOAuthTokensSchema,
} from "./types.js";

export type SecretResolver = (ref: string) => Promise<string | undefined>;
export type SecretWriter = (ref: string, value: string) => Promise<void>;

/**
 * Generates a PKCE key pair (RFC 7636) compliant with OAuth 2.0 recommendations for public/local clients.
 */
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9_-]/g, "");

  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  return { codeVerifier, codeChallenge };
}

/**
 * Builds official Google authorization URL with PKCE and offline access (refresh token).
 */
export function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: GoogleWorkspaceScope[];
}): string {
  const scopes = options.scopes ?? Object.values(GOOGLE_WORKSPACE_SCOPES);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);

  return url.toString();
}

/**
 * Exchanges authorization code for access and refresh tokens.
 */
export async function exchangeAuthorizationCode(options: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): Promise<GoogleOAuthTokens> {
  const fetchImpl = options.fetchFn ?? fetch;

  const body = new URLSearchParams({
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    grant_type: "authorization_code",
  });

  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google OAuth exchange failed (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };

  const now = Date.now();
  return googleOAuthTokensSchema.parse({
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: now + data.expires_in * 1000,
    tokenType: "Bearer",
    ...(data.scope ? { scope: data.scope } : {}),
  });
}

/**
 * Renews access token using the refresh token.
 */
export async function refreshAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}): Promise<GoogleOAuthTokens> {
  const fetchImpl = options.fetchFn ?? fetch;

  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: options.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google token refresh failed (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
    refresh_token?: string;
  };

  const now = Date.now();
  return googleOAuthTokensSchema.parse({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? options.refreshToken,
    expiresAt: now + data.expires_in * 1000,
    tokenType: "Bearer",
    ...(data.scope ? { scope: data.scope } : {}),
  });
}

/**
 * Secure Google Workspace token manager backed by the NEXUS vault (`vault://`).
 */
export class GoogleTokenManager {
  readonly #clientId: string;
  readonly #clientSecretRef: string;
  readonly #tokensRef: string;
  readonly #resolveSecret: SecretResolver;
  readonly #writeSecret: SecretWriter | undefined;
  readonly #fetchFn: typeof fetch;

  constructor(options: {
    clientId: string;
    clientSecretRef: string;
    tokensRef: string;
    resolveSecret: SecretResolver;
    writeSecret?: SecretWriter | undefined;
    fetchFn?: typeof fetch | undefined;
  }) {
    this.#clientId = options.clientId;
    this.#clientSecretRef = options.clientSecretRef;
    this.#tokensRef = options.tokensRef;
    this.#resolveSecret = options.resolveSecret;
    this.#writeSecret = options.writeSecret;
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Retrieves a valid access token, automatically refreshing if expiring soon.
   */
  async getValidAccessToken(): Promise<string> {
    const rawTokens = await this.#resolveSecret(this.#tokensRef);
    if (!rawTokens) {
      throw new Error(`No Google tokens found in vault under reference "${this.#tokensRef}"`);
    }

    let tokens: GoogleOAuthTokens;
    try {
      tokens = googleOAuthTokensSchema.parse(JSON.parse(rawTokens));
    } catch {
      throw new Error(`Invalid Google token format in vault under "${this.#tokensRef}"`);
    }

    // Safety margin of 5 minutes (300,000 ms) before expiration
    const isExpiringSoon = Date.now() + 300_000 >= tokens.expiresAt;

    if (!isExpiringSoon) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new Error(
        `Google access token has expired and no refresh token is available in "${this.#tokensRef}"`,
      );
    }

    const clientSecret = await this.#resolveSecret(this.#clientSecretRef);
    if (!clientSecret) {
      throw new Error(`Google client secret "${this.#clientSecretRef}" not found in vault`);
    }

    const refreshed = await refreshAccessToken({
      refreshToken: tokens.refreshToken,
      clientId: this.#clientId,
      clientSecret,
      fetchFn: this.#fetchFn,
    });

    if (this.#writeSecret) {
      await this.#writeSecret(this.#tokensRef, JSON.stringify(refreshed));
    }

    return refreshed.accessToken;
  }
}
