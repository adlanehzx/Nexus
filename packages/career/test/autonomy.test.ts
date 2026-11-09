import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAREER_AUTONOMY_SETTINGS,
  careerAutonomySettingsPatchSchema,
  effectiveAutonomyMode,
  evaluateAutonomyGuardrails,
  mergeCareerAutonomySettings,
  startOfDayInTimezone,
  type AutonomyCandidate,
  type CareerAutonomySettings,
} from "../src/index.js";

const autonomous: CareerAutonomySettings = mergeCareerAutonomySettings(
  DEFAULT_CAREER_AUTONOMY_SETTINGS,
  {
    modes: { shortlist: "autonomous", documents: "autonomous", submission: "autonomous" },
    guardrails: {
      minMatchScore: 60,
      maxSubmissionsPerDay: 2,
      excludedCompanies: ["Evil Corp"],
      excludedKeywords: ["unpaid"],
      excludedContractTypes: ["freelance"],
    },
  },
);

const candidate: AutonomyCandidate = {
  organization: "Acme Robotics",
  kind: "permanent_job",
  title: "Backend engineer",
  description: "TypeScript and PostgreSQL",
  requirements: ["TypeScript"],
  matchScore: 80,
};

describe("career autonomy settings", () => {
  it("defaults to approval for every action, matching the historical behaviour", () => {
    expect(DEFAULT_CAREER_AUTONOMY_SETTINGS.modes).toEqual({
      shortlist: "approval",
      documents: "approval",
      submission: "approval",
    });
    expect(DEFAULT_CAREER_AUTONOMY_SETTINGS.killSwitch).toBe(false);
  });

  it("merges a partial patch and switches modes independently", () => {
    const next = mergeCareerAutonomySettings(DEFAULT_CAREER_AUTONOMY_SETTINGS, {
      modes: { documents: "manual" },
    });
    expect(next.modes).toEqual({
      shortlist: "approval",
      documents: "manual",
      submission: "approval",
    });
    const back = mergeCareerAutonomySettings(next, { modes: { documents: "autonomous" } });
    expect(back.modes.documents).toBe("autonomous");
  });

  it("rejects unknown modes, out-of-range thresholds and unknown timezones", () => {
    expect(
      careerAutonomySettingsPatchSchema.safeParse({ modes: { shortlist: "yolo" } }).success,
    ).toBe(false);
    expect(() =>
      mergeCareerAutonomySettings(DEFAULT_CAREER_AUTONOMY_SETTINGS, {
        guardrails: { minMatchScore: 101 },
      }),
    ).toThrow();
    expect(() =>
      mergeCareerAutonomySettings(DEFAULT_CAREER_AUTONOMY_SETTINGS, { timezone: "Mars/Olympus" }),
    ).toThrow();
  });

  it("kill switch turns autonomous into approval but never touches manual", () => {
    const paused = mergeCareerAutonomySettings(autonomous, {
      killSwitch: true,
      modes: { documents: "manual" },
    });
    expect(effectiveAutonomyMode(paused, "shortlist")).toBe("approval");
    expect(effectiveAutonomyMode(paused, "documents")).toBe("manual");
    expect(effectiveAutonomyMode(autonomous, "submission")).toBe("autonomous");
  });
});

describe("autonomy guardrails", () => {
  const evaluate = (
    overrides: Partial<AutonomyCandidate> = {},
    submissionsToday = 0,
    settings = autonomous,
  ) =>
    evaluateAutonomyGuardrails({
      settings,
      action: "submission",
      candidate: { ...candidate, ...overrides },
      submissionsToday,
    });

  it("allows an action that passes every guardrail", () => {
    expect(evaluate()).toEqual({ allowed: true, blocked: [] });
  });

  it("blocks below the minimum match score, and at an unknown score", () => {
    expect(evaluate({ matchScore: 59 }).blocked.map((b) => b.code)).toEqual([
      "score_below_threshold",
    ]);
    expect(evaluate({ matchScore: 60 }).allowed).toBe(true);
    expect(evaluate({ matchScore: null }).blocked.map((b) => b.code)).toEqual(["score_unknown"]);
  });

  it("enforces the daily submission cap", () => {
    expect(evaluate({}, 1).allowed).toBe(true);
    expect(evaluate({}, 2).blocked.map((b) => b.code)).toEqual(["daily_cap_reached"]);
    // The cap is about submissions only.
    expect(
      evaluateAutonomyGuardrails({
        settings: autonomous,
        action: "shortlist",
        candidate,
        submissionsToday: 99,
      }).allowed,
    ).toBe(true);
  });

  it("blocks excluded companies case- and accent-insensitively", () => {
    expect(evaluate({ organization: "EVIL CORP Europe" }).blocked.map((b) => b.code)).toEqual([
      "excluded_company",
    ]);
    const accented = mergeCareerAutonomySettings(autonomous, {
      guardrails: { excludedCompanies: ["Societe Generale"] },
    });
    expect(evaluate({ organization: "Société Générale" }, 0, accented).allowed).toBe(false);
  });

  it("blocks excluded keywords on word boundaries and excluded contract types", () => {
    expect(evaluate({ description: "This is an UNPAID internship" }).blocked[0]?.code).toBe(
      "excluded_keyword",
    );
    // "unpaid" must not match inside another word.
    expect(evaluate({ description: "unpaidable" }).allowed).toBe(true);
    expect(evaluate({ kind: "freelance" }).blocked.map((b) => b.code)).toEqual([
      "excluded_contract_type",
    ]);
  });

  it("kill switch blocks everything and reports every other reason too", () => {
    const paused = mergeCareerAutonomySettings(autonomous, { killSwitch: true });
    const verdict = evaluate({ matchScore: 10 }, 5, paused);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocked.map((b) => b.code)).toEqual([
      "kill_switch",
      "score_below_threshold",
      "daily_cap_reached",
    ]);
  });

  it("refuses when the action is not in autonomous mode", () => {
    const approval = mergeCareerAutonomySettings(autonomous, { modes: { submission: "approval" } });
    expect(evaluate({}, 0, approval).blocked.map((b) => b.code)).toEqual(["mode_not_autonomous"]);
  });
});

describe("startOfDayInTimezone", () => {
  it("computes the local midnight as a UTC instant", () => {
    const now = new Date("2026-11-09T15:30:00.000Z");
    expect(startOfDayInTimezone(now, "UTC").toISOString()).toBe("2026-11-09T00:00:00.000Z");
    // Paris is UTC+1 in November.
    expect(startOfDayInTimezone(now, "Europe/Paris").toISOString()).toBe(
      "2026-11-08T23:00:00.000Z",
    );
  });
});
