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
 * Génère une paire de clés PKCE (RFC 7636) conforme aux recommandations OAuth 2.0 pour clients publics/locaux.
 */
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9_-]/g, "");

  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  return { codeVerifier, codeChallenge };
}

/**
 * Construit l'URL d'autorisation Google officielle avec PKCE et consentement hors-ligne (refresh token).
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
 * Échange un code d'autorisation contre des jetons d'accès et de rafraîchissement.
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
    throw new Error(`Échec de l'échange OAuth Google (${response.status}): ${errorBody}`);
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
 * Renouvelle le jeton d'accès à l'aide du jeton de rafraîchissement.
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
    throw new Error(`Échec du rafraîchissement du jeton Google (${response.status}): ${errorBody}`);
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
 * Gestionnaire sécurisé des jetons Google Workspace via le coffre NEXUS (`vault://`).
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
   * Obtient un jeton d'accès valide, en le rafraîchissant automatiquement si nécessaire.
   */
  async getValidAccessToken(): Promise<string> {
    const rawTokens = await this.#resolveSecret(this.#tokensRef);
    if (!rawTokens) {
      throw new Error(
        `Aucun jeton Google trouvé dans le coffre sous la référence « ${this.#tokensRef} »`,
      );
    }

    let tokens: GoogleOAuthTokens;
    try {
      tokens = googleOAuthTokensSchema.parse(JSON.parse(rawTokens));
    } catch {
      throw new Error(
        `Format de jetons Google invalide dans le coffre sous « ${this.#tokensRef} »`,
      );
    }

    // Marge de sécurité de 5 minutes (300 000 ms) avant expiration
    const isExpiringSoon = Date.now() + 300_000 >= tokens.expiresAt;

    if (!isExpiringSoon) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new Error(
        `Le jeton d'accès Google est expiré et aucun refresh token n'est disponible dans « ${this.#tokensRef} »`,
      );
    }

    const clientSecret = await this.#resolveSecret(this.#clientSecretRef);
    if (!clientSecret) {
      throw new Error(
        `Le secret client Google « ${this.#clientSecretRef} » est introuvable dans le coffre`,
      );
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
