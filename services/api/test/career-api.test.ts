import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

function sampleProfile() {
  return {
    headline: "Senior Distributed Systems Engineer",
    summary:
      "10+ years specializing in consensus protocols, formal verification, fault-tolerant distributed storage and Rust platform architecture.",
    yearsExperience: 8,
    highestDegree: "master",
    skills: ["Rust", "Distributed Systems", "Raft", "Formal Verification"],
    languages: [{ code: "en", level: "native" }],
    publications: 1,
    preferences: {
      kinds: ["permanent_job", "phd"],
      locations: ["Paris, France"],
      remote: "preferred",
      languages: [{ code: "en", level: "professional" }],
      mustHaveSkills: ["Rust", "Distributed Systems"],
      niceToHaveSkills: ["Raft"],
      researchAreas: ["Consensus Protocols"],
      minCompensation: {
        currency: "EUR",
        period: "year",
        minAmount: 85_000,
        maxAmount: null,
      },
      excludedOrganizations: ["ExcludedCorp"],
      noticePeriodDays: 30,
    },
  };
}

function sampleOpportunity(overrides: Record<string, unknown> = {}) {
  return {
    kind: "permanent_job",
    title: "Senior Storage Engineer",
    organization: "Nexus Labs",
    location: "Paris, France",
    remote: true,
    description: "Building next-generation distributed transaction engines.",
    requirements: ["Rust", "Distributed Systems"],
    compensation: {
      currency: "EUR",
      period: "year",
      minAmount: 105_000,
      maxAmount: 130_000,
    },
    postedAt: "2026-10-01T00:00:00.000Z",
    closesAt: "2026-12-31T23:59:59.000Z",
    externalRef: "opp-storage-001",
    source: {
      kind: "official_site",
      url: "https://nexus.example.org/careers/storage-eng",
      evidence: "Company Careers Portal",
    },
    ...overrides,
  };
}

