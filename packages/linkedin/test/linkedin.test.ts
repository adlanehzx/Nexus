import { describe, expect, it, vi } from "vitest";
import {
  LinkedInClient,
  LinkedInOAuthStateStore,
  buildLinkedInAuthorizationUrl,
  createLinkedInTools,
  exchangeLinkedInAuthorizationCode,
} from "../src/index.js";

describe("official LinkedIn integration", () => {
  it("builds a minimal official OAuth authorization request", () => {
    const url = new URL(
      buildLinkedInAuthorizationUrl({
        clientId: "client-id",
        redirectUri: "https://nexus.example/api/v1/linkedin/oauth/callback",
        state: "opaque-state",
      }),
    );
    expect(url.origin).toBe("https://www.linkedin.com");
    expect(url.searchParams.get("scope")).toBe("openid profile email w_member_social");
    expect(url.searchParams.get("state")).toBe("opaque-state");
  });

  it("consumes OAuth state exactly once and rejects expired state", () => {
    const store = new LinkedInOAuthStateStore(100);
    const state = store.create("https://nexus.example/callback", 1_000);
    expect(store.consume(state, 1_050)?.redirectUri).toContain("callback");
    expect(store.consume(state, 1_050)).toBeUndefined();
    const expired = store.create("https://nexus.example/callback", 2_000);
    expect(store.consume(expired, 2_101)).toBeUndefined();
  });

  it("exchanges the authorization code without leaking error bodies", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "secret-token", expires_in: 3600, scope: "openid" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const result = await exchangeLinkedInAuthorizationCode({
      code: "code",
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://nexus.example/callback",
      fetchFn,
    });
    expect(result.accessToken).toBe("secret-token");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("uses official REST headers and returns the created post id", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:123" } }),
      );
    const client = new LinkedInClient({ accessToken: "token", fetchFn });
    await expect(
      client.createTextPost({ authorUrn: "urn:li:person:abc", text: "Hello NEXUS" }),
    ).resolves.toEqual({ id: "urn:li:share:123", created: true });
    const [, init] = fetchFn.mock.calls[0]!;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
    expect(new Headers(init?.headers).get("LinkedIn-Version")).toBe("202610");
  });

  it("requires confirmation for every social mutation", () => {
    const client = new LinkedInClient({ accessToken: "token" });
    const tools = createLinkedInTools({ client });
    expect(tools.map((tool) => tool.name)).toEqual([
      "linkedin.profile.read",
      "linkedin.post.publish",
      "linkedin.comment.publish",
    ]);
    expect(tools.find((tool) => tool.name === "linkedin.profile.read")?.requiresConfirmation).toBe(
      false,
    );
    expect(tools.find((tool) => tool.name === "linkedin.post.publish")?.requiresConfirmation).toBe(
      true,
    );
    expect(
      tools.find((tool) => tool.name === "linkedin.comment.publish")?.requiresConfirmation,
    ).toBe(true);
  });

  it("does not pretend messaging or invitations are generally available", () => {
    const names = createLinkedInTools({ client: new LinkedInClient({ accessToken: "token" }) }).map(
      (tool) => tool.name,
    );
    expect(names.some((name) => name.includes("message"))).toBe(false);
    expect(names.some((name) => name.includes("invitation"))).toBe(false);
  });
});
