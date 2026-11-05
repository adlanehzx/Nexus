import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

/** Real HTTP and the official MCP client: this is what an external agent runs. */
describe("MCP endpoint", () => {
  let harness: ApiHarness;
  let owner: Account;
  let other: Account;
  let endpoint: URL;

  beforeAll(async () => {
    harness = await makeApi();
    owner = await createAccount(harness, "mcp-owner@example.test");
    other = await createAccount(harness, "mcp-other@example.test");
    const address = await harness.app.listen({ host: "127.0.0.1", port: 0 });
    endpoint = new URL(`${address}/api/v1/mcp`);
  });

  afterAll(async () => {
    await harness.close();
  });

  const issue = async (account: Account, scopes: string[]) => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mcp/tokens",
      headers: account.authorization,
      payload: { name: "test client", scopes, expiresInDays: 1 },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ data: { token: string; record: { id: string } } }>().data;
  };

  const connect = async (token: string) => {
    const client = new Client({ name: "vitest", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as Transport,
    );
    return client;
  };

  it("lists only the tools a token's scopes allow, and runs them on real services", async () => {
    const { token } = await issue(owner, ["metrics:read", "devices:read"]);
    const client = await connect(token);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "nexus_get_usage_metrics",
      "nexus_list_devices",
    ]);

    const devices = await client.callTool({ name: "nexus_list_devices", arguments: {} });
    expect(devices.isError).toBeUndefined();
    expect(devices.content).toEqual([{ type: "text", text: "[]" }]);

    const usage = await client.callTool({
      name: "nexus_get_usage_metrics",
      arguments: { days: 7 },
    });
    expect(usage.isError).toBeUndefined();
    await client.close();
  });

  it("refuses a tool outside the token's scopes and records the denial", async () => {
    const { token } = await issue(owner, ["metrics:read"]);
    const client = await connect(token);

    const denied = await client.callTool({
      name: "nexus_trigger_mission",
      arguments: { goal: "x" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("INSUFFICIENT_SCOPE");
    await client.close();

    const activity = await harness.app.inject({
      method: "GET",
      url: "/api/v1/mcp/activity",
      headers: owner.authorization,
    });
    const entries = activity.json<{ data: { activity: { tool: string; outcome: string }[] } }>();
    expect(entries.data.activity).toContainEqual(
      expect.objectContaining({ tool: "nexus_trigger_mission", outcome: "denied" }),
    );
  });

  it("reports an unavailable engine instead of inventing a mission", async () => {
    const { token } = await issue(owner, ["missions:read"]);
    const client = await connect(token);
    const result = await client.callTool({ name: "nexus_list_missions", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("NEXUS_SERVICE_UNAVAILABLE");
    await client.close();
  });

  it("stops accepting a token as soon as it is revoked", async () => {
    const { token, record } = await issue(owner, ["metrics:read"]);
    const client = await connect(token);
    await client.close();

    const revoked = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/mcp/tokens/${record.id}`,
      headers: owner.authorization,
    });
    expect(revoked.statusCode).toBe(200);
    await expect(connect(token)).rejects.toThrow();
  });

  it("keeps tokens and activity private to their owner", async () => {
    const { record } = await issue(owner, ["metrics:read"]);

    const listed = await harness.app.inject({
      method: "GET",
      url: "/api/v1/mcp/tokens",
      headers: other.authorization,
    });
    expect(listed.json<{ data: { tokens: unknown[] } }>().data.tokens).toEqual([]);

    const foreign = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/mcp/tokens/${record.id}`,
      headers: other.authorization,
    });
    expect(foreign.statusCode).toBe(404);

    const activity = await harness.app.inject({
      method: "GET",
      url: "/api/v1/mcp/activity",
      headers: other.authorization,
    });
    expect(activity.json<{ data: { activity: unknown[] } }>().data.activity).toEqual([]);
  });

  it("rejects missing tokens and never returns the stored hash", async () => {
    const anonymous = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(anonymous.statusCode).toBe(401);

    const listed = await harness.app.inject({
      method: "GET",
      url: "/api/v1/mcp/tokens",
      headers: owner.authorization,
    });
    expect(listed.body).not.toContain("tokenHash");
  });
});
