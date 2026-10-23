import { describe, expect, it, vi } from "vitest";
import {
  buildMcpAuthorizationUrl,
  exchangeMcpAuthorizationCode,
  generateMcpPkcePair,
  SingleUseOAuthStateStore,
  storeMcpTokensInVault,
} from "../src/oauth.js";
import { McpSecurityError } from "../src/errors.js";

describe("MCP OAuth with PKCE and Single-use State", () => {
  it("generates valid RFC 7636 PKCE pair with S256 challenge", () => {
    const pkce = generateMcpPkcePair();
    expect(pkce.codeVerifier).toMatch(/^[a-zA-Z0-9_-]{40,}$/);
    expect(pkce.codeChallenge).toMatch(/^[a-zA-Z0-9_-]{40,}$/);
    expect(pkce.codeVerifier).not.toBe(pkce.codeChallenge);
  });

  it("builds authorization URL with PKCE parameters and single-use state", () => {
    const store = new SingleUseOAuthStateStore();
    const result = buildMcpAuthorizationUrl({
      authorizationEndpoint: "https://auth.example.com/oauth/authorize",
      clientId: "nexus-client-123",
      redirectUri: "http://localhost:3000/oauth/callback",
      serverName: "google-drive",
      scopes: ["files.read", "files.write"],
      stateStore: store,
    });

    const parsed = new URL(result.url);
    expect(parsed.origin).toBe("https://auth.example.com");
    expect(parsed.searchParams.get("client_id")).toBe("nexus-client-123");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBeDefined();
    expect(parsed.searchParams.get("state")).toBe(result.state);
    expect(parsed.searchParams.get("scope")).toBe("files.read files.write");

    expect(store.pendingCount).toBe(1);
  });

  it("enforces single-use anti-replay on state consumption", () => {
    const store = new SingleUseOAuthStateStore();
    const state = store.createState({
      serverName: "test-server",
      codeVerifier: "verifier-xyz",
      redirectUri: "http://localhost/callback",
    });

    // First consumption succeeds
    const session = store.consumeState(state);
    expect(session.serverName).toBe("test-server");
    expect(session.codeVerifier).toBe("verifier-xyz");

    // Second consumption must fail immediately
    expect(() => store.consumeState(state)).toThrow(McpSecurityError);
  });

  it("rejects expired state", () => {
    let mockTime = 1_000_000;
    const store = new SingleUseOAuthStateStore({
      defaultTtlMs: 5_000,
      now: () => mockTime,
    });

    const state = store.createState({
      serverName: "test-server",
      codeVerifier: "verifier-xyz",
      redirectUri: "http://localhost/callback",
    });

    // Advance time past TTL
    mockTime += 10_000;

    expect(() => store.consumeState(state)).toThrow(McpSecurityError);
  });

  it("exchanges code for tokens using PKCE verifier and stores tokens in vault", async () => {
    const store = new SingleUseOAuthStateStore();
    const state = store.createState({
      serverName: "box-mcp",
      codeVerifier: "mock-verifier-secret-12345",
      redirectUri: "http://localhost:3000/callback",
    });

    const mockFetch = vi.fn((_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("auth-code-789");
      expect(body.get("code_verifier")).toBe("mock-verifier-secret-12345");
      expect(body.get("client_id")).toBe("test-client");

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "vault-access-token-999",
            refresh_token: "vault-refresh-token-888",
            token_type: "Bearer",
            expires_in: 3600,
          }),
      } as unknown as Response);
    });

    const tokens = await exchangeMcpAuthorizationCode({
      tokenEndpoint: "https://auth.example.com/oauth/token",
      code: "auth-code-789",
      state,
      clientId: "test-client",
      stateStore: store,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(tokens.accessToken).toBe("vault-access-token-999");
    expect(tokens.refreshToken).toBe("vault-refresh-token-888");

    // Persist into vault
    const vaultRecords: Record<string, string> = {};
    const vaultWriter = (ref: string, val: string): Promise<void> => {
      vaultRecords[ref] = val;
      return Promise.resolve();
    };

    const refs = await storeMcpTokensInVault(vaultWriter, "box-mcp", tokens);
    expect(refs.accessTokenRef).toBe("vault:mcp:box-mcp:access_token");
    expect(refs.refreshTokenRef).toBe("vault:mcp:box-mcp:refresh_token");
    expect(vaultRecords["vault:mcp:box-mcp:access_token"]).toBe("vault-access-token-999");
    expect(vaultRecords["vault:mcp:box-mcp:refresh_token"]).toBe("vault-refresh-token-888");
  });
});
