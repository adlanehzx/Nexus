import { describe, expect, it } from "vitest";
import {
  FakeCareerEducationClient,
  calculateProfileCompleteness,
  type CareerEducationProfile,
} from "@nexus/client-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Career & Education Dashboard Integration & User Journey", () => {
  it("executes the complete required fake journey: profile -> search -> cited results -> compare/shortlist -> application -> documents -> transparent approve/reject -> fake outcome", async () => {
    const client = new FakeCareerEducationClient();

    // 1. PROFILE & COMPLETENESS
    const initialProfile = await client.getProfile();
    expect(initialProfile.id).toBeDefined();
    expect(initialProfile.completeness.score).toBe(100);

    const updatedProfile = await client.updateProfile({
      headline: "Staff Systems Architect & PhD Candidate in Distributed Consensus",
      targetLocations: ["Paris, France", "Berlin, Germany", "Remote"],
    });
    expect(updatedProfile.headline).toContain("PhD Candidate");
    expect(updatedProfile.completeness.score).toBe(100);

    // 2. SEARCH (MULTI-TRACK & SAFE RESEARCH PLANE)
    const searchResult = await client.searchOpportunities({
      track: "all",
      minScore: 85,
      onlyFresh: true,
      includeDuplicates: false,
    });

    expect(searchResult.total).toBeGreaterThanOrEqual(3);
    const tracksFound = searchResult.items.map((i) => i.track);
    expect(tracksFound).toContain("phd");
    expect(tracksFound).toContain("cdi");
    expect(tracksFound).toContain("freelance");

    // 3. CITED RESULTS & EXPLAINABLE MATCH
    const phdOpp = searchResult.items.find((i) => i.track === "phd")!;
    expect(phdOpp).toBeDefined();
    expect(phdOpp.citations.length).toBeGreaterThan(0);
    expect(phdOpp.citations[0]!.verified).toBe(true);
    expect(phdOpp.citations[0]!.documentSha256.length).toBe(64);
    expect(phdOpp.match.score).toBeGreaterThanOrEqual(85);
    expect(phdOpp.match.strengths.length).toBeGreaterThan(0);
    expect(phdOpp.match.breakdown.skills).toBeGreaterThan(0);

    // 4. COMPARE / SHORTLIST
    const cdiOpp = searchResult.items.find((i) => i.track === "cdi")!;
    const flOpp = searchResult.items.find((i) => i.track === "freelance")!;

    await client.toggleShortlist(phdOpp.id, true);
    await client.toggleShortlist(cdiOpp.id, true);
    await client.toggleShortlist(flOpp.id, true);

    const matrix = await client.compareOpportunities([phdOpp.id, cdiOpp.id, flOpp.id]);
    expect(matrix.opportunities.length).toBe(3);
    expect(matrix.tradeoffsSummary.length).toBeGreaterThan(0);
    const compensationMetric = matrix.metrics.find((m) => m.key === "compensation");
    expect(compensationMetric).toBeDefined();
    expect(compensationMetric?.valuesByOpportunityId[phdOpp.id]).toContain("€2600");
    expect(compensationMetric?.valuesByOpportunityId[cdiOpp.id]).toContain("€105k");
    expect(compensationMetric?.valuesByOpportunityId[flOpp.id]).toContain("€780");

    // 5. APPLICATION KANBAN PIPELINE
    const applications = await client.getApplications();
    const app = applications.find((a) => a.opportunityId === phdOpp.id);
    expect(app).toBeDefined();
    expect(app!.stage).toBe("shortlisted");

    const preparingApp = await client.updateApplicationStage(
      app!.id,
      "preparing",
      "Drafting LIP6 research statement and thesis outline",
    );
    expect(preparingApp.stage).toBe("preparing");
    expect(preparingApp.stageHistory.at(-1)?.note).toContain("LIP6");

    // 6. TAILORED DOCUMENTS
    const tailoredStatement = await client.generateDocumentVariant({
      opportunityId: phdOpp.id,
      applicationId: app!.id,
      type: "research_statement",
    });
    expect(tailoredStatement.type).toBe("research_statement");
    expect(tailoredStatement.digestSha256).toBeDefined();
    expect(tailoredStatement.tailoredHighlights.length).toBeGreaterThan(0);
    expect(tailoredStatement.diffSummary.sectionsTailored.length).toBeGreaterThan(0);

    const tailoredCv = await client.generateDocumentVariant({
      opportunityId: phdOpp.id,
      applicationId: app!.id,
      type: "cv",
    });
    expect(tailoredCv.type).toBe("cv");

    // 7. STRICT EXTERNAL CONFIRMATION (APPROVE & REJECT)
    // Consequential external submission stops at ConfirmationRequest
    const pendingSubmission = await client.prepareDraftApplication(phdOpp.id, {
      applicantName: "Alex Rivera",
      doctoralSchool: "ED130",
    });

    expect(pendingSubmission.requiresHumanApproval).toBe(true);
    expect(pendingSubmission.status).toBe("pending");
    expect(pendingSubmission.destination).toContain("doctoral-school.sorbonne-universite.fr");
    expect(pendingSubmission.risks.length).toBeGreaterThan(0);
    expect(pendingSubmission.consequences.length).toBeGreaterThan(0);

    // Verify application stage transitioned to pending_approval
    const appsAfterDraft = await client.getApplications();
    const appWaiting = appsAfterDraft.find((a) => a.id === app!.id);
    expect(appWaiting?.stage).toBe("pending_approval");

    // Approve the confirmation
    const approved = await client.resolveConfirmation(
      pendingSubmission.id,
      "approve",
      "Verified research statement and thesis attachments. Ready for admission committee.",
    );
    expect(approved.status).toBe("approved");
    expect(approved.decidedAt).toBeDefined();

    // Verify application stage transitioned to submitted upon approval
    const appsAfterApproval = await client.getApplications();
    const appSubmitted = appsAfterApproval.find((a) => a.id === app!.id);
    expect(appSubmitted?.stage).toBe("submitted");

    // Test rejection flow on another action (e.g. outreach email)
    const emailDraft = await client.prepareDraftEmail(
      cdiOpp.id,
      "recruiter@cloudscale.eu",
      "Question on hybrid policy",
      "Hello Claudia...",
    );
    expect(emailDraft.status).toBe("pending");

    const rejected = await client.resolveConfirmation(
      emailDraft.id,
      "reject",
      "Decided to attend on-campus interview before sending inquiry.",
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionRationale).toContain("Decided to attend");

    // 8. FAKE OUTCOME RECORDING & ANALYTICS
    const outcome = await client.recordOutcome({
      applicationId: app!.id,
      opportunityId: phdOpp.id,
      decision: "accepted",
      finalOfferDetails: {
        compensation: "€2,600 / month gross (CIFRE)",
        startDate: "2026-10-01",
      },
      feedbackReceived: "Exceptional alignment with LIP6 formal verification roadmap.",
      retrospectiveNotes: "Accepted doctoral position co-advised by Dr. Vance.",
    });

    expect(outcome.decision).toBe("accepted");
    expect(outcome.finalOfferDetails?.compensation).toContain("€2,600");

    const analytics = await client.getAnalytics();
    expect(analytics.totalOpportunitiesDiscovered).toBeGreaterThan(0);
    expect(analytics.funnel.length).toBeGreaterThan(0);

    // Verify Audit Trail Recorded the Journey
    const auditEvents = await client.getAuditEvents(50);
    const actionTypes = auditEvents.map((e) => e.action);
    expect(actionTypes).toContain("profile_updated");
    expect(actionTypes).toContain("opportunity_shortlist_toggled");
    expect(actionTypes).toContain("application_stage_updated");
    expect(actionTypes).toContain("document_variant_generated");
    expect(actionTypes).toContain("confirmation_approved");
    expect(actionTypes).toContain("outcome_recorded");
  });

  describe("Accessibility & Semantic UI Structure", () => {
    it("ensures Career & Education views declare semantic ARIA roles and labels", () => {
      const componentFiles = [
        "src/ui/CareerEducation/index.tsx",
        "src/ui/CareerEducation/ProfileWizard.tsx",
        "src/ui/CareerEducation/OpportunityInbox.tsx",
        "src/ui/CareerEducation/ShortlistComparison.tsx",
        "src/ui/CareerEducation/ApplicationKanban.tsx",
        "src/ui/CareerEducation/DocumentVariants.tsx",
        "src/ui/CareerEducation/DeadlinesCalendar.tsx",
        "src/ui/CareerEducation/ContactsOutcomesAnalytics.tsx",
        "src/ui/CareerEducation/ApprovalCards.tsx",
        "src/ui/CareerEducation/CareerSettings.tsx",
      ];

      for (const relPath of componentFiles) {
        const fullPath = resolve(__dirname, "..", relPath);
        const content = readFileSync(fullPath, "utf8");

        // Verify semantic attributes
        expect(
          content.includes('role="region"') ||
            content.includes('role="tablist"') ||
            content.includes('role="tabpanel"') ||
            content.includes('role="dialog"') ||
            content.includes('role="main"'),
        ).toBe(true);

        expect(
          content.includes("aria-label") ||
            content.includes("aria-labelledby") ||
            content.includes("aria-modal"),
        ).toBe(true);
      }
    });

    it("never hardcodes personal credentials or tokens in career UI files", () => {
      const fullPath = resolve(__dirname, "../src/ui/CareerEducation/index.tsx");
      const content = readFileSync(fullPath, "utf8");

      expect(content).not.toContain("password");
      expect(content).not.toContain("Bearer ");
      expect(content).not.toContain("ghp_");
      expect(content).not.toContain("sk_live");
    });
  });

  describe("Honest Error Handling & Degraded State Reporting", () => {
    it("reports honest network offline error rather than silent success", async () => {
      const client = new FakeCareerEducationClient();
      await client.updateSettings({ offlineSimulation: true });

      await expect(client.searchOpportunities({ track: "all" })).rejects.toThrow(
        /Network offline error/i,
      );

      await expect(client.refreshSource("source_inria_doctoral")).rejects.toThrow(
        /Network offline error/i,
      );
    });

    it("displays honest degraded status when source feed returns 429 rate limit", async () => {
      const client = new FakeCareerEducationClient();
      await client.updateSettings({ degradedFeedSimulation: true });

      const source = await client.refreshSource("source_unstable_external");
      expect(source.status).toBe("degraded");
      expect(source.lastError).toContain("Rate limit exceeded");
    });
  });

  describe("Completeness Calculation Edge Cases", () => {
    it("flags missing fields accurately when profile is partially filled", () => {
      const partial: Partial<CareerEducationProfile> = {
        fullName: "Test User",
        headline: "Engineer",
        summary: "Summary",
        preferredTracks: ["phd"],
        primaryDiscipline: "Formal Methods",
        skills: ["Rust", "TLA+"], // only 2 skills, requires 3
        education: [], // missing education
      };

      const result = calculateProfileCompleteness(partial);
      expect(result.score).toBeLessThan(100);
      expect(result.missingCrucialFields).toContain("Core Skills & Domain Keywords");
      expect(result.missingCrucialFields).toContain("Education & Academic Background");
      expect(result.actionableRecommendations.length).toBeGreaterThan(0);
    });
  });
});
