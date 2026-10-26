import { z } from "zod";
import { INGEST_LIMITS } from "./untrusted.js";
import {
  confirmationPurposeSchema,
  confirmationStateSchema,
  deadlineKindSchema,
  deadlineStateSchema,
  documentVariantKindSchema,
  followUpChannelSchema,
  followUpStateSchema,
  interviewModeSchema,
  interviewStateSchema,
  applicationStateSchema,
  opportunityKindSchema,
  opportunitySourceKindSchema,
  outcomeResultSchema,
  submissionAttemptStateSchema,
  type ApplicationState,
  type ConfirmationPurpose,
  type ConfirmationState,
  type DeadlineKind,
  type DeadlineState,
  type DocumentVariantKind,
  type FollowUpChannel,
  type FollowUpState,
  type InterviewMode,
  type InterviewState,
  type OpportunityKind,
  type OpportunitySourceKind,
  type OutcomeResult,
  type SubmissionAttemptState,
} from "./vocabulary.js";

/**
 * The shapes of the domain.
 *
 * Two layers, and the split is deliberate:
 *
 *  - **Input schemas** (`…InputSchema`) describe what a caller may send. They
 *    are Zod, they are `strict`, and every text field is bounded. They are the
 *    only way data enters the domain, which is what makes "bounded I/O" a
 *    property rather than an aspiration.
 *  - **Records** (`CareerProfile`, `Opportunity`, …) describe what is stored.
 *    They are TypeScript interfaces carrying real `Date` objects, because the
 *    store speaks `Date` and converting twice at every boundary buys nothing.
 *
 * Serialisation to JSON happens in one place, `views.ts`, so there is exactly
 * one answer to "what does the dashboard see" — and one place to check that it
 * contains no contact address it should not.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

const idSchema = z.string().uuid();
const shortText = (max: number) => z.string().min(1).max(max);

/**
 * An instant, however it arrived.
 *
 * `z.coerce.date()` rather than `z.date()`, so one schema serves both callers:
 * the HTTP boundary, where every date is an ISO string, and internal code,
 * where it is already a `Date`. The alternative is a second set of schemas that
 * differ only in this detail, and the pair drifts — one gains a field, the
 * other does not, and the route stops validating what the service stores.
 *
 * Coercion still validates: an unparseable string fails rather than becoming an
 * invalid `Date` that propagates as `NaN` into a deadline comparison.
 */
const dateLike = z.coerce.date();

/** ISO 4217-ish code. Three letters, uppercased by the schema. */
const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

export const compensationSchema = z
  .object({
    currency: currencySchema,
    /** Lower bound, in whole currency units. Integer: no cents in a salary range. */
    minAmount: z.number().int().nonnegative().max(100_000_000),
    maxAmount: z.number().int().nonnegative().max(100_000_000).nullable(),
    period: z.enum(["year", "month", "day", "hour"]),
  })
  .strict()
  .refine(
    (value) => value.maxAmount === null || value.maxAmount >= value.minAmount,
    "maxAmount must not be lower than minAmount",
  );
export type Compensation = z.infer<typeof compensationSchema>;

export const languageSkillSchema = z
  .object({
    /** BCP 47 primary subtag. */
    code: z
      .string()
      .min(2)
      .max(8)
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
    level: z.enum(["basic", "professional", "fluent", "native"]),
  })
  .strict();
export type LanguageSkill = z.infer<typeof languageSkillSchema>;

/**
 * Where one observation of an opportunity came from.
 *
 * `evidence` is mandatory and is the same discipline `@nexus/connections`
 * applies to adapter provenance: a claim about origin that carries no reason
 * cannot be checked by a reviewer, and `official_site` is exactly the kind of
 * claim someone will later want to check.
 */
