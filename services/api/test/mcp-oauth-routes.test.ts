import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

describe("MCP OAuth Endpoints", () => {
  let harness: ApiHarness;
  let user: Account;

  beforeAll(async () => {
    harness = await makeApi();
    user = await createAccount(harness, "oauth-user@example.test");
  });

  afterAll(async () => {
    await harness.close();
  });

  it("lists turnkey OAuth MCP providers with connection status", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/mcp/oauth/providers",
      headers: user.authorization,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { providers: { id: string; name: string; connected: boolean }[] } }>();
    expect(body.data.providers.length).toBeGreaterThanOrEqual(4);

    const github = body.data.providers.find((p) => p.id === "github");
    expect(github).toBeDefined();
    expect(github?.name).toBe("GitHub");
  });

  it("initiates OAuth authorization for GitHub", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mcp/oauth/authorize",
      headers: user.authorization,
      payload: {
        providerId: "github",
        clientId: "test-github-client-id",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { authorizationUrl: string; state: string; providerId: string } }>();
    expect(body.data.providerId).toBe("github");
    expect(body.data.authorizationUrl).toContain("https://github.com/login/oauth/authorize");
    expect(body.data.authorizationUrl).toContain("test-github-client-id");
  });

  it("disconnects a provider", async () => {
    const response = await harness.app.inject({
      method: "DELETE",
      url: "/api/v1/mcp/oauth/github",
      headers: user.authorization,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { success: boolean; providerId: string } }>();
    expect(body.data.success).toBe(true);
    expect(body.data.providerId).toBe("github");
  });
});
