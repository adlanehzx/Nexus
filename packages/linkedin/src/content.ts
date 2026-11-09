import { z } from "zod";

/**
 * LinkedIn content management on the member's behalf: configuration and the
 * pure rules (schedule, weekly cap, hashtag policy, engagement rate limits,
 * active hours, consent gate). No I/O and no clock here — callers pass `now`
 * and a random source, so every rule is deterministic under test.
 *
 * ## Two execution channels, deliberately separate
 *
 *  - **Posts** go through LinkedIn's official Posts API (`w_member_social`),
 *    via `LinkedInClient.createTextPost`.
 *  - **Reactions and comments on other members' content** are not available to
 *    personal accounts through the official API. They go through a pluggable
 *    engagement executor (browser automation). Doing that unattended violates
 *    LinkedIn's User Agreement, so `autonomous` mode for those actions is
 *    refused until the member has explicitly accepted that risk.
 */

export const LINKEDIN_AUTONOMOUS_ACTOR = "nexus-autonomous" as const;
export const LINKEDIN_OWNER_ACTOR = "owner" as const;

/** Bumped whenever the warning text changes, so an old consent no longer counts. */
export const LINKEDIN_AUTOMATION_CONSENT_VERSION = 1;

export const LINKEDIN_AUTOMATION_WARNING =
  "Autonomous reactions and comments are executed by browser automation on your " +
  "personal LinkedIn account. This violates the LinkedIn User Agreement (section 8.2, " +
  "automated access) and may lead to your account being restricted or permanently " +
  "banned. You accept this risk by enabling it.";

export const linkedInAutonomyModeSchema = z.enum(["manual", "approval", "autonomous"]);
export type LinkedInAutonomyMode = z.infer<typeof linkedInAutonomyModeSchema>;

export const linkedInContentActionSchema = z.enum(["publishPost", "react", "comment"]);
export type LinkedInContentAction = z.infer<typeof linkedInContentActionSchema>;

