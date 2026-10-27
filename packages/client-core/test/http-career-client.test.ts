import { describe, expect, it } from "vitest";
import { HttpCareerEducationClient } from "../src/career-education/http-client.js";
import { SessionManager } from "../src/session.js";
import { FakeHttpClient, FakeSecureStorage, loginResponse } from "./fixtures.js";

function makeAuthenticatedSession() {
  const http = new FakeHttpClient();
  const storage = new FakeSecureStorage();
  const session = new SessionManager({ http, storage });
  http.on("POST", "/api/v1/auth/login", loginResponse());
  return { http, session };
}

describe("HttpCareerEducationClient Integration", () => {
  it("initializes and serves profile gracefully", async () => {
    const { session } = makeAuthenticatedSession();
    const client = new HttpCareerEducationClient(session, { seedDemoData: false });

    const profile = await client.getProfile();
    expect(profile).toBeDefined();
    expect(profile.completeness).toBeDefined();
  });

  it("syncs profile update to backend when authenticated", async () => {
    const { http, session } = makeAuthenticatedSession();
    await session.login("alex@example.test", "sufficient password");

    http.on("PUT", "/api/v1/career/profile", {
      status: 200,
      body: { data: { profile: { headline: "Updated Headline" }, completeness: { score: 90 } } },
    });

    const client = new HttpCareerEducationClient(session, { seedDemoData: false });
    const updated = await client.updateProfile({
      headline: "Updated Headline",
      skills: ["Rust", "Distributed Systems", "Raft"],
    });

    expect(updated.headline).toBe("Updated Headline");
    expect(
      http.requests.some((r) => r.path === "/api/v1/career/profile" && r.method === "PUT"),
    ).toBe(true);
  });

  it("queries opportunities from backend when authenticated", async () => {
    const { http, session } = makeAuthenticatedSession();
    await session.login("alex@example.test", "sufficient password");

    http.on("GET", "/api/v1/career/opportunities?kind=phd&limit=50", {
      status: 200,
      body: { data: { opportunities: [] } },
    });

    const client = new HttpCareerEducationClient(session, { seedDemoData: false });
    const res = await client.searchOpportunities({ track: "phd" });
    expect(res).toBeDefined();
    expect(res.items).toBeDefined();
    expect(http.requests.some((r) => r.path.includes("/api/v1/career/opportunities"))).toBe(true);
  });

  it("syncs stage update to backend endpoint", async () => {
    const { http, session } = makeAuthenticatedSession();
    await session.login("alex@example.test", "sufficient password");

    const client = new HttpCareerEducationClient(session, { seedDemoData: true });
    const opps = await client.searchOpportunities({ track: "all" });
    expect(opps.items.length).toBeGreaterThan(0);
    const oppId = opps.items[0]!.id;

    const created = await client.createApplication(oppId);

    http.on("PUT", `/api/v1/career/applications/${encodeURIComponent(created.id)}/stage`, {
      status: 200,
      body: { data: { id: created.id, stage: "preparing" } },
    });

    const updated = await client.updateApplicationStage(
      created.id,
      "preparing",
      "Drafting statement",
    );
    expect(updated.stage).toBe("preparing");
    expect(http.requests.some((r) => r.path.includes("/stage") && r.method === "PUT")).toBe(true);
  });

  it("resolves confirmation request to backend endpoint", async () => {
    const { http, session } = makeAuthenticatedSession();
    await session.login("alex@example.test", "sufficient password");

    const client = new HttpCareerEducationClient(session, { seedDemoData: true });
    const opps = await client.searchOpportunities({ track: "all" });
    const oppId = opps.items[0]!.id;

    const draft = await client.prepareDraftApplication(oppId, { applicant: "Alex" });

    http.on("POST", `/api/v1/career/confirmations/${encodeURIComponent(draft.id)}/resolve`, {
      status: 200,
      body: { data: { id: draft.id, status: "approved" } },
    });

    const resolved = await client.resolveConfirmation(draft.id, "approve", "Approved by user");
    expect(resolved.status).toBe("approved");
    expect(http.requests.some((r) => r.path.includes("/resolve") && r.method === "POST")).toBe(
      true,
    );
  });
});
