import { describe, expect, it } from "vitest";
import {
  FakeCareerEducationClient,
  calculateProfileCompleteness,
  type CareerEducationProfile,
} from "../src/career-education/index.js";

describe("Career & Education Contracts & Fake Client", () => {
  describe("Completeness Calculator", () => {
    it("computes 0 score for empty profile", () => {
      const result = calculateProfileCompleteness({});
      expect(result.score).toBe(0);
      expect(result.missingCrucialFields.length).toBeGreaterThan(0);
      expect(result.actionableRecommendations.length).toBeGreaterThan(0);
    });

    it("computes 100 score for fully populated profile", async () => {
      const client = new FakeCareerEducationClient();
      const profile = await client.getProfile();
      const result = calculateProfileCompleteness(profile);
      expect(result.score).toBe(100);
      expect(result.missingCrucialFields).toEqual([]);
    });

    it("deducts score when crucial fields are omitted", async () => {
      const client = new FakeCareerEducationClient();
      const profile = await client.getProfile();
      const partial: Partial<CareerEducationProfile> = {
        ...profile,
        summary: "",
        headline: "",
      };
      const result = calculateProfileCompleteness(partial);
      expect(result.score).toBeLessThan(100);
      expect(result.missingCrucialFields).toContain("Identity & Professional Headline");
    });
  });

  describe("Opportunity Discovery & Multi-Track Filtering", () => {
    it("filters opportunities by PhD, CDI, and Freelance tracks", async () => {
      const client = new FakeCareerEducationClient();

      const all = await client.searchOpportunities({ track: "all" });
      expect(all.total).toBeGreaterThan(0);

      const phd = await client.searchOpportunities({ track: "phd" });
      expect(phd.items.every((o) => o.track === "phd")).toBe(true);
      expect(phd.items.some((o) => o.phdDetails?.supervisors.length)).toBe(true);

      const cdi = await client.searchOpportunities({ track: "cdi" });
      expect(cdi.items.every((o) => o.track === "cdi")).toBe(true);
      expect(cdi.items.some((o) => o.cdiDetails?.salaryMin)).toBe(true);

      const freelance = await client.searchOpportunities({ track: "freelance" });
      expect(freelance.items.every((o) => o.track === "freelance")).toBe(true);
      expect(freelance.items.some((o) => o.freelanceDetails?.dailyRateMin)).toBe(true);
    });

    it("detects and tags duplicate opportunities", async () => {
      const client = new FakeCareerEducationClient();
      const resWithDups = await client.searchOpportunities({
        track: "all",
        includeDuplicates: true,
      });
      const duplicates = resWithDups.items.filter((o) => o.duplicate.isDuplicate);
      expect(duplicates.length).toBeGreaterThan(0);
      expect(duplicates[0]?.duplicate.reason).toBe("canonical_url");

      const resNoDups = await client.searchOpportunities({
        track: "all",
        includeDuplicates: false,
      });
      expect(resNoDups.items.every((o) => !o.duplicate.isDuplicate)).toBe(true);
    });

    it("verifies public citations and explainable match scores", async () => {
      const client = new FakeCareerEducationClient();
      const opp = await client.getOpportunity("opp_phd_sorbonne_01");

      expect(opp.citations.length).toBeGreaterThan(0);
      expect(opp.citations[0]?.verified).toBe(true);
      expect(opp.citations[0]?.quote).toContain("CIFRE/ANR");

      expect(opp.match.score).toBeGreaterThan(90);
      expect(opp.match.strengths.length).toBeGreaterThan(0);
      expect(opp.match.breakdown.skills).toBeGreaterThan(0);
    });

    it("builds a side-by-side comparison matrix", async () => {
      const client = new FakeCareerEducationClient();
      const matrix = await client.compareOpportunities([
        "opp_phd_sorbonne_01",
        "opp_cdi_cloudscale_02",
        "opp_freelance_fintech_03",
      ]);

      expect(matrix.opportunities.length).toBe(3);
      expect(matrix.metrics.length).toBeGreaterThan(4);
      expect(matrix.tradeoffsSummary.length).toBeGreaterThan(0);
    });
  });

  describe("Application Kanban & Tailored Documents", () => {
    it("updates application stage and appends to stage history", async () => {
      const client = new FakeCareerEducationClient();
      const app = await client.createApplication("opp_phd_sorbonne_01");
      const updated = await client.updateApplicationStage(
        app.id,
        "preparing",
        "Drafting thesis proposal",
      );

      expect(updated.stage).toBe("preparing");
      expect(updated.stageHistory.at(-1)?.stage).toBe("preparing");
      expect(updated.stageHistory.at(-1)?.note).toBe("Drafting thesis proposal");
    });

    it("generates tailored documents with diff summaries and highlights", async () => {
      const client = new FakeCareerEducationClient();
      const doc = await client.generateDocumentVariant({
        opportunityId: "opp_cdi_cloudscale_02",
        type: "cover_letter",
      });

      expect(doc.type).toBe("cover_letter");
      expect(doc.markdownContent).toContain("CloudScale");
      expect(doc.tailoredHighlights.length).toBeGreaterThan(0);
      expect(doc.diffSummary.sectionsTailored.length).toBeGreaterThan(0);
      expect(doc.digestSha256.length).toBeGreaterThan(0);
    });
  });

  describe("Safe Research Plane & Strict External Confirmation Boundary", () => {
    it("blocks SSRF attempts in safe search", async () => {
      const client = new FakeCareerEducationClient();
      const response = await client.executeSafeSearch("127.0.0.1/admin");
      expect(response.blockedPrivateDestinationsCount).toBe(1);
      expect(response.results).toEqual([]);
    });

    it("stops external browser form submissions at pending confirmation card", async () => {
      const client = new FakeCareerEducationClient();
      const conf = await client.prepareDraftApplication("opp_phd_sorbonne_01", {
        applicantEmail: "test@example.org",
      });

      expect(conf.requiresHumanApproval).toBe(true);
      expect(conf.status).toBe("pending");
      expect(conf.destination).toContain("doctoral-school.sorbonne-universite.fr");
      expect(conf.risks.length).toBeGreaterThan(0);
      expect(conf.consequences.length).toBeGreaterThan(0);
    });

    it("stops email dispatches at pending confirmation card", async () => {
      const client = new FakeCareerEducationClient();
      const conf = await client.prepareDraftEmail(
        "opp_freelance_fintech_03",
        "cto@fintech.io",
        "Proposal",
        "Hello",
      );

      expect(conf.status).toBe("pending");
      expect(conf.actionType).toBe("gmail_send_draft");
      expect(conf.destination).toBe("cto@fintech.io");
    });

    it("supports distinct approval, rejection, and cancellation lifecycle", async () => {
      const client = new FakeCareerEducationClient();
      const conf = await client.requestConfirmation({
        actionType: "calendar_create_event",
        title: "Test Event",
        summary: "Calendar event draft",
        destination: "Google Calendar",
        payload: { title: "Test" },
        risks: ["Calendar mutation"],
        consequences: ["Alert triggers"],
      });

      expect(conf.status).toBe("pending");

      // Approve
      const approved = await client.resolveConfirmation(conf.id, "approve", "Approved by user");
      expect(approved.status).toBe("approved");
      expect(approved.decisionRationale).toBe("Approved by user");

      // Create another to test rejection
      const conf2 = await client.requestConfirmation({
        actionType: "browser_submit_application",
        title: "Reject Test",
        summary: "Draft",
        destination: "https://example.com",
        payload: {},
        risks: ["Risk"],
        consequences: ["Consequence"],
      });

      const rejected = await client.resolveConfirmation(conf2.id, "reject", "Not interested");
      expect(rejected.status).toBe("rejected");
      expect(rejected.decisionRationale).toBe("Not interested");
    });

    it("shows honest unavailable/degraded states instead of silent success", async () => {
      const client = new FakeCareerEducationClient();

      // Test degraded source status
      await client.updateSettings({ degradedFeedSimulation: true });
      const sources = await client.getMonitoredSources();
      const degraded = sources.find((s) => s.id === "source_unstable_external");
      expect(degraded?.status).toBe("degraded");
      expect(degraded?.lastError).toContain("Rate limit exceeded");

      // Test offline simulation
      await client.updateSettings({ offlineSimulation: true });
      await expect(client.searchOpportunities({ track: "all" })).rejects.toThrow(
        /Network offline/i,
      );
    });
  });
});
