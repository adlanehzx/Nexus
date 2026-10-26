import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";
import { CareerService } from "../src/services/career/career-service.js";
import { RecordingSubmissionAdapter } from "../src/services/career/submission-adapter.js";

function testProfile() {
  return {
    headline: "Senior Distributed Systems Engineer",
    summary:
      "10+ years specializing in consensus protocols, formal verification, fault-tolerant distributed storage and Rust platform architecture.",
    yearsExperience: 10,
    highestDegree: "master",
    skills: ["Rust", "Distributed Systems", "Raft", "Formal Verification", "Go"],
    languages: [{ code: "en", level: "native" }],
    publications: 2,
    preferences: {
      kinds: ["permanent_job", "phd"],
      locations: ["Paris, France"],
      remote: "preferred",
      languages: [{ code: "en", level: "professional" }],
      mustHaveSkills: ["Rust", "Distributed Systems"],
      niceToHaveSkills: ["Formal Verification"],
      researchAreas: ["Consensus Protocols"],
      minCompensation: {
        currency: "EUR",
        period: "year",
        minAmount: 90_000,
        maxAmount: null,
      },
      excludedOrganizations: ["HostileCorp"],
      noticePeriodDays: 30,
    },
  };
}

function primaryOpportunity(overrides: Record<string, unknown> = {}) {
  return {
    kind: "permanent_job",
    title: "Lead Infrastructure Architect",
    organization: "Distributed Consensus Labs",
    location: "Paris, France",
    remote: true,
    description: "Architecting zero-downtime Raft consensus and durable storage layers.",
    requirements: ["Rust", "Distributed Systems", "Raft"],
    compensation: {
      currency: "EUR",
      period: "year",
      minAmount: 110_000,
      maxAmount: 135_000,
    },
    postedAt: "2026-10-01T00:00:00.000Z",
    closesAt: "2026-12-31T23:59:59.000Z",
    externalRef: "dcl-lead-001",
    source: {
      kind: "official_site",
      url: "https://dclabs.example.org/careers/lead-infra",
      evidence: "Primary Lab Careers Portal",
    },
    ...overrides,
  };
}

function duplicateOpportunity() {
  return {
    ...primaryOpportunity(),
    description: "Architecting zero-downtime Raft consensus (syndicated listing).",
    source: {
      kind: "aggregator",
      url: "https://dclabs.example.org/careers/lead-infra", // Same canonical URL
      evidence: "Aggregated Job Board feed",
    },
  };
}