/** LinkedIn's reaction vocabulary, as the UI names them in parentheses. */
export const linkedInReactionTypeSchema = z.enum([
  "LIKE",
  "PRAISE", // celebrate
  "EMPATHY", // love
  "INTEREST", // insightful
  "APPRECIATION", // support
  "ENTERTAINMENT", // funny
]);
export type LinkedInReactionType = z.infer<typeof linkedInReactionTypeSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM (24h)");
const tag = z
  .string()
  .trim()
  .regex(/^#?[\p{L}\p{N}_]{1,60}$/u, "Hashtags are letters, digits or underscores")
  .transform((value) => (value.startsWith("#") ? value.slice(1) : value));

export const linkedInPostConfigSchema = z
  .object({
    topics: z.array(z.string().trim().min(1).max(120)).max(30),
    /** Tone and voice, free text given to the drafter ("warm, concise, first person"). */
    tone: z.string().trim().max(300),
    /** BCP-47 language the posts are written in. */
    language: z.string().trim().min(2).max(16),
    visibility: z.enum(["PUBLIC", "CONNECTIONS"]),
    schedule: z
      .object({
        /** 0 = Sunday ... 6 = Saturday. */
        daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
        times: z.array(hhmm).min(1).max(6),
        timezone: z.string().trim().min(1).max(64),
      })
      .strict(),
    hashtags: z
      .object({
        policy: z.enum(["none", "fixed", "generated", "fixed_and_generated"]),
        fixed: z.array(tag).max(10),
        maxPerPost: z.number().int().min(0).max(10),
      })
      .strict(),
    maxPostsPerWeek: z.number().int().min(0).max(21),
    /** How far ahead Nexus drafts posts for upcoming slots. */
    draftLeadHours: z.number().int().min(1).max(168),
  })
  .strict();
export type LinkedInPostConfig = z.infer<typeof linkedInPostConfigSchema>;

export const linkedInEngagementConfigSchema = z
  .object({
    maxActionsPerHour: z.number().int().min(0).max(30),
    maxActionsPerDay: z.number().int().min(0).max(200),
    /** Random human-like delay before each autonomous action. */
    minDelaySeconds: z.number().int().min(0).max(3_600),
    maxDelaySeconds: z.number().int().min(0).max(7_200),
    activeHours: z
      .object({ start: hhmm, end: hhmm, timezone: z.string().trim().min(1).max(64) })
      .strict(),
    defaultReaction: linkedInReactionTypeSchema,
    /** Topics used when Nexus looks for content to engage with. */
    topics: z.array(z.string().trim().min(1).max(120)).max(30),
  })
  .strict()
  .refine((value) => value.maxDelaySeconds >= value.minDelaySeconds, {
    message: "maxDelaySeconds must be greater than or equal to minDelaySeconds",
    path: ["maxDelaySeconds"],
  });
export type LinkedInEngagementConfig = z.infer<typeof linkedInEngagementConfigSchema>;

export const linkedInContentSettingsSchema = z
  .object({
    modes: z
      .object({
        publishPost: linkedInAutonomyModeSchema,
        react: linkedInAutonomyModeSchema,
        comment: linkedInAutonomyModeSchema,
      })
      .strict(),
    posts: linkedInPostConfigSchema,
    engagement: linkedInEngagementConfigSchema,
    /** Global pause of every autonomous LinkedIn action. */
    killSwitch: z.boolean(),
  })
  .strict();
export type LinkedInContentSettings = z.infer<typeof linkedInContentSettingsSchema>;

export const linkedInContentSettingsPatchSchema = z
  .object({
    modes: linkedInContentSettingsSchema.shape.modes.partial().optional(),
    posts: linkedInPostConfigSchema.partial().optional(),
    engagement: z
      .object({
        maxActionsPerHour: z.number().int().optional(),
        maxActionsPerDay: z.number().int().optional(),
        minDelaySeconds: z.number().int().optional(),
        maxDelaySeconds: z.number().int().optional(),
        activeHours: z
          .object({ start: hhmm, end: hhmm, timezone: z.string().trim().min(1).max(64) })
          .strict()
          .optional(),
        defaultReaction: linkedInReactionTypeSchema.optional(),
        topics: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
      })
      .strict()
      .optional(),
    killSwitch: z.boolean().optional(),
  })
  .strict();
export type LinkedInContentSettingsPatch = z.infer<typeof linkedInContentSettingsPatchSchema>;

/** Conservative defaults: everything needs the member's approval. */
export const DEFAULT_LINKEDIN_CONTENT_SETTINGS: LinkedInContentSettings = {
  modes: { publishPost: "approval", react: "approval", comment: "approval" },
  posts: {
    topics: [],
    tone: "Professional, concise, first person",
    language: "fr",
    visibility: "PUBLIC",
    schedule: { daysOfWeek: [2, 4], times: ["09:00"], timezone: "Europe/Paris" },
    hashtags: { policy: "generated", fixed: [], maxPerPost: 3 },
    maxPostsPerWeek: 2,
    draftLeadHours: 48,
  },
  engagement: {
    maxActionsPerHour: 5,
    maxActionsPerDay: 20,
    minDelaySeconds: 45,
    maxDelaySeconds: 240,
    activeHours: { start: "09:00", end: "19:00", timezone: "Europe/Paris" },
    defaultReaction: "LIKE",
    topics: [],
  },
  killSwitch: false,
};

export interface LinkedInAutomationConsent {
  acceptedAt: Date | null;
  version: number | null;
}

export function hasValidAutomationConsent(consent: LinkedInAutomationConsent): boolean {
  return consent.acceptedAt !== null && consent.version === LINKEDIN_AUTOMATION_CONSENT_VERSION;
}

export class LinkedInConsentRequiredError extends Error {
  readonly actions: LinkedInContentAction[];
  constructor(actions: LinkedInContentAction[]) {
    super(
      `Autonomous ${actions.join(" and ")} requires explicit acceptance of the LinkedIn automation risk first.`,
    );
    this.name = "LinkedInConsentRequiredError";
    this.actions = actions;
  }
}

/**
 * Merges a patch onto the stored settings and validates the result.
 *
 * @throws {LinkedInConsentRequiredError} when the result would make reactions
 *   or comments autonomous without a valid consent on file.
 */
export function mergeLinkedInContentSettings(
  current: LinkedInContentSettings,
  patch: LinkedInContentSettingsPatch,
  consent: LinkedInAutomationConsent,
): LinkedInContentSettings {
  const merged = linkedInContentSettingsSchema.parse({
    modes: { ...current.modes, ...defined(patch.modes) },
    posts: {
      ...current.posts,
      ...defined(patch.posts),
    },
    engagement: { ...current.engagement, ...defined(patch.engagement) },
    killSwitch: patch.killSwitch ?? current.killSwitch,
  });
  for (const zone of [merged.posts.schedule.timezone, merged.engagement.activeHours.timezone]) {
    if (!validTimezone(zone)) {
      throw new z.ZodError([
        { code: "custom", path: ["timezone"], message: `Unknown timezone: ${zone}`, input: zone },
      ]);
    }
  }
  const needsConsent = (["react", "comment"] as const).filter(
    (action) => merged.modes[action] === "autonomous",
  );
  if (needsConsent.length > 0 && !hasValidAutomationConsent(consent)) {
    throw new LinkedInConsentRequiredError([...needsConsent]);
  }
  return merged;
}

/**
 * The mode applied right now. The kill switch and a missing consent only ever
 * downgrade `autonomous` to `approval`; they never escalate anything.
 */
export function effectiveLinkedInMode(
  settings: LinkedInContentSettings,
  action: LinkedInContentAction,
  consent: LinkedInAutomationConsent,
): LinkedInAutonomyMode {
  const configured = settings.modes[action];
  if (configured !== "autonomous") return configured;
  if (settings.killSwitch) return "approval";
  if (action !== "publishPost" && !hasValidAutomationConsent(consent)) return "approval";
  return "autonomous";
}

// ── Posting schedule ─────────────────────────────────────────────────────────

/** Upcoming posting slots in `[from, until)`, in chronological order. */
export function upcomingPostSlots(
  schedule: LinkedInPostConfig["schedule"],
  from: Date,
  until: Date,
): Date[] {
  if (schedule.daysOfWeek.length === 0) return [];
  const slots: Date[] = [];
  // Walk local calendar days; 9 days covers any `draftLeadHours` <= 168 plus DST.
  const days = Math.ceil((until.getTime() - from.getTime()) / 86_400_000) + 2;
  const startLocal = localParts(from, schedule.timezone);
  for (let offset = -1; offset <= days; offset += 1) {
    const day = new Date(Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day + offset));
    if (!schedule.daysOfWeek.includes(day.getUTCDay())) continue;
    for (const time of schedule.times) {
      const [hour, minute] = time.split(":").map(Number) as [number, number];
      const instant = zonedToUtc(
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        hour,
        minute,
        schedule.timezone,
      );
      if (instant >= from && instant < until) slots.push(instant);
    }
  }
  return slots.sort((left, right) => +left - +right);
}

