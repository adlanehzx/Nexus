import { beforeEach, describe, expect, it } from "vitest";
import type { CareerProfileInput, OpportunityIngestInput } from "@nexus/career";
import { ConflictError } from "@nexus/shared";
import { InMemoryCareerStore } from "../src/services/career/store.js";
import { RecordingSubmissionAdapter } from "../src/services/career/submission-adapter.js";
import { CareerService } from "../src/services/career/career-service.js";
import { SecurityLog } from "../src/services/observability.js";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

function sampleProfileInput(): CareerProfileInput {
  return {
    headline: "Staff Distributed Systems Engineer",
    summary:
      "10+ years specializing in consensus protocols, formal verification, fault-tolerant distributed storage and Rust platform architecture.",
    yearsExperience: 10,
    highestDegree: "master",
    skills: ["Rust", "Distributed Systems", "Raft", "Formal Verification", "Go"],
    languages: [
      { code: "en", level: "native" },
      { code: "fr", level: "fluent" },
    ],
    publications: 2,
    preferences: {
      kinds: ["permanent_job", "phd"],
      locations: ["Paris", "Remote"],
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
      excludedOrganizations: ["BadCorp"],
      noticePeriodDays: 60,
    },
  };
}

function sampleOpportunity(
  overrides: Partial<OpportunityIngestInput> = {},
): OpportunityIngestInput {
  return {
    kind: "permanent_job",
    title: "Lead Infrastructure Architect",
    organization: "Distributed Cloud Lab",
    location: "Paris, France",
    remote: true,
    description: "Designing fault-tolerant storage engines and consensus systems.",
    requirements: ["Rust", "Distributed Systems", "Raft"],
    compensation: {
      currency: "EUR",
      period: "year",
      minAmount: 110_000,
      maxAmount: 135_000,
    },
    postedAt: new Date("2026-10-01T10:00:00Z"),
    closesAt: new Date("2026-12-31T23:59:59Z"),
    externalRef: "ref-dist-cloud-001",
    source: {
      kind: "official_site",
      url: "https://cloudlab.example.org/jobs/lead-arch",
      evidence: "Job listing on official career portal",
    },
    ...overrides,
  };
}

