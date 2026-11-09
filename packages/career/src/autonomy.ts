import { z } from "zod";
import { opportunityKindSchema, type OpportunityKind } from "./vocabulary.js";

/**
 * Configurable autonomy for the career pipeline.
 *
 * Every action Nexus can take on the owner's behalf has its own mode:
 *
 *  - `manual`: Nexus does nothing for this action; the owner drives it.
 *  - `approval`: Nexus prepares the action and the owner validates it in one
 *    click. This is the historical behaviour and the default.
 *  - `autonomous`: Nexus executes the action itself, but only inside the
 *    guardrails below. Anything a guardrail refuses falls back to `approval`
 *    rather than being dropped, so the owner still sees it.
 *
 * The kill switch pauses every autonomous action at once without losing the
 * configured modes: while it is on, `autonomous` behaves exactly like
 * `approval`.
 *
 * This module is pure — no I/O, no clock — so the guardrail rules are tested
 * once here and the service only supplies the facts (score, counters, now).
 */

export const AUTONOMOUS_ACTOR = "nexus-autonomous" as const;
export const OWNER_ACTOR = "owner" as const;

export const autonomyModeSchema = z.enum(["manual", "approval", "autonomous"]);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

export const careerAutonomyActionSchema = z.enum(["shortlist", "documents", "submission"]);
export type CareerAutonomyAction = z.infer<typeof careerAutonomyActionSchema>;

const listEntry = z.string().trim().min(1).max(200);

export const careerAutonomyGuardrailsSchema = z
  .object({
    /** Match score (0-100) an opportunity must reach before Nexus acts alone. */
    minMatchScore: z.number().int().min(0).max(100),
    /** Autonomous submissions allowed per calendar day (owner's timezone). */
    maxSubmissionsPerDay: z.number().int().min(0).max(50),
    /** Organisations Nexus must never act on autonomously. Case/accent-insensitive. */
    excludedCompanies: z.array(listEntry).max(200),
    /** Keywords that block autonomy when found in title, description or requirements. */
    excludedKeywords: z.array(listEntry).max(200),
    /** Contract types Nexus must never act on autonomously. */
    excludedContractTypes: z.array(opportunityKindSchema).max(3),
  })
  .strict();
export type CareerAutonomyGuardrails = z.infer<typeof careerAutonomyGuardrailsSchema>;

export const careerAutonomySettingsSchema = z
  .object({
    modes: z
      .object({
        shortlist: autonomyModeSchema,
        documents: autonomyModeSchema,
        submission: autonomyModeSchema,
      })
      .strict(),
    guardrails: careerAutonomyGuardrailsSchema,
    /** Global pause of every autonomous action. */
    killSwitch: z.boolean(),
    /** IANA timezone used to define "per day" for the daily cap. */
    timezone: z.string().trim().min(1).max(64),
  })
  .strict();
export type CareerAutonomySettings = z.infer<typeof careerAutonomySettingsSchema>;

/** Input accepted by PUT: every field optional, merged onto the stored settings. */
export const careerAutonomySettingsPatchSchema = z
  .object({
    modes: careerAutonomySettingsSchema.shape.modes.partial().optional(),
    guardrails: careerAutonomyGuardrailsSchema.partial().optional(),
    killSwitch: z.boolean().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type CareerAutonomySettingsPatch = z.infer<typeof careerAutonomySettingsPatchSchema>;

/** Default = the historical behaviour: Nexus prepares, the owner approves. */
export const DEFAULT_CAREER_AUTONOMY_SETTINGS: CareerAutonomySettings = Object.freeze({
  modes: Object.freeze({ shortlist: "approval", documents: "approval", submission: "approval" }),
  guardrails: Object.freeze({
    minMatchScore: 70,
    maxSubmissionsPerDay: 3,
    excludedCompanies: [],
    excludedKeywords: [],
    excludedContractTypes: [],
  }),
  killSwitch: false,
  timezone: "UTC",
});

export function mergeCareerAutonomySettings(
  current: CareerAutonomySettings,
  patch: CareerAutonomySettingsPatch,
): CareerAutonomySettings {
  const merged = {
    modes: { ...current.modes, ...stripUndefined(patch.modes ?? {}) },
    guardrails: { ...current.guardrails, ...stripUndefined(patch.guardrails ?? {}) },
    killSwitch: patch.killSwitch ?? current.killSwitch,
    timezone: patch.timezone ?? current.timezone,
  };
  if (!isValidTimezone(merged.timezone)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["timezone"],
        message: `Unknown timezone: ${merged.timezone}`,
        input: merged.timezone,
      },
    ]);
  }
  return careerAutonomySettingsSchema.parse(merged);
}

