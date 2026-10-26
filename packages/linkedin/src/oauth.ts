import { randomBytes } from "node:crypto";
import { LINKEDIN_SCOPES, linkedInTokensSchema, type LinkedInTokens } from "./types.js";

interface PendingAuthorization {
  expiresAt: number;
  redirectUri: string;
}

/** Short-lived, single-use OAuth state storage. Secrets and authorization codes are never stored. */
export class LinkedInOAuthStateStore {
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #ttlMs: number;

  constructor(ttlMs = 10 * 60_000) {
    this.#ttlMs = ttlMs;
  }

  create(redirectUri: string, now = Date.now()): string {
    this.#prune(now);
    const state = randomBytes(32).toString("base64url");
    this.#pending.set(state, { redirectUri, expiresAt: now + this.#ttlMs });
    return state;
  }

  consume(state: string, now = Date.now()): PendingAuthorization | undefined {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (pending === undefined || pending.expiresAt < now) return undefined;
    return pending;
  }

  #prune(now: number): void {
    for (const [state, pending] of this.#pending) {
      if (pending.expiresAt < now) this.#pending.delete(state);
    }
  }
}

export function buildLinkedInAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));
  return url.toString();
}

export async function exchangeLinkedInAuthorizationCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): Promise<LinkedInTokens> {
  const response = await (input.fetchFn ?? fetch)("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`LinkedIn OAuth exchange failed (${response.status})`);
  const value = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  return linkedInTokensSchema.parse({
    accessToken: value.access_token,
    expiresAt: Date.now() + (value.expires_in ?? 0) * 1000,
    ...(value.scope === undefined ? {} : { scope: value.scope }),
  });
}
