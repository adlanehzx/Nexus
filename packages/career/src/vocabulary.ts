import { z } from "zod";

/**
 * The closed vocabulary of the career and education domain.
 *
 * Every value a surface can branch on lives here, and nowhere else. The reason
 * is the same one that governs `@nexus/connections`: a string that can hold
 * anything cannot be exhaustively handled, and the handler that gets forgotten
 * is always the one that mattered — here, "this application was rejected" and
 * "this application may still be submitted".
 *
 * The enums are deliberately small. A domain that distinguishes fifteen kinds
 * of opportunity has to explain the difference fifteen times; one that
 * distinguishes three can be reasoned about, and the three chosen are the ones
 * whose *process* genuinely differs — a doctoral application needs a research
 * statement and a supervisor, a permanent position needs a CV and a notice
 * period, a freelance engagement needs a rate and a scope.
 */

/** What kind of thing is being applied for. */
export const opportunityKindSchema = z.enum([
  /** Doctoral position or funded research programme. */
  "phd",
  /** Open-ended employment contract. */
  "permanent_job",
  /** Fixed-scope independent engagement. */
  "freelance",
]);
export type OpportunityKind = z.infer<typeof opportunityKindSchema>;

/**
 * Where an opportunity came from, and how much that is worth.
 *
 * Provenance is not decoration: it feeds the ranking, and it is the reason a
 * listing scraped from an aggregator cannot outrank the same listing read from
 * the employer's own site. `unverified` is the honest default for anything
 * NEXUS was merely told about.
 */
export const opportunitySourceKindSchema = z.enum([
  /** The hiring organisation's own publication. */
  "official_site",
  /** A funder or institutional registry (e.g. a doctoral school portal). */
  "institutional_registry",
  /** A third-party board that republishes listings. */
  "aggregator",
  /** A person forwarded it. */
  "referral",
  /** Entered by the owner by hand. */
  "manual_entry",
  /** Origin is not established. The default, and it costs confidence. */
  "unverified",
]);
export type OpportunitySourceKind = z.infer<typeof opportunitySourceKindSchema>;

/**
 * The application lifecycle.
 *
 * Listed in order of progress, with the three ways out at the end. The order is
 * documentation: a reader can see that `approved` sits after
 * `awaiting_confirmation` and before `submitted`, which is the single most
 * important fact about this model — **nothing leaves the machine from any state
 * but `approved`**.
 */
export const applicationStateSchema = z.enum([
  /** Ingested and matched, no human has looked at it yet. */
  "discovered",
  /** The owner kept it. */
  "shortlisted",
  /** Documents are being tailored. No side effect is possible here. */
  "drafting",
  /** A complete submission payload exists and is waiting for a human decision. */
  "awaiting_confirmation",
  /** A human approved *this exact payload*. The only state that may submit. */
  "approved",
  /** The fake submission adapter accepted the payload exactly once. */
  "submitted",
  /** At least one interview stage is scheduled or done. */
  "interview",
  /** An offer was received. */
  "offer",
  /** The counterparty declined. Terminal. */
  "rejected",
  /** The owner pulled out. Terminal. */
  "withdrawn",
  /** The deadline passed before submission, or the listing closed. Terminal. */
  "expired",
]);
export type ApplicationState = z.infer<typeof applicationStateSchema>;

/**
 * The transition table.
 *
 * Exhaustive by construction: `Record<ApplicationState, …>` means a state added
 * to the enum without a row here does not compile. That is the point — a new
 * state with no declared transitions would otherwise silently become a state
 * from which everything is forbidden, discovered only in production.
 *
 * Three rules are encoded and worth stating in prose, because they are the ones
 * a reviewer should check:
 *
 *  1. `approved` is reachable **only** from `awaiting_confirmation`. There is no
 *     shortcut from `drafting`, so a payload cannot be approved before it has
 *     been presented for approval.
 *  2. `submitted` is reachable **only** from `approved`.
 *  3. `rejected`, `withdrawn` and `expired` have no outgoing transitions. A
 *     terminal state is terminal; reopening would mean a second submission
 *     against an opportunity the owner already walked away from.
 */