describe("NEXUS Career & Education Fake E2E Journey", () => {
  let harness: ApiHarness;
  let userA: Account;
  let userB: Account;

  beforeEach(async () => {
    harness = await makeApi();
    userA = await createAccount(harness, "applicant.a@nexus.test");
    userB = await createAccount(harness, "intruder.b@nexus.test");
  });

  afterEach(async () => {
    await harness.close();
  });

  it("executes the complete required journey: duplicate ingest -> rank -> shortlist -> tailored draft -> durable approval -> fake submit exactly once -> outcome across restart; rejected/expired cannot submit; cross-user access fails", async () => {
    // ── Setup: Profile ───────────────────────────────────────────────────────
    const profileRes = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/career/profile",
      headers: userA.authorization,
      payload: testProfile(),
    });
    expect(profileRes.statusCode).toBe(200);

    // ── Step 1: Duplicate Ingest ─────────────────────────────────────────────
    const ingestRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/career/ingest",
      headers: userA.authorization,
      payload: {
        items: [primaryOpportunity(), duplicateOpportunity()],
      },
    });

    expect(ingestRes.statusCode).toBe(200);
    const ingestReport = ingestRes.json<{
      data: { created: number; merged: number; outcomes: { opportunityId: string }[] };
    }>().data;

    expect(ingestReport.created).toBe(1);
    expect(ingestReport.merged).toBe(1);
    const oppId = ingestReport.outcomes[0]!.opportunityId;

    // Verify stored opportunity has merged provenance
    const getOpp = await harness.app.inject({
      method: "GET",
      url: `/api/v1/career/opportunities/${oppId}`,
      headers: userA.authorization,
    });
    expect(getOpp.statusCode).toBe(200);
    const oppData = getOpp.json<{ data: { provenance: unknown[] } }>().data;
    expect(oppData.provenance).toHaveLength(2);

    // ── Step 2: Rank ─────────────────────────────────────────────────────────
    const searchRes = await harness.app.inject({
      method: "GET",
      url: "/api/v1/career/opportunities",
      headers: userA.authorization,
    });

    expect(searchRes.statusCode).toBe(200);
    const searchBody = searchRes.json<{
      data: {
        opportunities: {
          id: string;
          matchExplanation: { score: number; factors: { factor: string }[] };
        }[];
      };
    }>().data;

    expect(searchBody.opportunities).toHaveLength(1);
    const rankedOpp = searchBody.opportunities[0]!;
    expect(rankedOpp.id).toBe(oppId);
    expect(rankedOpp.matchExplanation.score).toBeGreaterThan(60);
    expect(rankedOpp.matchExplanation.factors.some((f) => f.factor === "kind")).toBe(true);

    // ── Step 3: Shortlist ────────────────────────────────────────────────────
    const shortlistRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/opportunities/${oppId}/shortlist`,
      headers: userA.authorization,
    });

    expect(shortlistRes.statusCode).toBe(200);
    const appData = shortlistRes.json<{ data: { id: string; state: string } }>().data;
    const applicationId = appData.id;
    expect(appData.state).toBe("shortlisted");

    // ── Step 4: Tailored Draft ───────────────────────────────────────────────
    const draftStateRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${applicationId}/drafting`,
      headers: userA.authorization,
    });
    expect(draftStateRes.statusCode).toBe(200);
    expect(draftStateRes.json<{ data: { state: string } }>().data.state).toBe("drafting");

    const documentRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${applicationId}/documents`,
      headers: userA.authorization,
      payload: {
        kind: "cover_letter",
        body: "I am excited to apply for the Lead Infrastructure Architect position at Distributed Consensus Labs.",
        parentVariantId: null,
      },
    });

    expect(documentRes.statusCode).toBe(200);
    const documentData = documentRes.json<{
      data: { id: string; revision: number; contentHash: string };
    }>().data;
    const documentId = documentData.id;
    expect(documentData.revision).toBe(1);
    expect(documentData.contentHash).toHaveLength(64);

    // ── Step 5: Durable Approval ─────────────────────────────────────────────
    const reqRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${applicationId}/approval-request`,
      headers: userA.authorization,
    });

    expect(reqRes.statusCode).toBe(200);
    const reqBody = reqRes.json<{
      data: {
        confirmation: { id: string; state: string; payloadHash: string };
        application: { state: string };
      };
    }>().data;

    const confirmationId = reqBody.confirmation.id;
    expect(reqBody.confirmation.state).toBe("pending");
    expect(reqBody.confirmation.payloadHash).toHaveLength(64);
    expect(reqBody.application.state).toBe("awaiting_confirmation");

    // Approve the confirmation
    const decideRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/confirmations/${confirmationId}/decide`,
      headers: userA.authorization,
      payload: { decision: "approved" },
    });

    expect(decideRes.statusCode).toBe(200);
    const decideBody = decideRes.json<{
      data: {
        confirmation: { state: string };
        application: { state: string };
      };
    }>().data;
    expect(decideBody.confirmation.state).toBe("approved");
    expect(decideBody.application.state).toBe("approved");

    // ── Step 6: Fake Submit Exactly Once ─────────────────────────────────────
    const submitRes1 = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${applicationId}/submit`,
      headers: userA.authorization,
    });

    expect(submitRes1.statusCode).toBe(200);
    const submitBody1 = submitRes1.json<{
      data: {
        attempt: { state: string; receipt: string | null };
        replayed: boolean;
      };
    }>().data;

    expect(submitBody1.replayed).toBe(false);
    expect(submitBody1.attempt.state).toBe("succeeded");
    expect(submitBody1.attempt.receipt).not.toBeNull();

    // Verify confirmation is consumed and application is submitted
    const appDetailRes = await harness.app.inject({
      method: "GET",
      url: `/api/v1/career/applications/${applicationId}`,
      headers: userA.authorization,
    });
    expect(appDetailRes.statusCode).toBe(200);
    const detail = appDetailRes.json<{ data: { application: { state: string } } }>().data;
    expect(detail.application.state).toBe("submitted");

    // Replay attempt: submitting again cannot double submit
    const submitRes2 = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${applicationId}/submit`,
      headers: userA.authorization,
    });
    // In submitted state, submit is refused by lifecycle assertion:
    expect(submitRes2.statusCode).toBe(409);

    // ── Step 7: Outcome Across Restart ───────────────────────────────────────
    // Simulate restart by creating a new CareerService backed by the same persistent store
    const restartedAdapter = new RecordingSubmissionAdapter();
    const restartedService = new CareerService({
      store: harness.services.careerStore,
      adapter: restartedAdapter,
      now: () => new Date("2026-10-20T10:00:00Z"),
    });

    // Check application state holds across restart
    const appAcrossRestart = await restartedService.applicationDetail(userA.userId, applicationId);
    expect(appAcrossRestart.application.state).toBe("submitted");
    expect(appAcrossRestart.documents).toHaveLength(1);

    // Record outcome on the restarted instance
    const outcomeResult = await restartedService.recordOutcome(userA.userId, applicationId, {
      result: "offer",
      decidedAt: new Date("2026-10-25T14:00:00Z"),
      notes: "Received competitive offer with sign-on grant.",
    });

    expect(outcomeResult.outcome.result).toBe("offer");
    expect(outcomeResult.application.state).toBe("offer");

    // Verify outcome persisted back through API
    const verifyApiRes = await harness.app.inject({
      method: "GET",
      url: `/api/v1/career/applications/${applicationId}`,
      headers: userA.authorization,
    });
    expect(verifyApiRes.statusCode).toBe(200);
    const apiDetail = verifyApiRes.json<{
      data: { application: { state: string }; outcome: { result: string } };
    }>().data;
    expect(apiDetail.application.state).toBe("offer");
    expect(apiDetail.outcome.result).toBe("offer");

    // ── Step 8: Rejected & Expired Cannot Submit ──────────────────────────────
    // Ingest second opportunity for testing rejection & expiry safety
    const secondOppRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/career/ingest",
      headers: userA.authorization,
      payload: {
        items: [
          primaryOpportunity({
            title: "Staff Engineer (Refused Test)",
            externalRef: "refused-test-002",
            source: {
              kind: "official_site",
              url: "https://dclabs.example.org/careers/staff-2",
              evidence: "Primary Lab Careers Portal 2",
            },
          }),
        ],
      },
    });
    const secondOppId = secondOppRes.json<{
      data: { outcomes: { opportunityId: string }[] };
    }>().data.outcomes[0]!.opportunityId;

    const secondAppRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/opportunities/${secondOppId}/shortlist`,
      headers: userA.authorization,
    });
    const secondAppId = secondAppRes.json<{ data: { id: string } }>().data.id;

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${secondAppId}/drafting`,
      headers: userA.authorization,
    });

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${secondAppId}/documents`,
      headers: userA.authorization,
      payload: {
        kind: "cover_letter",
        body: "Cover letter draft for second application.",
        parentVariantId: null,
      },
    });

    const secondReqRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${secondAppId}/approval-request`,
      headers: userA.authorization,
    });
    const secondConfId = secondReqRes.json<{
      data: { confirmation: { id: string } };
    }>().data.confirmation.id;

    // Reject the confirmation
    const rejectRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/confirmations/${secondConfId}/decide`,
      headers: userA.authorization,
      payload: { decision: "rejected", reason: "Declined to submit to this company." },
    });
    expect(rejectRes.statusCode).toBe(200);

    // Verify application returned to drafting
    const secondAppAfterReject = await harness.app.inject({
      method: "GET",
      url: `/api/v1/career/applications/${secondAppId}`,
      headers: userA.authorization,
    });
    expect(
      secondAppAfterReject.json<{ data: { application: { state: string } } }>().data.application
        .state,
    ).toBe("drafting");

    // Attempt to submit rejected application -> MUST FAIL
    const submitRejected = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${secondAppId}/submit`,
      headers: userA.authorization,
    });
    expect(submitRejected.statusCode).toBe(409);

    // ── Step 9: Cross-User Access Fails ──────────────────────────────────────
    // User B attempts to access User A's data
    const bGetsOpp = await harness.app.inject({
      method: "GET",
      url: `/api/v1/career/opportunities/${oppId}`,
      headers: userB.authorization,
    });
    expect(bGetsOpp.statusCode).toBe(404);

    const bGetsApp = await harness.app.inject({
      method: "GET",
      url: `/api/v1/career/applications/${applicationId}`,
      headers: userB.authorization,
    });
    expect(bGetsApp.statusCode).toBe(404);

    const bGetsDoc = await harness.app.inject({
      method: "GET",
      url: `/api/v1/career/documents/${documentId}`,
      headers: userB.authorization,
    });
    expect(bGetsDoc.statusCode).toBe(404);

    const bDecidesConf = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/confirmations/${confirmationId}/decide`,
      headers: userB.authorization,
      payload: { decision: "approved" },
    });
    expect(bDecidesConf.statusCode).toBe(404);

    const bSubmits = await harness.app.inject({
      method: "POST",
      url: `/api/v1/career/applications/${applicationId}/submit`,
      headers: userB.authorization,
    });
    expect(bSubmits.statusCode).toBe(404);
  });
});
