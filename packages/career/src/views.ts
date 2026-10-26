import { redact, truncate } from "@nexus/shared";
import type {
  Application,
  ApplicationEvent,
  CareerProfile,
  ConfirmationRecord,
  Contact,
  Deadline,
  DocumentVariant,
  FollowUp,
  Interview,
  Opportunity,
  Outcome,
  SubmissionAttempt,
} from "./model.js";

/**
 * The one place a domain record becomes JSON.
 *
 * ## Why serialisation is not left to the routes
 *
 * There are eleven record types here and each is returned by two or three
 * endpoints. Mapping them at each handler means thirty opportunities to include
 * a field that should not travel, and the field that eventually travels is
 * never the obvious one — it is a `body` on a list endpoint that nobody
 * remembered was there.
 *
 * ## Where personal data is allowed to go
 *
 * One field in this domain is another person's personal data: `Contact.email`.
 * The rule applied here, and tested, is narrow on purpose:
 *
 *  - **Contact endpoints return it in full.** It is the owner's own address
 *    book, typed by the owner, read back over an authenticated owner-scoped
 *    request. Masking it there would make the feature pointless, which is how
 *    people end up keeping the real list somewhere with no access control.
 *  - **Nothing else ever carries it.** Audit events, notifications, submission
 *    attempts and logs get `maskEmail` or nothing at all. These are the
 *    surfaces that are long-lived, widely readable, or both.
 *
 * Document bodies follow the same shape of rule: the single-document endpoint
 * returns the text, every list returns a bounded preview and the content hash.
 */

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Enough of an address to recognise, not enough to use.
 *
 * The local part keeps its first character; the domain is kept whole, because
 * "someone at the university" and "someone at a job board" is exactly the
 * distinction an audit reader needs, and the domain is not the identifying part.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "[redacted]";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

export function profileView(profile: CareerProfile) {
  return {
    id: profile.id,
    headline: profile.headline,
    summary: profile.summary,
    yearsExperience: profile.yearsExperience,
    highestDegree: profile.highestDegree,
    skills: profile.skills,
    languages: profile.languages,
    publications: profile.publications,
    preferences: profile.preferences,
    version: profile.version,
    createdAt: iso(profile.createdAt),
    updatedAt: iso(profile.updatedAt),
  };
}

export function opportunityView(opportunity: Opportunity) {
  return {
    id: opportunity.id,
    kind: opportunity.kind,
    title: opportunity.title,
    organization: opportunity.organization,
    location: opportunity.location,
    remote: opportunity.remote,
    description: opportunity.description,
    requirements: opportunity.requirements,
    compensation: opportunity.compensation,
    postedAt: isoOrNull(opportunity.postedAt),
    closesAt: isoOrNull(opportunity.closesAt),
    externalRef: opportunity.externalRef,
    canonicalUrl: opportunity.canonicalUrl,
    fingerprint: opportunity.fingerprint,
    untrustedContent: opportunity.untrustedContent,
    provenance: opportunity.provenance.map((entry) => ({
      kind: entry.kind,
      url: entry.url,
      evidence: entry.evidence,
      observedAt: iso(entry.observedAt),
    })),
    createdAt: iso(opportunity.createdAt),
    updatedAt: iso(opportunity.updatedAt),
  };
}

export function applicationView(application: Application) {
  return {
    id: application.id,
    opportunityId: application.opportunityId,
    state: application.state,
    stateChangedAt: iso(application.stateChangedAt),
    matchScore: application.matchScore,
    notes: application.notes,
    createdAt: iso(application.createdAt),
    updatedAt: iso(application.updatedAt),
  };
}

/** List form: hash and bounded preview, never the whole body. */
export function documentSummaryView(variant: DocumentVariant) {
  return {
    id: variant.id,
    applicationId: variant.applicationId,
    kind: variant.kind,
    revision: variant.revision,
    parentVariantId: variant.parentVariantId,
    profileVersion: variant.profileVersion,
    contentHash: variant.contentHash,
    preview: truncate(variant.body, 280),
    length: variant.body.length,
    createdAt: iso(variant.createdAt),
  };
}

/** Single-document form: the body, for the owner who asked for this document. */
export function documentView(variant: DocumentVariant) {
  return { ...documentSummaryView(variant), body: variant.body };
}

export function contactView(contact: Contact) {
  return {
    id: contact.id,
    applicationId: contact.applicationId,
    opportunityId: contact.opportunityId,
    displayName: contact.displayName,
    role: contact.role,
    organization: contact.organization,
    email: contact.email,
    notes: contact.notes,
    source: contact.source,
    createdAt: iso(contact.createdAt),
    updatedAt: iso(contact.updatedAt),
  };
}