const TRANSITIONS: Readonly<Record<ApplicationState, readonly ApplicationState[]>> = {
  discovered: ["shortlisted", "rejected", "withdrawn", "expired"],
  shortlisted: ["drafting", "rejected", "withdrawn", "expired"],
  // Back to `shortlisted` is allowed: abandoning a draft is not withdrawing
  // from the opportunity, and conflating the two loses the shortlist.
  drafting: ["awaiting_confirmation", "shortlisted", "rejected", "withdrawn", "expired"],
  // A refused confirmation returns to `drafting`, never to `rejected`:
  // "I do not want to send this yet" is not "they turned me down", and the
  // outcome statistics would be wrong if the model could not tell them apart.
  awaiting_confirmation: ["approved", "drafting", "withdrawn", "expired"],
  approved: ["submitted", "drafting", "withdrawn", "expired"],
  submitted: ["interview", "offer", "rejected", "withdrawn", "expired"],
  interview: ["offer", "rejected", "withdrawn", "expired"],
  offer: ["rejected", "withdrawn", "expired"],
  rejected: [],
  withdrawn: [],
  expired: [],
};

/** States from which no transition exists. */
export const TERMINAL_APPLICATION_STATES: readonly ApplicationState[] = [
  "rejected",
  "withdrawn",
  "expired",
];

/**
 * The only state from which an external side effect may be attempted.
 *
 * Exported as a constant rather than written inline at the call site, so the
 * submission guard and the tests that prove it cannot drift apart.
 */
export const SUBMITTABLE_APPLICATION_STATE: ApplicationState = "approved";

export function allowedTransitions(from: ApplicationState): readonly ApplicationState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalApplicationState(state: ApplicationState): boolean {
  return TERMINAL_APPLICATION_STATES.includes(state);
}

/** What a tailored document is. */
export const documentVariantKindSchema = z.enum([
  "cv",
  "cover_letter",
  "research_statement",
  "portfolio_note",
  "reference_list",
]);
export type DocumentVariantKind = z.infer<typeof documentVariantKindSchema>;

/** What a dated commitment is about. */
export const deadlineKindSchema = z.enum([
  "application_deadline",
  "document_due",
  "interview",
  "decision_expected",
  "follow_up",
]);
export type DeadlineKind = z.infer<typeof deadlineKindSchema>;

/** Where a dated commitment stands. */
export const deadlineStateSchema = z.enum(["pending", "reminded", "met", "missed", "cancelled"]);
export type DeadlineState = z.infer<typeof deadlineStateSchema>;

export const interviewModeSchema = z.enum(["onsite", "video", "phone", "written"]);
export type InterviewMode = z.infer<typeof interviewModeSchema>;

export const interviewStateSchema = z.enum(["scheduled", "completed", "cancelled", "no_show"]);
export type InterviewState = z.infer<typeof interviewStateSchema>;

/** How an application ended. Recorded once, and never inferred from the state. */
export const outcomeResultSchema = z.enum([
  "offer",
  "rejection",
  "no_response",
  "withdrawn",
  "expired",
]);
export type OutcomeResult = z.infer<typeof outcomeResultSchema>;

/**
 * How a follow-up would be delivered.
 *
 * Every value here is a *draft* channel. NEXUS prepares text and shows it; it
 * does not open a mailbox. `email_draft` is named that way on purpose, so no
 * future reader mistakes it for a send.
 */
export const followUpChannelSchema = z.enum(["email_draft", "letter_draft", "manual_note"]);
export type FollowUpChannel = z.infer<typeof followUpChannelSchema>;

export const followUpStateSchema = z.enum(["planned", "drafted", "done", "cancelled"]);
export type FollowUpState = z.infer<typeof followUpStateSchema>;

/**
 * Where a submission attempt stands.
 *
 * `refused` is distinct from `failed`, and the distinction is the whole safety
 * story: `failed` means the adapter tried and something broke, `refused` means
 * NEXUS declined to try. A retry is sensible for one and meaningless for the
 * other.
 */
export const submissionAttemptStateSchema = z.enum(["pending", "succeeded", "failed", "refused"]);
export type SubmissionAttemptState = z.infer<typeof submissionAttemptStateSchema>;

/** Where a durable confirmation stands. */
export const confirmationStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "consumed",
]);
export type ConfirmationState = z.infer<typeof confirmationStateSchema>;

/**
 * What a confirmation authorises.
 *
 * One value today. It is an enum anyway, because the guard reads
 * "an approval exists for *this purpose*" and a second purpose added later must
 * not be satisfiable by an approval granted for the first.
 */
export const confirmationPurposeSchema = z.enum(["submit_application"]);
export type ConfirmationPurpose = z.infer<typeof confirmationPurposeSchema>;
