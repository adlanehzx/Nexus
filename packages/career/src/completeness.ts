import type { CareerProfile } from "./model.js";
import type { OpportunityKind } from "./vocabulary.js";

/**
 * Profile completeness, and what it is for.
 *
 * Two different questions hide behind "is my profile complete", and answering
 * only one of them is why completeness meters are usually useless:
 *
 *  - **How much is filled in?** A percentage. Motivating, and harmless if
 *    ignored.
 *  - **What can I not do yet?** A list of blockers. Drafting a doctoral
 *    application with no research area stated does not produce a worse
 *    document, it produces a document that cannot be written, and the owner
 *    should learn that *before* spending an evening on a shortlist.
 *
 * So this returns both, and the blockers are keyed by opportunity kind, because
 * the answer genuinely differs: publications and a research area matter for a
 * doctoral application and are noise for a freelance engagement.
 */

export interface CompletenessGap {
  field: string;
  /** Why it matters, in one sentence. Shown as-is. */
  reason: string;
  weight: number;
}

export interface CompletenessReport {
  /** 0 to 100, integer. */
  score: number;
  /** Unfilled fields, heaviest first. */
  gaps: CompletenessGap[];
  /**
   * Kinds the profile cannot yet support, with the reason.
   *
   * A kind absent from this record is ready. Keyed by kind rather than returned
   * as a flat list so a caller can answer "can I draft *this* application"
   * without re-deriving the rule.
   */
  blockedKinds: Partial<Record<OpportunityKind, string[]>>;
  /** True when no kind is blocked. */
  readyToDraft: boolean;
}

interface Requirement {
  field: string;
  reason: string;
  weight: number;
  satisfied: (profile: CareerProfile) => boolean;
}

const REQUIREMENTS: readonly Requirement[] = [
  {
    field: "headline",
    reason: "The headline is the first line of every tailored document.",
    weight: 15,
    satisfied: (profile) => profile.headline.trim().length >= 8,
  },
  {
    field: "summary",
    reason: "Without a summary, a cover letter has nothing to draw on.",
    weight: 15,
    satisfied: (profile) => profile.summary.trim().length >= 80,
  },
  {
    field: "skills",
    reason: "Skills drive the match factors; fewer than three makes ranking guesswork.",
    weight: 20,
    satisfied: (profile) => profile.skills.length >= 3,
  },
  {
    field: "languages",
    reason: "Language ability decides eligibility for many listings.",
    weight: 10,
    satisfied: (profile) => profile.languages.length >= 1,
  },
  {
    field: "preferences.kinds",
    reason: "Without a declared kind, nothing can be ranked.",
    weight: 15,
    satisfied: (profile) => profile.preferences.kinds.length >= 1,
  },
  {
    field: "preferences.mustHaveSkills",
    reason: "Required skills are what separate a shortlist from a list.",
    weight: 10,
    satisfied: (profile) => profile.preferences.mustHaveSkills.length >= 1,
  },
  {
    field: "preferences.locations",
    reason: "A location or an explicit remote preference is needed to score location fit.",
    weight: 10,
    satisfied: (profile) =>
      profile.preferences.locations.length >= 1 || profile.preferences.remote !== "no_preference",
  },
  {
    field: "preferences.researchAreas",
    reason: "Doctoral matching needs at least one research area.",
    weight: 5,
    satisfied: (profile) =>
      !profile.preferences.kinds.includes("phd") || profile.preferences.researchAreas.length >= 1,
  },
];

/**
 * Blocking rules, per kind.
 *
 * Deliberately short. Every entry here is a refusal to proceed, and a long list
 * of refusals is indistinguishable from a broken feature — so a field belongs
 * here only when the document genuinely cannot be written without it, and in
 * `REQUIREMENTS` otherwise.
 */
const BLOCKERS: Readonly<Record<OpportunityKind, readonly Requirement[]>> = {
  phd: [
    {
      field: "preferences.researchAreas",
      reason: "A research statement cannot be tailored without a stated research area.",
      weight: 0,
      satisfied: (profile) => profile.preferences.researchAreas.length >= 1,
    },
    {
      field: "highestDegree",
      reason: "A doctoral application needs the highest degree obtained.",
      weight: 0,
      satisfied: (profile) => profile.highestDegree !== "none",
    },
  ],
  permanent_job: [
    {
      field: "summary",
      reason: "A cover letter needs a summary of at least 80 characters.",
      weight: 0,
      satisfied: (profile) => profile.summary.trim().length >= 80,
    },
    {
      field: "skills",
      reason: "A CV variant needs at least three skills.",
      weight: 0,
      satisfied: (profile) => profile.skills.length >= 3,
    },
  ],
  freelance: [
    {
      field: "skills",
      reason: "A freelance proposal needs at least three skills.",
      weight: 0,
      satisfied: (profile) => profile.skills.length >= 3,
    },
  ],
};

export function assessCompleteness(profile: CareerProfile): CompletenessReport {
  const gaps: CompletenessGap[] = [];
  let earned = 0;
  let total = 0;

  for (const requirement of REQUIREMENTS) {
    total += requirement.weight;
    if (requirement.satisfied(profile)) {
      earned += requirement.weight;
    } else {
      gaps.push({
        field: requirement.field,
        reason: requirement.reason,
        weight: requirement.weight,
      });
    }
  }

  const blockedKinds: Partial<Record<OpportunityKind, string[]>> = {};
  for (const kind of profile.preferences.kinds) {
    const unmet = BLOCKERS[kind]
      .filter((blocker) => !blocker.satisfied(profile))
      .map((blocker) => `${blocker.field}: ${blocker.reason}`);
    if (unmet.length > 0) blockedKinds[kind] = unmet;
  }

  return {
    score: total === 0 ? 0 : Math.round((earned / total) * 100),
    gaps: gaps.sort((left, right) => right.weight - left.weight),
    blockedKinds,
    readyToDraft: Object.keys(blockedKinds).length === 0,
  };
}

/**
 * Whether a document may be drafted for one kind.
 *
 * Returns the reasons rather than a boolean: a caller that refuses has to tell
 * the owner what to fix, and re-deriving the reasons at the call site is how
 * the message ends up saying "profile incomplete".
 */
export function draftingBlockers(profile: CareerProfile, kind: OpportunityKind): string[] {
  return BLOCKERS[kind]
    .filter((blocker) => !blocker.satisfied(profile))
    .map((blocker) => `${blocker.field}: ${blocker.reason}`);
}
