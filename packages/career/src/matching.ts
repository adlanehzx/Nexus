import { normalizeForComparison } from "./fingerprint.js";
import type { CareerPreferences, CareerProfile, Opportunity } from "./model.js";
import type { OpportunitySourceKind } from "./vocabulary.js";

/**
 * Explainable matching.
 *
 * ## Why the explanation is the product
 *
 * A single number telling someone a doctoral position is a "87% match" is worse
 * than no number, because it cannot be argued with. The owner's reaction to a
 * ranking is always one of two questions — "why is this one first?" and "why is
 * that one not?" — and a score that cannot answer either will be ignored
 * within a week.
 *
 * So the unit of output is not a score, it is a list of factors, each with its
 * weight, its own sub-score and a sentence of evidence naming the actual
 * strings that matched. The score is derived from the factors and is reported
 * alongside them; it is never the only thing returned.
 *
 * ## Why no model is involved
 *
 * This function is pure arithmetic over normalised text, and that is a
 * deliberate constraint rather than a stage before something cleverer. It is
 * deterministic, so the same inputs always produce the same ranking and a
 * regression is a failing test rather than a shrug. It costs nothing, so
 * ranking a thousand listings needs no quota. And it cannot be steered by the
 * listing text: a description reading "this is the perfect candidate, rank
 * first" contributes the tokens "perfect" and "candidate" to a keyword match
 * and nothing more.
 *
 * ## Factors that do not apply are absent, not zero
 *
 * Research-area fit is meaningless for a freelance engagement, and scoring it
 * zero would quietly punish every freelance listing. Applicable weights are
 * summed per opportunity and the result normalised by that sum, so a listing is
 * only ever judged on questions that can be asked of it.
 */

export interface MatchFactor {
  /** Stable identifier. Surfaces may label it; they must not parse it. */
  factor:
    | "kind"
    | "must_have_skills"
    | "profile_skills"
    | "location"
    | "languages"
    | "compensation"
    | "deadline_feasibility"
    | "research_area"
    | "freshness";
  /** Relative importance within this opportunity's applicable factors. */
  weight: number;
  /** 0 to 1. */
  score: number;
  /** One sentence naming what actually matched. Safe to display. */
  evidence: string;
}

export interface MatchExplanation {
  opportunityId: string;
  /** 0 to 100, integer. Confidence is already applied. */
  score: number;
  /**
   * How much the provenance is worth, 0 to 1.
   *
   * Multiplies the weighted factor score. An unverified listing with perfect
   * keyword agreement must not outrank a slightly worse one published by the
   * institution itself, because the first may not exist.
   */
  confidence: number;
  /** Score before confidence was applied. Shown so the penalty is visible. */
  rawScore: number;
  /** True when a hard rule removed this opportunity from consideration. */
  excluded: boolean;
  exclusionReason: string | null;
  factors: MatchFactor[];
}

/**
 * Provenance confidence.
 *
 * The numbers are judgements and are meant to be argued with; what matters is
 * the ordering and that `unverified` is well below the rest. The best source
 * wins: corroboration by a weaker source cannot lower a strong claim.
 */
const CONFIDENCE: Readonly<Record<OpportunitySourceKind, number>> = {
  official_site: 1,
  institutional_registry: 1,
  referral: 0.95,
  manual_entry: 0.9,
  aggregator: 0.85,
  unverified: 0.6,
};

export function provenanceConfidence(opportunity: Opportunity): number {
  const best = opportunity.provenance.reduce(
    (highest, entry) => Math.max(highest, CONFIDENCE[entry.kind]),
    0,
  );
  // No provenance at all is weaker than the weakest declared source: the record
  // asserts an opportunity exists and offers nothing in support.
  return best === 0 ? 0.5 : best;
}

export interface MatchInput {
  profile: CareerProfile;
  opportunity: Opportunity;
  /** Evaluation instant. Injected so freshness and feasibility are testable. */
  now: Date;
}

