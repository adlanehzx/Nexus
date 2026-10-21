import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generatePkcePair,
  GoogleTokenManager,
  refreshAccessToken,
} from "../src/oauth.js";
import { GOOGLE_WORKSPACE_SCOPES } from "../src/types.js";

describe("OAuth 2.0 PKCE pour Google Workspace", () => {
  it("génère un couple PKCE conforme et non prédictible", () => {
    const pair1 = generatePkcePair();
    const pair2 = generatePkcePair();

    expect(pair1.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair1.codeChallenge.length).toBeGreaterThanOrEqual(43);
    expect(pair1.codeVerifier).not.toBe(pair2.codeVerifier);
    expect(pair1.codeChallenge).not.toBe(pair2.codeChallenge);
  });

  it("génère l'URL d'autorisation officielle Google avec les scopes stricts", () => {
    const pkce = generatePkcePair();
    const authUrl = buildAuthorizationUrl({
      clientId: "test-client-id.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:4000/callback",
      codeChallenge: pkce.codeChallenge,
      state: "nexus-secure-state-xyz",
    });

    const parsed = new URL(authUrl);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(parsed.searchParams.get("code_challenge")).toBe(pkce.codeChallenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");

    const scopes = parsed.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toContain(GOOGLE_WORKSPACE_SCOPES.GMAIL_READONLY);
    expect(scopes).toContain(GOOGLE_WORKSPACE_SCOPES.GMAIL_SEND);
    expect(scopes).toContain(GOOGLE_WORKSPACE_SCOPES.CALENDAR_EVENTS);
    // Aucun scope excessif complet
    expect(scopes).not.toContain("https://mail.google.com/");
  });

  it("échange le code d'autorisation contre des jetons", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "ya29.mock-access-token",
          refresh_token: "1//mock-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        }),
    });

    const tokens = await exchangeAuthorizationCode({
      code: "auth-code-123",
      codeVerifier: "pkce-verifier-abc",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1:4000/callback",
      fetchFn: mockFetch,
    });

    expect(tokens.accessToken).toBe("ya29.mock-access-token");
    expect(tokens.refreshToken).toBe("1//mock-refresh-token");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);
  });

  it("renouvelle un jeton d'accès via le refresh token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "ya29.new-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });

    const refreshed = await refreshAccessToken({
      refreshToken: "1//existing-refresh-token",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetchFn: mockFetch,
    });

    expect(refreshed.accessToken).toBe("ya29.new-access-token");
    expect(refreshed.refreshToken).toBe("1//existing-refresh-token");
  });

  it("gère l'expiration et le rafraîchissement transparent via le coffre NEXUS", async () => {
    const storedTokens = JSON.stringify({
      accessToken: "ya29.expiring-token",
      refreshToken: "1//valid-refresh",
      // Expiré ou expirant dans moins de 5 min
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
    });

    const mockVault = new Map<string, string>();
    mockVault.set("vault://nexus/google-tokens", storedTokens);
    mockVault.set("vault://nexus/google-secret", "super-secret-client-key");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "ya29.refreshed-from-vault",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });

    const manager = new GoogleTokenManager({
      clientId: "google-client-id",
      clientSecretRef: "vault://nexus/google-secret",
      tokensRef: "vault://nexus/google-tokens",
      resolveSecret: (ref) => Promise.resolve(mockVault.get(ref)),
      writeSecret: (ref, val) => {
        mockVault.set(ref, val);
        return Promise.resolve();
      },
      fetchFn: mockFetch,
    });

    const token = await manager.getValidAccessToken();
    expect(token).toBe("ya29.refreshed-from-vault");

    // Vérifie que le coffre a été mis à jour avec le nouveau token
    const updated = JSON.parse(mockVault.get("vault://nexus/google-tokens")!);
    expect(updated.accessToken).toBe("ya29.refreshed-from-vault");
  });
});