export const provenanceSchema = z
  .object({
    kind: opportunitySourceKindSchema,
    /** Canonical URL, or `null` when the source was not a web page. */
    url: z.string().max(INGEST_LIMITS.url).nullable(),
    evidence: shortText(400),
    observedAt: dateLike,
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Profile and preferences
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the owner is looking for.
 *
 * Preferences are the input side of matching, and every field here appears in a
 * ranking factor. That correspondence is intentional: a preference that changes
 * no score is a field the owner filled in for nothing, and a factor with no
 * preference behind it is a score nobody asked for.
 */
export const careerPreferencesInputSchema = z
  .object({
    kinds: z.array(opportunityKindSchema).min(1).max(3),
    /** Free-text places. Matched case- and accent-insensitively. */
    locations: z.array(shortText(INGEST_LIMITS.location)).max(20).default([]),
    remote: z
      .enum(["required", "preferred", "no_preference", "onsite_only"])
      .default("no_preference"),
    languages: z.array(languageSkillSchema).max(10).default([]),
    mustHaveSkills: z.array(shortText(64)).max(30).default([]),
    niceToHaveSkills: z.array(shortText(64)).max(30).default([]),
    /** Doctoral topics. Only meaningful when `kinds` contains `phd`. */
    researchAreas: z.array(shortText(120)).max(20).default([]),
    minCompensation: compensationSchema.nullable().default(null),
    /** Organisations never to be shown, whatever the score. */
    excludedOrganizations: z.array(shortText(INGEST_LIMITS.organization)).max(50).default([]),
    /** Days of notice the owner must give. Feeds deadline feasibility. */
    noticePeriodDays: z.number().int().min(0).max(365).default(0),
  })
  .strict();
export type CareerPreferences = z.infer<typeof careerPreferencesInputSchema>;

export const careerProfileInputSchema = z
  .object({
    headline: shortText(160),
    summary: z.string().max(2_000).default(""),
    yearsExperience: z.number().int().min(0).max(70),
    highestDegree: z.enum(["none", "bachelor", "master", "phd"]),
    skills: z.array(shortText(64)).max(80).default([]),
    languages: z.array(languageSkillSchema).max(10).default([]),
    /** Research track record. Empty is normal outside doctoral applications. */
    publications: z.number().int().min(0).max(1_000).default(0),
    preferences: careerPreferencesInputSchema,
  })
  .strict();
export type CareerProfileInput = z.infer<typeof careerProfileInputSchema>;

export interface CareerProfile extends CareerProfileInput {
  id: string;
  userId: string;
  /**
   * Incremented on every accepted write.
   *
   * Recorded on each document variant, so a draft can state which profile it
   * was generated from. Without it, "regenerate the ones that are stale" has no
   * definable answer.
   */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Opportunity
// ─────────────────────────────────────────────────────────────────────────────

export const opportunityIngestInputSchema = z
  .object({
    kind: opportunityKindSchema,
    title: shortText(INGEST_LIMITS.title),
    organization: shortText(INGEST_LIMITS.organization),
    location: z.string().max(INGEST_LIMITS.location).default(""),
    remote: z.boolean().default(false),
    description: z.string().max(INGEST_LIMITS.description).default(""),
    requirements: z
      .array(shortText(INGEST_LIMITS.requirement))
      .max(INGEST_LIMITS.requirementCount)
      .default([]),
    compensation: compensationSchema.nullable().default(null),
    /** When the listing was published, as the source states it. */
    postedAt: dateLike.nullable().default(null),
    /** Application deadline, as the source states it. */
    closesAt: dateLike.nullable().default(null),
    /** Identifier used by the source. Strengthens deduplication when present. */
    externalRef: z.string().max(128).nullable().default(null),
    source: z
      .object({
        kind: opportunitySourceKindSchema,
        url: z.string().max(INGEST_LIMITS.url).nullable().default(null),
        evidence: shortText(400),
      })
      .strict(),
  })
  .strict();
export type OpportunityIngestInput = z.infer<typeof opportunityIngestInputSchema>;

export interface Opportunity {
  id: string;
  userId: string;
  kind: OpportunityKind;
  title: string;
  organization: string;
  location: string;
  remote: boolean;
  description: string;
  requirements: string[];
  compensation: Compensation | null;
  postedAt: Date | null;
  closesAt: Date | null;
  externalRef: string | null;
  /** Canonical listing URL, or `null`. Deduplication key when present. */
  canonicalUrl: string | null;
  /** Content fingerprint. Deduplication key, always present. */
  fingerprint: string;
  /**
   * Every observation, oldest first.
   *
   * A second sighting does not create a second opportunity — it appends here.
   * This is what makes "seen on the official site *and* on an aggregator" a
   * stronger claim than either alone, and it is why the array is never
   * collapsed to its best element.
   */
  provenance: Provenance[];
  /**
   * True for every field that came from outside.
   *
   * Always `true` for an ingested listing, including one entered by hand: the
   * owner pasting a description has not vouched for its contents. Kept as a
   * field rather than assumed, so a reader of a record knows without consulting
   * the ingest path.
   */
  untrustedContent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application and its satellites
// ─────────────────────────────────────────────────────────────────────────────

export interface Application {
  id: string;
  userId: string;
  opportunityId: string;
  state: ApplicationState;
  stateChangedAt: Date;
  /** Ranking at the moment of shortlisting. Frozen: a later profile edit must
   *  not silently rewrite the reason a decision was made. */
  matchScore: number | null;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentVariant {
  id: string;
  userId: string;
  applicationId: string;
  kind: DocumentVariantKind;
  /** 1 for the first variant of its kind, then strictly increasing. */
  revision: number;
  /** The variant this one was derived from, or `null` for the first. */
  parentVariantId: string | null;
  /** Profile version the body was generated from. */
  profileVersion: number;
  /** SHA-256 of the body. Identity for approval binding and deduplication. */
  contentHash: string;
  body: string;
  createdAt: Date;
}

export interface Contact {
  id: string;
  userId: string;
  applicationId: string | null;
  opportunityId: string | null;
  displayName: string;
  role: string;
  organization: string;
  /**
   * Address, or `null`.
   *
   * The one field in this domain that is unambiguously another person's
   * personal data. It is never written to an audit row, a notification or a
   * log: `views.ts` masks it and `redactForAudit` drops it. It exists because a
   * follow-up letter has to be addressed to someone, and that is the whole of
   * its purpose.
   */
  email: string | null;
  notes: string;
  source: OpportunitySourceKind;
  createdAt: Date;
  updatedAt: Date;
}

export interface Deadline {
  id: string;
  userId: string;
  applicationId: string;
  kind: DeadlineKind;
  dueAt: Date;
  state: DeadlineState;
  /** Minutes before `dueAt` at which a reminder is due, ascending. */
  reminderOffsetsMinutes: number[];
  /** Offsets already notified. Append-only, so a restart cannot re-notify. */
  remindedOffsetsMinutes: number[];
  label: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Interview {
  id: string;
  userId: string;
  applicationId: string;
  mode: InterviewMode;
  stage: string;
  scheduledAt: Date;
  durationMinutes: number;
  state: InterviewState;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Outcome {
  id: string;
  userId: string;
  applicationId: string;
  result: OutcomeResult;
  decidedAt: Date;
  notes: string;
  createdAt: Date;
}

export interface FollowUp {
  id: string;
  userId: string;
  applicationId: string;
  channel: FollowUpChannel;
  dueAt: Date;
  state: FollowUpState;
  /** Prepared text. Never sent by NEXUS; shown for the owner to send. */
  draft: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmissionAttempt {
  id: string;
  userId: string;
  applicationId: string;
  /**
   * Durable idempotency key.
   *
   * Derived, not random: the same application, the same payload and the same
   * approval always produce the same key. A retry after a crash therefore
   * collides with the row the crashed attempt already wrote, and the unique
   * index — not application logic — is what forbids the second submission.
   */
  idempotencyKey: string;
  /** Confirmation that authorised this attempt. */
  confirmationId: string;
  /** Hash of the exact payload handed to the adapter. */
  payloadHash: string;
  adapter: string;
  state: SubmissionAttemptState;
  /** Opaque adapter receipt, or `null` while pending or on failure. */
  receipt: string | null;
  /** Safe, already-redacted sentence. `null` unless the attempt failed. */
  failureReason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * A human decision, stored durably.
 *
 * The in-process `ConfirmationBroker` already holds pending promises, and that
 * is the right design for a task waiting on a person. It is the wrong design
 * for this: an approval given on Monday must still authorise a submission after
 * the API restarts on Tuesday, and a promise does not survive a restart. So the
 * decision is a row, and `payloadHash` binds it to exactly what was approved —
 * edit the cover letter and the approval no longer applies, which is the
 * property that makes "confirm before every external side effect" meaningful
 * rather than ceremonial.
 */
export interface ConfirmationRecord {
  id: string;
  userId: string;
  applicationId: string;
  purpose: ConfirmationPurpose;
  payloadHash: string;
  state: ConfirmationState;
  /** One-sentence description of what approving will do. */
  summary: string;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
}

/**
 * One line of history.
 *
 * Append-only by contract: the store exposes no update and no delete, and
 * `sequence` is unique per application, so a gap or a repeat is detectable. The
 * context object is redacted before it is written — an audit trail that
 * accumulates the data it is auditing becomes the leak it was meant to prevent.
 */
export interface ApplicationEvent {
  id: string;
  userId: string;
  applicationId: string;
  sequence: number;
  kind: string;
  fromState: ApplicationState | null;
  toState: ApplicationState | null;
  summary: string;
  context: Record<string, unknown>;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Satellite inputs
// ─────────────────────────────────────────────────────────────────────────────

export const documentDraftInputSchema = z
  .object({
    kind: documentVariantKindSchema,
    body: shortText(INGEST_LIMITS.documentBody),
    /** Variant this one revises. Must belong to the same application. */
    parentVariantId: idSchema.nullable().default(null),
  })
  .strict();
export type DocumentDraftInput = z.infer<typeof documentDraftInputSchema>;

export const contactInputSchema = z
  .object({
    displayName: shortText(120),
    role: z.string().max(120).default(""),
    organization: z.string().max(INGEST_LIMITS.organization).default(""),
    email: z.string().email().max(254).nullable().default(null),
    notes: z.string().max(INGEST_LIMITS.note).default(""),
    source: opportunitySourceKindSchema.default("manual_entry"),
    applicationId: idSchema.nullable().default(null),
    opportunityId: idSchema.nullable().default(null),
  })
  .strict();
export type ContactInput = z.infer<typeof contactInputSchema>;

export const deadlineInputSchema = z
  .object({
    kind: deadlineKindSchema,
    dueAt: dateLike,
    label: z.string().max(200).default(""),
    reminderOffsetsMinutes: z
      .array(z.number().int().min(0).max(525_600))
      .max(8)
      .default([1_440, 180]),
  })
  .strict();
export type DeadlineInput = z.infer<typeof deadlineInputSchema>;

export const interviewInputSchema = z
  .object({
    mode: interviewModeSchema,
    stage: shortText(120),
    scheduledAt: dateLike,
    durationMinutes: z.number().int().min(5).max(600).default(60),
    notes: z.string().max(INGEST_LIMITS.note).default(""),
  })
  .strict();
export type InterviewInput = z.infer<typeof interviewInputSchema>;

export const outcomeInputSchema = z
  .object({
    result: outcomeResultSchema,
    decidedAt: dateLike,
    notes: z.string().max(INGEST_LIMITS.note).default(""),
  })
  .strict();
export type OutcomeInput = z.infer<typeof outcomeInputSchema>;

export const followUpInputSchema = z
  .object({
    channel: followUpChannelSchema,
    dueAt: dateLike,
    draft: z.string().max(INGEST_LIMITS.note).default(""),
  })
  .strict();
export type FollowUpInput = z.infer<typeof followUpInputSchema>;

/** Re-exported so callers validate against one definition of these states. */
export const stateSchemas = {
  application: applicationStateSchema,
  deadline: deadlineStateSchema,
  interview: interviewStateSchema,
  followUp: followUpStateSchema,
  submission: submissionAttemptStateSchema,
  confirmation: confirmationStateSchema,
  confirmationPurpose: confirmationPurposeSchema,
} as const;