describe("Career & Education API Routes", () => {
  let harness: ApiHarness;
  let userA: Account;
  let userB: Account;

  beforeEach(async () => {
    harness = await makeApi();
    userA = await createAccount(harness, "userA@example.test");
    userB = await createAccount(harness, "userB@example.test");
  });

  afterEach(async () => {
    await harness.close();
  });

  describe("authentication guards", () => {
    it("rejects unauthenticated requests", async () => {
      const endpoints = [
        { method: "GET", url: "/api/v1/career/profile" },
        { method: "GET", url: "/api/v1/career/opportunities" },
        { method: "GET", url: "/api/v1/career/applications" },
      ] as const;

      for (const ep of endpoints) {
        const response = await harness.app.inject({
          method: ep.method,
          url: ep.url,
        });
        expect(response.statusCode).toBe(401);
      }
    });
  });

  describe("profile & settings routes", () => {
    it("creates and retrieves profile with completeness", async () => {
      const putRes = await harness.app.inject({
        method: "PUT",
        url: "/api/v1/career/profile",
        headers: userA.authorization,
        payload: sampleProfile(),
      });

      expect(putRes.statusCode).toBe(200);
      const putBody = putRes.json<{
        data: { profile: { headline: string }; completeness: { score: number } };
      }>();
      expect(putBody.data.profile.headline).toBe("Senior Distributed Systems Engineer");
      expect(putBody.data.completeness.score).toBeGreaterThan(0);

      const getRes = await harness.app.inject({
        method: "GET",
        url: "/api/v1/career/profile",
        headers: userA.authorization,
      });

      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json<{
        data: { profile: { headline: string } };
      }>();
      expect(getBody.data.profile.headline).toBe("Senior Distributed Systems Engineer");
    });

    it("serves dashboard-compatible settings", async () => {
      await harness.app.inject({
        method: "PUT",
        url: "/api/v1/career/profile",
        headers: userA.authorization,
        payload: sampleProfile(),
      });

      const res = await harness.app.inject({
        method: "GET",
        url: "/api/v1/career/settings",
        headers: userA.authorization,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: { preferredLocations: string[]; targetTracks: string[] };
      }>();
      expect(body.data.preferredLocations).toContain("Paris, France");
      expect(body.data.targetTracks).toContain("permanent_job");
    });

    it("does not invent career goals for a new user", async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/v1/career/settings",
        headers: userA.authorization,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: {
          disciplinesAndKeywords: string[];
          seniorityLevels: string[];
          targetTracks: string[];
          phdTopics: string[];
          phdFundingTypes: string[];
        };
      }>();
      expect(body.data).toMatchObject({
        disciplinesAndKeywords: [],
        seniorityLevels: [],
        targetTracks: [],
        phdTopics: [],
        phdFundingTypes: [],
      });
    });

    it("accepts profession-agnostic preferences", async () => {
      const profile = sampleProfile();
      profile.headline = "Registered Nurse seeking a community health role";
      profile.summary =
        "Experienced in patient education, preventive care, and multidisciplinary coordination.";
      profile.skills = ["Patient education", "Preventive care", "Care coordination"];
      profile.preferences.kinds = ["permanent_job"];
      profile.preferences.mustHaveSkills = ["Patient education"];
      profile.preferences.niceToHaveSkills = ["Community health"];
      profile.preferences.researchAreas = [];

      const putRes = await harness.app.inject({
        method: "PUT",
        url: "/api/v1/career/profile",
        headers: userA.authorization,
        payload: profile,
      });
      expect(putRes.statusCode).toBe(200);

      const settingsRes = await harness.app.inject({
        method: "GET",
        url: "/api/v1/career/settings",
        headers: userA.authorization,
      });
      const settings = settingsRes.json<{
        data: { disciplinesAndKeywords: string[]; targetTracks: string[] };
      }>().data;
      expect(settings.disciplinesAndKeywords).toEqual(["Patient education"]);
      expect(settings.targetTracks).toEqual(["permanent_job"]);
      expect(JSON.stringify(settings).toLowerCase()).not.toContain("developer");
    });
  });

  describe("cross-user isolation", () => {
    it("prevents User B from accessing User A's opportunities, applications and documents", async () => {
      await harness.app.inject({
        method: "PUT",
        url: "/api/v1/career/profile",
        headers: userA.authorization,
        payload: sampleProfile(),
      });

      // User A ingests opportunity
      const ingestRes = await harness.app.inject({
        method: "POST",
        url: "/api/v1/career/ingest",
        headers: userA.authorization,
        payload: { items: [sampleOpportunity()] },
      });
      const oppId = ingestRes.json<{
        data: { outcomes: { opportunityId: string }[] };
      }>().data.outcomes[0]!.opportunityId;

      // User A shortlists and starts drafting
      const appRes = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/opportunities/${oppId}/shortlist`,
        headers: userA.authorization,
      });
      const appId = appRes.json<{ data: { id: string } }>().data.id;

      await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/drafting`,
        headers: userA.authorization,
      });

      const docRes = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/documents`,
        headers: userA.authorization,
        payload: {
          kind: "cover_letter",
          body: "Tailored letter for Nexus Labs.",
          parentVariantId: null,
        },
      });
      const docId = docRes.json<{ data: { id: string } }>().data.id;

      // User B attempts to access User A's opportunity -> 404
      const oppB = await harness.app.inject({
        method: "GET",
        url: `/api/v1/career/opportunities/${oppId}`,
        headers: userB.authorization,
      });
      expect(oppB.statusCode).toBe(404);

      // User B attempts to access User A's application -> 404
      const appB = await harness.app.inject({
        method: "GET",
        url: `/api/v1/career/applications/${appId}`,
        headers: userB.authorization,
      });
      expect(appB.statusCode).toBe(404);

      // User B attempts to access User A's document -> 404
      const docB = await harness.app.inject({
        method: "GET",
        url: `/api/v1/career/documents/${docId}`,
        headers: userB.authorization,
      });
      expect(docB.statusCode).toBe(404);

      // User B attempts to submit User A's application -> 404
      const submitB = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/submit`,
        headers: userB.authorization,
      });
      expect(submitB.statusCode).toBe(404);
    });
  });

  describe("guarded state transitions", () => {
    it("refuses generic transition to guarded states (approved, submitted)", async () => {
      await harness.app.inject({
        method: "PUT",
        url: "/api/v1/career/profile",
        headers: userA.authorization,
        payload: sampleProfile(),
      });

      const ingestRes = await harness.app.inject({
        method: "POST",
        url: "/api/v1/career/ingest",
        headers: userA.authorization,
        payload: { items: [sampleOpportunity()] },
      });
      const oppId = ingestRes.json<{
        data: { outcomes: { opportunityId: string }[] };
      }>().data.outcomes[0]!.opportunityId;

      const appRes = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/opportunities/${oppId}/shortlist`,
        headers: userA.authorization,
      });
      const appId = appRes.json<{ data: { id: string } }>().data.id;

      // Direct transition to "approved" via advance endpoint must fail
      const advApproved = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/advance`,
        headers: userA.authorization,
        payload: { to: "approved" },
      });
      expect(advApproved.statusCode).toBe(409);

      // Direct transition to "submitted" via advance endpoint must fail
      const advSubmitted = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/advance`,
        headers: userA.authorization,
        payload: { to: "submitted" },
      });
      expect(advSubmitted.statusCode).toBe(409);
    });
  });

  describe("resolve confirmation endpoint", () => {
    it("supports resolve endpoint with approve, reject and cancel decisions", async () => {
      await harness.app.inject({
        method: "PUT",
        url: "/api/v1/career/profile",
        headers: userA.authorization,
        payload: sampleProfile(),
      });

      const ingestRes = await harness.app.inject({
        method: "POST",
        url: "/api/v1/career/ingest",
        headers: userA.authorization,
        payload: { items: [sampleOpportunity()] },
      });
      const oppId = ingestRes.json<{
        data: { outcomes: { opportunityId: string }[] };
      }>().data.outcomes[0]!.opportunityId;

      const appRes = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/opportunities/${oppId}/shortlist`,
        headers: userA.authorization,
      });
      const appId = appRes.json<{ data: { id: string } }>().data.id;

      await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/drafting`,
        headers: userA.authorization,
      });

      await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/documents`,
        headers: userA.authorization,
        payload: {
          kind: "cover_letter",
          body: "Tailored letter body.",
          parentVariantId: null,
        },
      });

      // Request approval
      const reqRes = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/applications/${appId}/approval-request`,
        headers: userA.authorization,
      });
      const confId = reqRes.json<{ data: { confirmation: { id: string } } }>().data.confirmation.id;

      // Resolve with "approve"
      const resolveRes = await harness.app.inject({
        method: "POST",
        url: `/api/v1/career/confirmations/${confId}/resolve`,
        headers: userA.authorization,
        payload: { decision: "approve", reason: "Ready to submit" },
      });
      expect(resolveRes.statusCode).toBe(200);
      const resolveBody = resolveRes.json<{
        data: { confirmation: { state: string }; application: { state: string } };
      }>();
      expect(resolveBody.data.confirmation.state).toBe("approved");
      expect(resolveBody.data.application.state).toBe("approved");
    });
  });
});