/**
 * Whether one more post at `at` stays within `maxPostsPerWeek`, counting the
 * posts already published or scheduled in the rolling 7 days around it.
 */
export function withinWeeklyPostCap(input: {
  maxPostsPerWeek: number;
  at: Date;
  /** Publication or scheduled times of posts that count against the cap. */
  existing: readonly Date[];
}): boolean {
  const week = 7 * 86_400_000;
  const windowCount = input.existing.filter(
    (time) => Math.abs(time.getTime() - input.at.getTime()) < week,
  ).length;
  return windowCount < input.maxPostsPerWeek;
}

// ── Hashtags ─────────────────────────────────────────────────────────────────

/**
 * Applies the hashtag policy to a drafted post.
 *
 * Hashtags already in the body are stripped first, so the policy — not the
 * drafter — decides what ends up on the post.
 */
export function applyHashtagPolicy(
  text: string,
  policy: LinkedInPostConfig["hashtags"],
  generated: readonly string[],
): string {
  const body = text
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const candidates: string[] = [];
  if (policy.policy === "fixed" || policy.policy === "fixed_and_generated") {
    candidates.push(...policy.fixed);
  }
  if (policy.policy === "generated" || policy.policy === "fixed_and_generated") {
    candidates.push(...generated);
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of candidates) {
    const cleaned = raw.replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    const key = cleaned.toLowerCase();
    if (cleaned.length === 0 || seen.has(key)) continue;
    seen.add(key);
    tags.push(`#${cleaned}`);
    if (tags.length >= policy.maxPerPost) break;
  }
  if (policy.policy === "none" || tags.length === 0) return body;
  return `${body}\n\n${tags.join(" ")}`;
}

// ── Engagement rate limiting ─────────────────────────────────────────────────