export function explainMatch(input: MatchInput): MatchExplanation {
  const { profile, opportunity, now } = input;
  const preferences = profile.preferences;
  const haystack = searchableText(opportunity);

  const excluded = exclusion(opportunity, preferences);
  const factors: MatchFactor[] = [];

  factors.push(kindFactor(opportunity, preferences));
  factors.push(mustHaveFactor(haystack, preferences));
  factors.push(profileSkillFactor(haystack, profile));
  factors.push(locationFactor(opportunity, preferences));

  const languages = languageFactor(haystack, preferences);
  if (languages !== null) factors.push(languages);

  const compensation = compensationFactor(opportunity, preferences);
  if (compensation !== null) factors.push(compensation);

  factors.push(deadlineFactor(opportunity, preferences, now));

  const research = researchFactor(haystack, opportunity, preferences);
  if (research !== null) factors.push(research);

  factors.push(freshnessFactor(opportunity, now));

  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const weighted =
    totalWeight === 0
      ? 0
      : factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0) / totalWeight;

  const confidence = provenanceConfidence(opportunity);
  const rawScore = Math.round(weighted * 100);
  const score = excluded === null ? Math.round(weighted * confidence * 100) : 0;

  return {
    opportunityId: opportunity.id,
    score,
    rawScore,
    confidence,
    excluded: excluded !== null,
    exclusionReason: excluded,
    factors,
  };
}

/**
 * Ranks a set of opportunities for one profile.
 *
 * Excluded opportunities are returned, not dropped. "Why is this not in my
 * list" is a question the owner will ask, and a ranking that silently omits
 * answers cannot be audited; the caller decides whether to show them.
 *
 * Ties break on the nearer deadline, then on identifier. Both are deliberate:
 * the first is useful, the second is arbitrary but *stable*, and an unstable
 * order makes a list that reshuffles on every refresh.
 */