export function deadlineView(deadline: Deadline) {
  return {
    id: deadline.id,
    applicationId: deadline.applicationId,
    kind: deadline.kind,
    dueAt: iso(deadline.dueAt),
    state: deadline.state,
    label: deadline.label,
    reminderOffsetsMinutes: deadline.reminderOffsetsMinutes,
    remindedOffsetsMinutes: deadline.remindedOffsetsMinutes,
    createdAt: iso(deadline.createdAt),
    updatedAt: iso(deadline.updatedAt),
  };
}

export function interviewView(interview: Interview) {
  return {
    id: interview.id,
    applicationId: interview.applicationId,
    mode: interview.mode,
    stage: interview.stage,
    scheduledAt: iso(interview.scheduledAt),
    durationMinutes: interview.durationMinutes,
    state: interview.state,
    notes: interview.notes,
    createdAt: iso(interview.createdAt),
    updatedAt: iso(interview.updatedAt),
  };
}

export function outcomeView(outcome: Outcome) {
  return {
    id: outcome.id,
    applicationId: outcome.applicationId,
    result: outcome.result,
    decidedAt: iso(outcome.decidedAt),
    notes: outcome.notes,
    createdAt: iso(outcome.createdAt),
  };
}

export function followUpView(followUp: FollowUp) {
  return {
    id: followUp.id,
    applicationId: followUp.applicationId,
    channel: followUp.channel,
    dueAt: iso(followUp.dueAt),
    state: followUp.state,
    draft: followUp.draft,
    createdAt: iso(followUp.createdAt),
    updatedAt: iso(followUp.updatedAt),
  };
}

export function submissionAttemptView(attempt: SubmissionAttempt) {
  return {
    id: attempt.id,
    applicationId: attempt.applicationId,
    state: attempt.state,
    adapter: attempt.adapter,
    confirmationId: attempt.confirmationId,
    payloadHash: attempt.payloadHash,
    idempotencyKey: attempt.idempotencyKey,
    receipt: attempt.receipt,
    failureReason: attempt.failureReason,
    startedAt: iso(attempt.startedAt),
    finishedAt: isoOrNull(attempt.finishedAt),
  };
}

export function confirmationView(confirmation: ConfirmationRecord) {
  return {
    id: confirmation.id,
    applicationId: confirmation.applicationId,
    purpose: confirmation.purpose,
    payloadHash: confirmation.payloadHash,
    state: confirmation.state,
    summary: confirmation.summary,
    requestedAt: iso(confirmation.requestedAt),
    expiresAt: iso(confirmation.expiresAt),
    decidedAt: isoOrNull(confirmation.decidedAt),
    consumedAt: isoOrNull(confirmation.consumedAt),
  };
}

export function eventView(event: ApplicationEvent) {
  return {
    id: event.id,
    applicationId: event.applicationId,
    sequence: event.sequence,
    kind: event.kind,
    fromState: event.fromState,
    toState: event.toState,
    summary: event.summary,
    context: event.context,
    createdAt: iso(event.createdAt),
  };
}

/**
 * Field names an audit row must never contain.
 *
 * Exported so the test that enforces the rule does not re-declare the list.
 * Two copies of a security rule drift, and the copy that drifts is the one
 * nobody reads.
 */
export const FORBIDDEN_AUDIT_FIELDS = [
  "email",
  "contactEmail",
  "body",
  "draft",
  "description",
  "summaryText",
  "token",
  "password",
  "authorization",
  "cookie",
  "secret",
] as const;

/**
 * Prepares a context object for an audit row.
 *
 * Three passes, each closing a different hole. Named keys go first, because
 * `email` is not a secret by shape and the generic redactor would let it
 * through. `redact` then catches anything secret-shaped that arrived under an
 * innocent name. Finally every string is bounded: an audit trail that can be
 * made arbitrarily large by the content it is auditing is a denial of service
 * with extra steps.
 */
export function redactForAudit(context: Record<string, unknown>): Record<string, unknown> {
  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if ((FORBIDDEN_AUDIT_FIELDS as readonly string[]).includes(key)) continue;
    named[key] = value;
  }

  const cleaned = redact(named, 4) as Record<string, unknown>;

  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cleaned)) {
    bounded[key] = typeof value === "string" ? truncate(value, 200) : value;
  }
  return bounded;
}
