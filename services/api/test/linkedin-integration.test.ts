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
});