describe("CareerService Unit & In-Memory Store", () => {
  let store: InMemoryCareerStore;
  let adapter: RecordingSubmissionAdapter;
  let securityLog: SecurityLog;
  let service: CareerService;
  let nowTime: Date;

  beforeEach(() => {
    store = new InMemoryCareerStore();
    adapter = new RecordingSubmissionAdapter();
    securityLog = new SecurityLog();
    nowTime = new Date("2026-10-15T12:00:00Z");
    service = new CareerService({
      store,
      adapter,
      securityLog,
      now: () => nowTime,
    });
  });

  describe("profile & completeness", () => {
    it("saves and retrieves a profile with completeness calculation", async () => {
      const initial = await service.profile(USER_A);
      expect(initial.profile).toBeNull();
      expect(initial.completeness).toBeNull();

      const saved = await service.saveProfile(USER_A, sampleProfileInput());
      expect(saved.profile).not.toBeNull();
      expect(saved.profile?.headline).toBe("Staff Distributed Systems Engineer");
      expect(saved.profile?.version).toBe(1);
      expect(saved.completeness?.score).toBeGreaterThan(0);
      expect(saved.completeness?.readyToDraft).toBe(true);

      const retrieved = await service.profile(USER_A);
      expect(retrieved.profile?.id).toBe(saved.profile?.id);
    });

    it("bumps version on profile update", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const updated = await service.saveProfile(USER_A, {
        ...sampleProfileInput(),
        headline: "Principal Distributed Systems Engineer",
      });
      expect(updated.profile?.version).toBe(2);
      expect(updated.profile?.headline).toBe("Principal Distributed Systems Engineer");
    });
  });

  describe("ingest & deduplication", () => {
    it("deduplicates identical listings by canonical URL and merges sightings", async () => {
      const opp = sampleOpportunity();
      const report1 = await service.ingest(USER_A, [opp]);
      expect(report1.created).toBe(1);
      expect(report1.merged).toBe(0);

      // Ingest duplicate with same canonical URL but from another source
      const duplicateOpp = sampleOpportunity({
        source: {
          kind: "aggregator",
          url: "https://cloudlab.example.org/jobs/lead-arch",
          evidence: "Aggregator listing",
        },
      });

      const report2 = await service.ingest(USER_A, [duplicateOpp]);
      expect(report2.created).toBe(0);
      expect(report2.merged).toBe(1);

      // Verify opportunity has two provenance entries
      const stored = await store.getOpportunity(USER_A, report1.outcomes[0]!.opportunityId);
      expect(stored?.provenance).toHaveLength(2);
      expect(stored?.provenance[0]!.kind).toBe("official_site");
      expect(stored?.provenance[1]!.kind).toBe("aggregator");
    });

    it("isolates opportunities between users", async () => {
      const opp = sampleOpportunity();
      await service.ingest(USER_A, [opp]);
      await service.ingest(USER_B, [opp]);

      const oppsA = await store.listOpportunities(USER_A, { limit: 10 });
      const oppsB = await store.listOpportunities(USER_B, { limit: 10 });
      expect(oppsA).toHaveLength(1);
      expect(oppsB).toHaveLength(1);
      expect(oppsA[0]!.userId).toBe(USER_A);
      expect(oppsB[0]!.userId).toBe(USER_B);
      expect(oppsA[0]!.id).not.toBe(oppsB[0]!.id);
    });
  });

  describe("search & ranking", () => {
    it("ranks matched opportunities above non-matching or excluded ones", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());

      const goodOpp = sampleOpportunity({
        title: "Senior Rust Consensus Engineer",
        requirements: ["Rust", "Distributed Systems"],
      });
      const excludedOpp = sampleOpportunity({
        organization: "BadCorp",
        source: {
          kind: "official_site",
          url: "https://badcorp.example.org/job",
          evidence: "BadCorp portal",
        },
      });

      await service.ingest(USER_A, [goodOpp, excludedOpp]);

      const results = await service.search(USER_A, { limit: 10, includeExcluded: false });
      expect(results).toHaveLength(1);
      expect(results[0]!.opportunity.organization).toBe("Distributed Cloud Lab");
      expect(results[0]!.explanation.score).toBeGreaterThan(50);
      expect(results[0]!.explanation.factors.some((f) => f.factor === "kind")).toBe(true);
    });
  });

  describe("application lifecycle & documents", () => {
    it("transitions through shortlist -> drafting -> tailored document", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;

      // Shortlist
      const app = await service.shortlist(USER_A, oppId);
      expect(app.state).toBe("shortlisted");

      // Advance to drafting
      const draftingApp = await service.startDrafting(USER_A, app.id);
      expect(draftingApp.state).toBe("drafting");

      // Draft a document
      const doc = await service.draftDocument(USER_A, app.id, {
        kind: "cover_letter",
        body: "I am writing to express strong interest in the Lead Infrastructure Architect role.",
        parentVariantId: null,
      });

      expect(doc.kind).toBe("cover_letter");
      expect(doc.revision).toBe(1);
      expect(doc.contentHash).toHaveLength(64);

      // Verify detail
      const detail = await service.applicationDetail(USER_A, app.id);
      expect(detail.documents).toHaveLength(1);
      expect(detail.documents[0]!.id).toBe(doc.id);
    });
  });

  describe("durable confirmation & discrete decisions", () => {
    it("handles approve decision: transitions to approved", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);
      await service.startDrafting(USER_A, app.id);
      await service.draftDocument(USER_A, app.id, {
        kind: "cover_letter",
        body: "Cover letter content.",
        parentVariantId: null,
      });

      // Request approval
      const req = await service.requestApproval(USER_A, app.id);
      expect(req.confirmation.state).toBe("pending");
      expect(req.application.state).toBe("awaiting_confirmation");

      // Approve
      const decided = await service.decideConfirmation(USER_A, req.confirmation.id, "approved");
      expect(decided.confirmation.state).toBe("approved");
      expect(decided.application.state).toBe("approved");
    });

    it("handles reject decision: marks rejected and returns application to drafting", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);
      await service.startDrafting(USER_A, app.id);
      await service.draftDocument(USER_A, app.id, {
        kind: "cover_letter",
        body: "Cover letter content.",
        parentVariantId: null,
      });

      const req = await service.requestApproval(USER_A, app.id);
      const decided = await service.decideConfirmation(
        USER_A,
        req.confirmation.id,
        "rejected",
        "Salary range not competitive enough",
      );

      expect(decided.confirmation.state).toBe("rejected");
      expect(decided.application.state).toBe("drafting");
    });

    it("handles cancel decision: marks cancelled and returns application to drafting", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);
      await service.startDrafting(USER_A, app.id);
      await service.draftDocument(USER_A, app.id, {
        kind: "cover_letter",
        body: "Cover letter content.",
        parentVariantId: null,
      });

      const req = await service.requestApproval(USER_A, app.id);
      const decided = await service.decideConfirmation(
        USER_A,
        req.confirmation.id,
        "cancelled",
        "User cancelled before sending",
      );

      expect(decided.confirmation.state).toBe("cancelled");
      expect(decided.application.state).toBe("drafting");
    });

    it("handles expire: answering an expired confirmation fails and marks it expired", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);
      await service.startDrafting(USER_A, app.id);
      await service.draftDocument(USER_A, app.id, {
        kind: "cover_letter",
        body: "Cover letter content.",
        parentVariantId: null,
      });

      const req = await service.requestApproval(USER_A, app.id);

      // Fast-forward time past 24 hours
      nowTime = new Date(nowTime.getTime() + 25 * 3600 * 1000);

      await expect(
        service.decideConfirmation(USER_A, req.confirmation.id, "approved"),
      ).rejects.toThrow(ConflictError);

      const conf = await store.getConfirmation(USER_A, req.confirmation.id);
      expect(conf?.state).toBe("expired");
    });
  });

  describe("submission guarantees", () => {
    it("submits exactly once and is replay-safe", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);
      await service.startDrafting(USER_A, app.id);
      await service.draftDocument(USER_A, app.id, {
        kind: "cv",
        body: "CV body content for test.",
        parentVariantId: null,
      });

      const req = await service.requestApproval(USER_A, app.id);
      await service.decideConfirmation(USER_A, req.confirmation.id, "approved");

      // First submit
      const result1 = await service.submit(USER_A, app.id);
      expect(result1.replayed).toBe(false);
      expect(result1.attempt.state).toBe("succeeded");
      expect(result1.attempt.receipt).not.toBeNull();
      expect(adapter.calls).toHaveLength(1);

      // Verify application state is submitted
      const submittedApp = await store.getApplication(USER_A, app.id);
      expect(submittedApp?.state).toBe("submitted");

      // Second submit (replay attempt)
      // In submitted state, submit is refused by lifecycle assertion:
      await expect(service.submit(USER_A, app.id)).rejects.toThrow();
      // Adapter must NOT have been called again!
      expect(adapter.calls).toHaveLength(1);
    });

    it("refuses submission for unapproved applications and logs security refusal", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);

      // Attempting to submit in shortlisted state fails
      await expect(service.submit(USER_A, app.id)).rejects.toThrow();
      expect(adapter.calls).toHaveLength(0);

      // Verify security log recorded refusal
      const events = securityLog.list();
      expect(events.some((e) => e.kind === "career.submission_refused")).toBe(true);
    });
  });

  describe("deadlines, interviews, outcomes and sweep", () => {
    it("records outcome and updates application", async () => {
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [sampleOpportunity()]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);
      await service.startDrafting(USER_A, app.id);
      await service.draftDocument(USER_A, app.id, {
        kind: "cover_letter",
        body: "Cover letter",
        parentVariantId: null,
      });
      const req = await service.requestApproval(USER_A, app.id);
      await service.decideConfirmation(USER_A, req.confirmation.id, "approved");
      await service.submit(USER_A, app.id);

      const res = await service.recordOutcome(USER_A, app.id, {
        result: "offer",
        decidedAt: new Date("2026-11-01T10:00:00Z"),
        notes: "Offer accepted with sign-on bonus",
      });

      expect(res.outcome.result).toBe("offer");
      expect(res.application.state).toBe("offer");
    });

    it("sweeps expired opportunities and marks applications expired", async () => {
      const pastClosesAt = new Date("2026-10-10T00:00:00Z");
      await service.saveProfile(USER_A, sampleProfileInput());
      const ingestReport = await service.ingest(USER_A, [
        sampleOpportunity({ closesAt: pastClosesAt }),
      ]);
      const oppId = ingestReport.outcomes[0]!.opportunityId;
      const app = await service.shortlist(USER_A, oppId);

      const swept = await service.sweepExpired(USER_A);
      expect(swept).toHaveLength(1);
      expect(swept[0]!.id).toBe(app.id);
      expect(swept[0]!.state).toBe("expired");
    });
  });
});
