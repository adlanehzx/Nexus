import { describe, expect, it, vi } from "vitest";
import { McpOAuthService } from "../src/services/mcp-oauth.js";
import type { McpManager } from "@nexus/mcp";
import { SingleUseOAuthStateStore } from "@nexus/mcp";
import type { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";

describe("McpOAuthService", () => {
  it("lists all turnkey OAuth MCP providers with connection status", async () => {
    const mockVault = {
      list: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn((ref: string) => {
        if (ref === "vault://nexus/mcp-github-token") return Promise.resolve("gho_mock_token_123");
        return Promise.resolve(undefined);
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const mockRuntime = {
      loadMcp: vi.fn().mockResolvedValue([{ name: "github" }]),
      saveMcp: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuntimeConfigurationStore;

    const service = new McpOAuthService({
      vault: mockVault,
      runtimeConfiguration: mockRuntime,
    });

    const providers = await service.listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(4);

    const github = providers.find((p) => p.id === "github");
    expect(github).toBeDefined();
    expect(github?.connected).toBe(true);
    expect(github?.activeInRuntime).toBe(true);

    const slack = providers.find((p) => p.id === "slack");
    expect(slack).toBeDefined();
    expect(slack?.connected).toBe(false);
  });

  it("initiates authorization with PKCE and state", async () => {
    const stateStore = new SingleUseOAuthStateStore();
    const service = new McpOAuthService({
      stateStore,
    });

    const result = await service.startAuthorization("github", {
      clientId: "test-client-id",
      redirectUri: "http://localhost:8080/callback",
    });

    expect(result.providerId).toBe("github");
    expect(result.state).toBeDefined();
    expect(result.authorizationUrl).toContain("https://github.com/login/oauth/authorize");
    expect(result.authorizationUrl).toContain("client_id=test-client-id");
    expect(result.authorizationUrl).toContain("code_challenge=");
  });

  it("disconnects and clears vault secrets and runtime config", async () => {
    const deleteVaultFn = vi.fn().mockResolvedValue(undefined);
    const mockVault = {
      list: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(undefined),
      delete: deleteVaultFn,
    };

    const saveMcpFn = vi.fn().mockResolvedValue(undefined);
    const mockRuntime = {
      loadMcp: vi.fn().mockResolvedValue([{ name: "github" }, { name: "other" }]),
      saveMcp: saveMcpFn,
    } as unknown as RuntimeConfigurationStore;

    const removeServerFn = vi.fn().mockResolvedValue(true);
    const mockMcpManager = {
      removeServer: removeServerFn,
    } as unknown as McpManager;

    const service = new McpOAuthService({
      vault: mockVault,
      runtimeConfiguration: mockRuntime,
      mcpManager: mockMcpManager,
    });

    const res = await service.disconnect("github");
    expect(res.success).toBe(true);
    expect(deleteVaultFn).toHaveBeenCalledWith("mcp-github-token");
    expect(saveMcpFn).toHaveBeenCalledWith([{ name: "other" }]);
    expect(removeServerFn).toHaveBeenCalledWith("github");
  });
});