/**
 * The mode actually applied right now.
 *
 * The kill switch never escalates anything: it only turns `autonomous` into
 * `approval`. `manual` stays manual.
 */
export function effectiveAutonomyMode(
  settings: CareerAutonomySettings,
  action: CareerAutonomyAction,
): AutonomyMode {
  const configured = settings.modes[action];
  if (configured === "autonomous" && settings.killSwitch) return "approval";
  return configured;
}

export interface AutonomyCandidate {
  organization: string;
  kind: OpportunityKind;
  title: string;
  description: string;
  requirements: readonly string[];
  /** Match score 0-100, or null when no score could be computed. */
  matchScore: number | null;
}

export type GuardrailCode =
  | "kill_switch"
  | "mode_not_autonomous"
  | "score_below_threshold"
  | "score_unknown"
  | "daily_cap_reached"
  | "excluded_company"
  | "excluded_keyword"
  | "excluded_contract_type";

export interface GuardrailVerdict {
  allowed: boolean;
  /** Every reason that blocked the action; empty when allowed. */
  blocked: { code: GuardrailCode; detail: string }[];
}

/**
 * Decides whether Nexus may perform `action` on `candidate` without asking.
 *
 * Every rule is evaluated (not short-circuited), so the audit trail records
 * all the reasons an action was held back, not just the first one.
 */
export function evaluateAutonomyGuardrails(input: {
  settings: CareerAutonomySettings;
  action: CareerAutonomyAction;
  candidate: AutonomyCandidate;
  /** Autonomous submissions already performed today. Only read for `submission`. */
  submissionsToday: number;
}): GuardrailVerdict {
  const { settings, action, candidate } = input;
  const { guardrails } = settings;
  const blocked: GuardrailVerdict["blocked"] = [];

  if (settings.killSwitch) {
    blocked.push({ code: "kill_switch", detail: "The autonomy kill switch is on." });
  }
  if (settings.modes[action] !== "autonomous") {
    blocked.push({
      code: "mode_not_autonomous",
      detail: `The ${action} action is configured as ${settings.modes[action]}.`,
    });
  }

  if (candidate.matchScore === null) {
    blocked.push({ code: "score_unknown", detail: "No match score is available." });
  } else if (candidate.matchScore < guardrails.minMatchScore) {
    blocked.push({
      code: "score_below_threshold",
      detail: `Match score ${String(candidate.matchScore)} is below the minimum ${String(guardrails.minMatchScore)}.`,
    });
  }

  if (action === "submission" && input.submissionsToday >= guardrails.maxSubmissionsPerDay) {
    blocked.push({
      code: "daily_cap_reached",
      detail: `Daily cap of ${String(guardrails.maxSubmissionsPerDay)} autonomous submission(s) reached.`,
    });
  }

  const organization = normalize(candidate.organization);
  const company = guardrails.excludedCompanies.find((entry) => {
    const needle = normalize(entry);
    return needle.length > 0 && organization.includes(needle);
  });
  if (company !== undefined) {
    blocked.push({ code: "excluded_company", detail: `Company "${company}" is excluded.` });
  }

  const haystack = normalize(
    [candidate.title, candidate.description, ...candidate.requirements].join(" \n "),
  );
  const keyword = guardrails.excludedKeywords.find((entry) => {
    const needle = normalize(entry);
    return needle.length > 0 && containsWord(haystack, needle);
  });
  if (keyword !== undefined) {
    blocked.push({ code: "excluded_keyword", detail: `Keyword "${keyword}" is excluded.` });
  }

  if (guardrails.excludedContractTypes.includes(candidate.kind)) {
    blocked.push({
      code: "excluded_contract_type",
      detail: `Contract type ${candidate.kind} is excluded.`,
    });
  }

  return { allowed: blocked.length === 0, blocked };
}

/**
 * Start of the calendar day containing `now`, in `timezone`, as a UTC instant.
 * Used for the daily submission cap.
 */
export function startOfDayInTimezone(now: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const elapsedMs =
    ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1_000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - elapsedMs);
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(haystack);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