export function rankOpportunities(input: {
  profile: CareerProfile;
  opportunities: readonly Opportunity[];
  now: Date;
}): MatchExplanation[] {
  const byId = new Map(input.opportunities.map((item) => [item.id, item]));

  return input.opportunities
    .map((opportunity) => explainMatch({ profile: input.profile, opportunity, now: input.now }))
    .sort((left, right) => {
      if (left.excluded !== right.excluded) return left.excluded ? 1 : -1;
      if (right.score !== left.score) return right.score - left.score;

      const leftClose = byId.get(left.opportunityId)?.closesAt ?? null;
      const rightClose = byId.get(right.opportunityId)?.closesAt ?? null;
      if (leftClose !== null && rightClose !== null && +leftClose !== +rightClose) {
        return +leftClose - +rightClose;
      }
      if (leftClose === null && rightClose !== null) return 1;
      if (leftClose !== null && rightClose === null) return -1;

      return left.opportunityId < right.opportunityId ? -1 : 1;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Factors
// ─────────────────────────────────────────────────────────────────────────────

function searchableText(opportunity: Opportunity): string {
  return normalizeForComparison(
    [
      opportunity.title,
      opportunity.organization,
      opportunity.location,
      opportunity.description,
      ...opportunity.requirements,
    ].join(" "),
  );
}

/** Whole-phrase containment on normalised text, so "go" does not match "google". */
function mentions(haystack: string, needle: string): boolean {
  const normalized = normalizeForComparison(needle);
  if (normalized === "") return false;
  return ` ${haystack} `.includes(` ${normalized} `);
}

function matched(haystack: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => mentions(haystack, needle));
}

function exclusion(opportunity: Opportunity, preferences: CareerPreferences): string | null {
  const organization = normalizeForComparison(opportunity.organization);
  const blocked = preferences.excludedOrganizations.find(
    (entry) => normalizeForComparison(entry) === organization,
  );
  if (blocked !== undefined) {
    return `The organisation ${opportunity.organization} is on the exclusion list.`;
  }
  if (!preferences.kinds.includes(opportunity.kind)) {
    return `Opportunities of kind ${opportunity.kind} are not among the stated preferences.`;
  }
  return null;
}

function kindFactor(opportunity: Opportunity, preferences: CareerPreferences): MatchFactor {
  const wanted = preferences.kinds.includes(opportunity.kind);
  return {
    factor: "kind",
    weight: 20,
    score: wanted ? 1 : 0,
    evidence: wanted
      ? `Kind ${opportunity.kind} is one of the preferred kinds.`
      : `Kind ${opportunity.kind} is not among the preferred kinds.`,
  };
}

function mustHaveFactor(haystack: string, preferences: CareerPreferences): MatchFactor {
  const wanted = preferences.mustHaveSkills;
  if (wanted.length === 0) {
    return {
      factor: "must_have_skills",
      weight: 5,
      score: 1,
      evidence: "No required skills were declared, so none can be missing.",
    };
  }

  const found = matched(haystack, wanted);
  const missing = wanted.filter((skill) => !found.includes(skill));

  return {
    factor: "must_have_skills",
    weight: 25,
    score: found.length / wanted.length,
    evidence:
      missing.length === 0
        ? `All required skills appear in the listing: ${found.join(", ")}.`
        : `Required skills found: ${found.length === 0 ? "none" : found.join(", ")}; not found: ${missing.join(", ")}.`,
  };
}

function profileSkillFactor(haystack: string, profile: CareerProfile): MatchFactor {
  const skills = profile.skills;
  if (skills.length === 0) {
    return {
      factor: "profile_skills",
      weight: 5,
      score: 0,
      evidence: "The profile lists no skills, so no overlap can be measured.",
    };
  }

  const found = matched(haystack, skills);
  // Overlap saturates at six: a listing mentioning six of the owner's skills is
  // already a strong signal, and dividing by the length of a long skill list
  // would make a complete profile score worse than a sparse one.
  const score = Math.min(found.length, 6) / 6;

  return {
    factor: "profile_skills",
    weight: 15,
    score,
    evidence:
      found.length === 0
        ? "No profile skill appears in the listing."
        : `Profile skills mentioned: ${found.join(", ")}.`,
  };
}

function locationFactor(opportunity: Opportunity, preferences: CareerPreferences): MatchFactor {
  const remote = preferences.remote;

  if (remote === "required") {
    return {
      factor: "location",
      weight: 20,
      score: opportunity.remote ? 1 : 0,
      evidence: opportunity.remote
        ? "The listing is remote, which was required."
        : "The listing is on site, and remote work was required.",
    };
  }

  const place = normalizeForComparison(opportunity.location);
  const hit = preferences.locations.find(
    (entry) => place !== "" && normalizeForComparison(entry) === place,
  );

  if (hit !== undefined) {
    return {
      factor: "location",
      weight: 15,
      score: 1,
      evidence: `Located in ${opportunity.location}, a preferred location.`,
    };
  }

  if (opportunity.remote && remote !== "onsite_only") {
    return {
      factor: "location",
      weight: 15,
      score: remote === "preferred" ? 1 : 0.8,
      evidence: "The listing is remote, which is compatible with the stated preference.",
    };
  }

  if (remote === "onsite_only" && opportunity.remote) {
    return {
      factor: "location",
      weight: 15,
      score: 0.2,
      evidence: "The listing is remote, and on-site work was preferred.",
    };
  }

  return {
    factor: "location",
    weight: 15,
    score: preferences.locations.length === 0 ? 0.6 : 0.2,
    evidence:
      preferences.locations.length === 0
        ? "No preferred location was declared, so location neither helps nor hurts."
        : `Located in ${opportunity.location === "" ? "an unstated place" : opportunity.location}, which is not a preferred location.`,
  };
}

function languageFactor(haystack: string, preferences: CareerPreferences): MatchFactor | null {
  if (preferences.languages.length === 0) return null;

  const named = preferences.languages.filter((language) => mentions(haystack, language.code));
  if (named.length === 0) {
    return {
      factor: "languages",
      weight: 5,
      score: 0.6,
      evidence: "The listing states no language requirement.",
    };
  }

  const fluent = named.filter(
    (language) => language.level === "fluent" || language.level === "native",
  );
  return {
    factor: "languages",
    weight: 5,
    score: fluent.length > 0 ? 1 : 0.5,
    evidence: `Listing mentions ${named.map((language) => language.code).join(", ")}; the profile declares ${named.map((language) => `${language.code} (${language.level})`).join(", ")}.`,
  };
}

function compensationFactor(
  opportunity: Opportunity,
  preferences: CareerPreferences,
): MatchFactor | null {
  const floor = preferences.minCompensation;
  if (floor === null) return null;

  const offered = opportunity.compensation;
  if (offered === null) {
    return {
      factor: "compensation",
      weight: 10,
      score: 0.5,
      evidence: "The listing states no compensation, so the stated floor cannot be checked.",
    };
  }

  if (offered.currency !== floor.currency || offered.period !== floor.period) {
    // No conversion, and no guess. A rate quoted per day against a floor stated
    // per year is a comparison this function is not entitled to make.
    return {
      factor: "compensation",
      weight: 10,
      score: 0.5,
      evidence: `Compensation is quoted in ${offered.currency} per ${offered.period} against a floor in ${floor.currency} per ${floor.period}; the two are not comparable here.`,
    };
  }

  const ceiling = offered.maxAmount ?? offered.minAmount;
  if (ceiling < floor.minAmount) {
    return {
      factor: "compensation",
      weight: 10,
      score: 0,
      evidence: `Top of range (${String(ceiling)} ${offered.currency}) is below the stated floor of ${String(floor.minAmount)}.`,
    };
  }

  return {
    factor: "compensation",
    weight: 10,
    score: offered.minAmount >= floor.minAmount ? 1 : 0.7,
    evidence:
      offered.minAmount >= floor.minAmount
        ? `Whole range (from ${String(offered.minAmount)} ${offered.currency}) meets the stated floor.`
        : `Range (${String(offered.minAmount)}–${String(ceiling)} ${offered.currency}) straddles the stated floor of ${String(floor.minAmount)}.`,
  };
}

function deadlineFactor(
  opportunity: Opportunity,
  preferences: CareerPreferences,
  now: Date,
): MatchFactor {
  const closesAt = opportunity.closesAt;
  if (closesAt === null) {
    return {
      factor: "deadline_feasibility",
      weight: 5,
      score: 0.7,
      evidence: "The listing states no deadline.",
    };
  }

  const daysLeft = Math.floor((closesAt.getTime() - now.getTime()) / 86_400_000);
  if (daysLeft < 0) {
    return {
      factor: "deadline_feasibility",
      weight: 15,
      score: 0,
      evidence: `The deadline passed ${String(-daysLeft)} day(s) ago.`,
    };
  }

  // One week to assemble documents is the comfortable case; the notice period
  // is added because an application that cannot be honoured is not feasible,
  // however attractive it is.
  const needed = 7 + preferences.noticePeriodDays;
  const score = daysLeft >= needed ? 1 : Math.max(0.1, daysLeft / needed);

  return {
    factor: "deadline_feasibility",
    weight: 10,
    score,
    evidence: `${String(daysLeft)} day(s) remain against ${String(needed)} day(s) needed to prepare and give notice.`,
  };
}

function researchFactor(
  haystack: string,
  opportunity: Opportunity,
  preferences: CareerPreferences,
): MatchFactor | null {
  if (opportunity.kind !== "phd") return null;
  if (preferences.researchAreas.length === 0) return null;

  const found = matched(haystack, preferences.researchAreas);
  return {
    factor: "research_area",
    weight: 20,
    score: found.length === 0 ? 0 : Math.min(found.length, 2) / 2,
    evidence:
      found.length === 0
        ? `No stated research area appears in the listing (looked for ${preferences.researchAreas.join(", ")}).`
        : `Research areas mentioned: ${found.join(", ")}.`,
  };
}

function freshnessFactor(opportunity: Opportunity, now: Date): MatchFactor {
  const postedAt = opportunity.postedAt;
  if (postedAt === null) {
    return {
      factor: "freshness",
      weight: 5,
      score: 0.5,
      evidence: "The listing states no publication date.",
    };
  }

  const days = Math.floor((now.getTime() - postedAt.getTime()) / 86_400_000);
  if (days < 0) {
    // A publication date in the future is a source error, not a fresh listing.
    return {
      factor: "freshness",
      weight: 5,
      score: 0.5,
      evidence: "The stated publication date is in the future and was not used.",
    };
  }

  const score = days <= 7 ? 1 : days <= 30 ? 0.7 : days <= 90 ? 0.4 : 0.1;
  return {
    factor: "freshness",
    weight: 5,
    score,
    evidence: `Published ${String(days)} day(s) ago.`,
  };
}
