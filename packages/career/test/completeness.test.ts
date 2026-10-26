import { describe, expect, it } from "vitest";
import { assessCompleteness, draftingBlockers } from "../src/completeness.js";
import { makeProfile } from "./fixtures.js";

describe("assessCompleteness", () => {
  it("reports a full profile as complete and ready", () => {
    const report = assessCompleteness(makeProfile());
    expect(report.score).toBe(100);
    expect(report.gaps).toEqual([]);
    expect(report.blockedKinds).toEqual({});
    expect(report.readyToDraft).toBe(true);
  });

  it("returns both a score and the list of what is missing", () => {
    const report = assessCompleteness(makeProfile({ summary: "", skills: [], languages: [] }));

    expect(report.score).toBeLessThan(100);
    expect(report.gaps.map((gap) => gap.field)).toContain("summary");
    expect(report.gaps.map((gap) => gap.field)).toContain("skills");
  });

  it("orders gaps by weight, heaviest first", () => {
    const report = assessCompleteness(makeProfile({ summary: "", skills: [], languages: [] }));
    const weights = report.gaps.map((gap) => gap.weight);
    expect([...weights].sort((left, right) => right - left)).toEqual(weights);
  });

  it("gives a reason for every gap, not just a field name", () => {
    const report = assessCompleteness(makeProfile({ summary: "", skills: [] }));
    for (const gap of report.gaps) expect(gap.reason.length).toBeGreaterThan(20);
  });

  it("separates what lowers the score from what blocks drafting", () => {
    // A missing language lowers the score and blocks nothing.
    const report = assessCompleteness(makeProfile({ languages: [] }));
    expect(report.score).toBeLessThan(100);
    expect(report.readyToDraft).toBe(true);
  });

  it("blocks a doctoral application with no research area", () => {
    const profile = makeProfile();
    const report = assessCompleteness(
      makeProfile({ preferences: { ...profile.preferences, researchAreas: [] } }),
    );

    expect(report.readyToDraft).toBe(false);
    expect(report.blockedKinds.phd?.join(" ")).toContain("research area");
    // The same hole does not block a permanent position.
    expect(report.blockedKinds.permanent_job).toBeUndefined();
  });

  it("blocks a doctoral application from a profile with no degree", () => {
    const report = assessCompleteness(makeProfile({ highestDegree: "none" }));
    expect(report.blockedKinds.phd?.join(" ")).toContain("highest degree");
  });

  it("blocks a permanent application with too short a summary", () => {
    const report = assessCompleteness(makeProfile({ summary: "Short." }));
    expect(report.blockedKinds.permanent_job?.join(" ")).toContain("80 characters");
  });

  it("only reports blockers for kinds the owner declared", () => {
    const profile = makeProfile();
    const report = assessCompleteness(
      makeProfile({
        skills: [],
        preferences: { ...profile.preferences, kinds: ["phd"] },
      }),
    );

    expect(report.blockedKinds.freelance).toBeUndefined();
    expect(report.blockedKinds.permanent_job).toBeUndefined();
  });

  it("never returns a score outside 0 to 100", () => {
    for (const profile of [
      makeProfile(),
      makeProfile({ headline: "x", summary: "", skills: [], languages: [] }),
    ]) {
      const report = assessCompleteness(profile);
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);
    }
  });
});

describe("draftingBlockers", () => {
  it("returns reasons rather than a boolean, so a refusal can be explained", () => {
    const reasons = draftingBlockers(makeProfile({ skills: [] }), "freelance");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("three skills");
  });

  it("is empty for a profile that can support the kind", () => {
    expect(draftingBlockers(makeProfile(), "permanent_job")).toEqual([]);
  });
});