export function isWithinActiveHours(
  window: LinkedInEngagementConfig["activeHours"],
  now: Date,
): boolean {
  const local = localParts(now, window.timezone);
  const minutes = local.hour * 60 + local.minute;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export type EngagementBlockCode =
  "kill_switch" | "outside_active_hours" | "hourly_limit" | "daily_limit" | "consent_missing";

export interface EngagementRateVerdict {
  allowed: boolean;
  code?: EngagementBlockCode;
  reason?: string;
  /** Earliest instant at which trying again could succeed. */
  retryAt?: Date;
}

/**
 * Whether one more autonomous engagement may run at `now`.
 *
 * `recent` are the execution times of engagements already performed (any
 * actor: a reaction the member approved by hand still counts towards what
 * LinkedIn sees from the account).
 */
export function checkEngagementRateLimit(input: {
  settings: LinkedInContentSettings;
  consent: LinkedInAutomationConsent;
  recent: readonly Date[];
  now: Date;
}): EngagementRateVerdict {
  const { settings, now } = input;
  const config = settings.engagement;
  if (settings.killSwitch) {
    return { allowed: false, code: "kill_switch", reason: "The LinkedIn kill switch is on." };
  }
  if (!hasValidAutomationConsent(input.consent)) {
    return {
      allowed: false,
      code: "consent_missing",
      reason: "Browser automation has not been accepted.",
    };
  }
  if (!isWithinActiveHours(config.activeHours, now)) {
    return {
      allowed: false,
      code: "outside_active_hours",
      reason: `Outside the active hours ${config.activeHours.start}-${config.activeHours.end}.`,
      retryAt: nextActiveStart(config.activeHours, now),
    };
  }
  const hourAgo = now.getTime() - 3_600_000;
  const dayAgo = now.getTime() - 86_400_000;
  const lastHour = input.recent.filter((time) => time.getTime() > hourAgo).sort((a, b) => +a - +b);
  const lastDay = input.recent.filter((time) => time.getTime() > dayAgo).sort((a, b) => +a - +b);
  if (lastDay.length >= config.maxActionsPerDay) {
    const oldest = lastDay[lastDay.length - config.maxActionsPerDay] ?? now;
    return {
      allowed: false,
      code: "daily_limit",
      reason: `Daily limit of ${String(config.maxActionsPerDay)} action(s) reached.`,
      retryAt: new Date(oldest.getTime() + 86_400_000),
    };
  }
  if (lastHour.length >= config.maxActionsPerHour) {
    const oldest = lastHour[lastHour.length - config.maxActionsPerHour] ?? now;
    return {
      allowed: false,
      code: "hourly_limit",
      reason: `Hourly limit of ${String(config.maxActionsPerHour)} action(s) reached.`,
      retryAt: new Date(oldest.getTime() + 3_600_000),
    };
  }
  return { allowed: true };
}

/** A uniformly random delay between the configured bounds, in milliseconds. */
export function humanLikeDelayMs(
  config: Pick<LinkedInEngagementConfig, "minDelaySeconds" | "maxDelaySeconds">,
  random: () => number = Math.random,
): number {
  const span = Math.max(0, config.maxDelaySeconds - config.minDelaySeconds);
  return Math.round((config.minDelaySeconds + random() * span) * 1_000);
}

// ── Target validation ────────────────────────────────────────────────────────

/** Only public LinkedIn post URLs or post URNs are accepted as engagement targets. */
export const linkedInEngagementTargetSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) =>
      /^urn:li:(share|ugcPost|activity):[A-Za-z0-9_-]+$/.test(value) ||
      /^https:\/\/(www\.)?linkedin\.com\/(feed\/update|posts)\/[^\s]+$/.test(value),
    { message: "Expected a linkedin.com post URL or a post URN" },
  );

export function engagementTargetUrl(target: string): string {
  if (target.startsWith("https://")) return target;
  return `https://www.linkedin.com/feed/update/${target}/`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function defined<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function toMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number) as [number, number];
  return hour * 60 + minute;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(instant: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Converts a local wall-clock time in `timezone` to a UTC instant. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle DST transitions.
  let instant = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(new Date(instant), timezone);
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    instant += guess - asUtc;
  }
  return new Date(instant);
}

function nextActiveStart(window: LinkedInEngagementConfig["activeHours"], now: Date): Date {
  const local = localParts(now, window.timezone);
  const [hour, minute] = window.start.split(":").map(Number) as [number, number];
  const today = zonedToUtc(local.year, local.month, local.day, hour, minute, window.timezone);
  if (today > now) return today;
  const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return zonedToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
    window.timezone,
  );
}
