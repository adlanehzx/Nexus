import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@nexus/tools";
import { LinkedInIntegrationService } from "../src/services/linkedin-integration.js";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";

describe("LinkedIn integration service", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("completes official OAuth, stores tokens in the vault and registers confirmed tools", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-linkedin-"));
    const secrets = new Map([["linkedin-client-secret", "client-secret"]]);
    const vault = {
      get: (ref: string) => Promise.resolve(secrets.get(ref.replace("vault://nexus/", ""))),
      set: (name: string, value: string) => {
        secrets.set(name, value);
        return Promise.resolve();
      },
      delete: (name: string) => {
        secrets.delete(name);
        return Promise.resolve();
      },
    };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const registry = new ToolRegistry();
    const service = new LinkedInIntegrationService({
      runtime: new RuntimeConfigurationStore(directory),
      vault,
      registry,
      fetchFn,
    });
    const redirectUri = "http://localhost:3000/api/v1/linkedin/oauth/callback";
    const { authorizationUrl } = await service.start({
      clientId: "client-id",
      clientSecretRef: "vault://nexus/linkedin-client-secret",
      tokenRef: "vault://nexus/linkedin-token",
      redirectUri,
    });
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    await expect(service.complete({ code: "authorization-code", state })).resolves.toContain(
      "linkedin=connected",
    );
    await expect(service.status()).resolves.toEqual({
      configured: true,
      connected: true,
      tools: ["linkedin.profile.read", "linkedin.post.publish", "linkedin.comment.publish"],
    });
    expect(registry.require("linkedin.post.publish").requiresConfirmation).toBe(true);
    expect(secrets.get("linkedin-token")).not.toContain("client-secret");
    await service.disconnect();
    expect(registry.has("linkedin.post.publish")).toBe(false);
  });

  it("rejects replayed OAuth state", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-linkedin-"));
    const runtime = new RuntimeConfigurationStore(directory);
    const vault = {
      get: () => Promise.resolve("client-secret"),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const service = new LinkedInIntegrationService({
      runtime,
      vault,
      registry: new ToolRegistry(),
      fetchFn,
    });
    const { authorizationUrl } = await service.start({
      clientId: "client-id",
      clientSecretRef: "vault://nexus/linkedin-client-secret",
      tokenRef: "vault://nexus/linkedin-token",
      redirectUri: "http://localhost:3000/api/v1/linkedin/oauth/callback",
    });
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    await expect(service.complete({ code: "code", state })).resolves.toContain(
      "linkedin=connected",
    );
    await expect(service.complete({ code: "code", state })).rejects.toThrow(/state/i);
  });

  it("enforces multi-user credential isolation, preventing Alice from using Bob's tokens (SEC-12)", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-linkedin-multi-"));
    const secrets = new Map<string, string>([
      ["linkedin-client-secret", "super-secret"],
      [
        "linkedin-token/alice",
        JSON.stringify({ accessToken: "token-alice-AAA", expiresAt: Date.now() + 3_600_000 }),
      ],
      [
        "linkedin-token/bob",
        JSON.stringify({ accessToken: "token-bob-BBB", expiresAt: Date.now() + 3_600_000 }),
      ],
    ]);

    const vault = {
      get: (ref: string) => Promise.resolve(secrets.get(ref.replace("vault://nexus/", ""))),
      set: (name: string, value: string) => {
        secrets.set(name, value);
        return Promise.resolve();
      },
      delete: (name: string) => {
        secrets.delete(name);
        return Promise.resolve();
      },
    };

    const outboundCalls: { token: string | null; body: string }[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const headers = new Headers(init?.headers);
      outboundCalls.push({
        token: headers.get("Authorization"),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Promise.resolve(
        new Response(null, {
          status: 201,
          headers: { "x-restli-id": "urn:li:share:123" },
        }),
      );
    });

    const registry = new ToolRegistry();
    const service = new LinkedInIntegrationService({
      runtime: new RuntimeConfigurationStore(directory),
      vault,
      registry,
      fetchFn,
    });

    // Start with configuration pointing to vault://nexus/linkedin-token
    await service.start({
      clientId: "client-id",
      clientSecretRef: "vault://nexus/linkedin-client-secret",
      tokenRef: "vault://nexus/linkedin-token",
      redirectUri: "http://localhost:3000/api/v1/linkedin/oauth/callback",
    });

    await service.initialize();

    const publishTool = registry.require("linkedin.post.publish");
    expect(publishTool.requiresConfirmation).toBe(true);

    const makeContext = (userId: string) => ({
      userId,
      runId: "run-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      signal: new AbortController().signal,
      idempotencyKey: "idem-1",
      attempt: 1,
      onProgress: vi.fn(),
    });

    // 1. Alice publishes -> MUST use Token A
    await publishTool.execute(
      {
        authorUrn: "urn:li:person:alice123",
        text: "Hello from Alice",
        visibility: "PUBLIC",
      },
      makeContext("alice"),
    );

    expect(outboundCalls).toHaveLength(1);
    expect(outboundCalls[0]?.token).toBe("Bearer token-alice-AAA");

    // 2. Bob publishes -> MUST use Token B
    await publishTool.execute(
      {
        authorUrn: "urn:li:person:bob456",
        text: "Hello from Bob",
        visibility: "PUBLIC",
      },
      makeContext("bob"),
    );

    expect(outboundCalls).toHaveLength(2);
    expect(outboundCalls[1]?.token).toBe("Bearer token-bob-BBB");

    // 3. Charlie (no token) executes -> clean error, NO leakage of Alice or Bob's tokens
    await expect(
      publishTool.execute(
        {
          authorUrn: "urn:li:person:charlie789",
          text: "Charlie attempt",
          visibility: "PUBLIC",
        },
        makeContext("charlie"),
      ),
    ).rejects.toThrow(/not connected for user 'charlie'/i);
    expect(outboundCalls).toHaveLength(2); // No new request sent

    // 4. Anonymous / unauthenticated user MUST be rejected immediately
    await expect(
      publishTool.execute(
        {
          authorUrn: "urn:li:person:anon",
          text: "Malicious post",
          visibility: "PUBLIC",
        },
        makeContext(""),
      ),
    ).rejects.toThrow(/unauthenticated user/i);

    await expect(
      publishTool.execute(
        {
          authorUrn: "urn:li:person:anon",
          text: "Malicious post",
          visibility: "PUBLIC",
        },
        makeContext("anonymous"),
      ),
    ).rejects.toThrow(/unauthenticated user/i);
    expect(outboundCalls).toHaveLength(2);

    // 5. Disconnect Alice -> Only Alice is disconnected, Bob remains active
    await service.disconnect("alice");

    await expect(
      publishTool.execute(
        {
          authorUrn: "urn:li:person:alice123",
          text: "Second post after disconnect",
          visibility: "PUBLIC",
        },
        makeContext("alice"),
      ),
    ).rejects.toThrow(/not connected for user 'alice'/i);
    expect(outboundCalls).toHaveLength(2);

    // Bob still works perfectly with Token B
    await publishTool.execute(
      {
        authorUrn: "urn:li:person:bob456",
        text: "Bob post after Alice disconnect",
        visibility: "PUBLIC",
      },
      makeContext("bob"),
    );
    expect(outboundCalls).toHaveLength(3);
    expect(outboundCalls[2]?.token).toBe("Bearer token-bob-BBB");

    // 6. OAuth state replay / cross-user completion: Bob cannot complete Alice's OAuth state
    const aliceOauth = await service.start(
      {
        clientId: "client-id",
        clientSecretRef: "vault://nexus/linkedin-client-secret",
        tokenRef: "vault://nexus/linkedin-token",
        redirectUri: "http://localhost:3000/api/v1/linkedin/oauth/callback",
      },
      "alice",
    );
    const aliceState = new URL(aliceOauth.authorizationUrl).searchParams.get("state")!;

    await expect(
      service.complete({ code: "code-for-alice", state: aliceState }, "bob"),
    ).rejects.toThrow(/mismatch/i);

    // 7. Altered redirect_uri during exchange: MUST reject
    const testOauth = await service.start(
      {
        clientId: "client-id",
        clientSecretRef: "vault://nexus/linkedin-client-secret",
        tokenRef: "vault://nexus/linkedin-token",
        redirectUri: "http://localhost:3000/api/v1/linkedin/oauth/callback",
      },
      "alice",
    );
    const testState = new URL(testOauth.authorizationUrl).searchParams.get("state")!;
    // Alter config redirectUri behind the back of the pending state
    await service.start(
      {
        clientId: "client-id",
        clientSecretRef: "vault://nexus/linkedin-client-secret",
        tokenRef: "vault://nexus/linkedin-token",
        redirectUri: "https://attacker.example.com/oauth/callback",
      },
      "alice",
    );
    await expect(
      service.complete({ code: "code-test", state: testState }, "alice"),
    ).rejects.toThrow(/configuration changed/i);

    // 8. Concurrent executions of Alice (reconnected) and Bob: Zero token cross-talk
    secrets.set(
      "linkedin-token/alice",
      JSON.stringify({ accessToken: "token-alice-RECONNECTED", expiresAt: Date.now() + 3_600_000 }),
    );

    const concurrentResults = await Promise.all([
      publishTool.execute(
        { authorUrn: "urn:li:person:alice123", text: "Alice Concurrent 1", visibility: "PUBLIC" },
        makeContext("alice"),
      ),
      publishTool.execute(
        { authorUrn: "urn:li:person:bob456", text: "Bob Concurrent 1", visibility: "PUBLIC" },
        makeContext("bob"),
      ),
      publishTool.execute(
        { authorUrn: "urn:li:person:alice123", text: "Alice Concurrent 2", visibility: "PUBLIC" },
        makeContext("alice"),
      ),
      publishTool.execute(
        { authorUrn: "urn:li:person:bob456", text: "Bob Concurrent 2", visibility: "PUBLIC" },
        makeContext("bob"),
      ),
    ]);
    expect(concurrentResults).toHaveLength(4);

    // Verify all 4 calls strictly matched the respective user tokens
    const recentCalls = outboundCalls.slice(-4);
    expect(recentCalls[0]?.token).toBe("Bearer token-alice-RECONNECTED");
    expect(recentCalls[1]?.token).toBe("Bearer token-bob-BBB");
    expect(recentCalls[2]?.token).toBe("Bearer token-alice-RECONNECTED");
    expect(recentCalls[3]?.token).toBe("Bearer token-bob-BBB");
  });
});
