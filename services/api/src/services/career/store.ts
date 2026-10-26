import { ConflictError } from "@nexus/shared";
import type {
  Application,
  ApplicationEvent,
  ApplicationState,
  CareerProfile,
  CareerProfileInput,
  ConfirmationPurpose,
  ConfirmationRecord,
  ConfirmationState,
  Contact,
  Deadline,
  DeadlineState,
  DocumentVariant,
  DocumentVariantKind,
  FollowUp,
  FollowUpState,
  Interview,
  InterviewState,
  Opportunity,
  OpportunityKind,
  Outcome,
  Provenance,
  SubmissionAttempt,
  SubmissionAttemptState,
} from "@nexus/career";

/**
 * The persistence contract for the career domain.
 *
 * ## Why every method takes an owner
 *
 * There is no `getApplication(id)`. The owner is the first argument of every
 * read and every write, so a route that forgets to check ownership cannot
 * compile a call that ignores it. This is stronger than asserting ownership
 * after the fact: `assertOwnedBy` works, but only if it is remembered, and the
 * place it gets forgotten is the eleventh endpoint nobody reviewed closely.
 *
 * A record belonging to someone else is reported as **absent**, never as
 * forbidden. Distinguishing the two would let an attacker enumerate which
 * identifiers exist.
 *
 * ## Why conflicts are a typed error
 *
 * Three guarantees in this domain are enforced by unique indexes rather than by
 * a read-then-write: deduplication, one live approval, and exactly-once
 * submission. The implementation therefore has to surface "the database refused
 * this because a row already exists" as something a caller can branch on, which
 * is `ConflictError`. A store that let a driver-specific error escape would
 * force every caller to know what `P2002` means.
 */

export interface CareerStore {
  // ── Profile ─────────────────────────────────────────────────────────────
  getProfile(userId: string): Promise<CareerProfile | undefined>;
  /** Creates on first call, bumps `version` on every later one. */
  saveProfile(input: {
    userId: string;
    id: string;
    profile: CareerProfileInput;
    now: Date;
  }): Promise<CareerProfile>;

  // ── Opportunities ───────────────────────────────────────────────────────
  getOpportunity(userId: string, id: string): Promise<Opportunity | undefined>;
  findOpportunityByFingerprint(
    userId: string,
    fingerprint: string,
  ): Promise<Opportunity | undefined>;
  findOpportunityByCanonicalUrl(
    userId: string,
    canonicalUrl: string,
  ): Promise<Opportunity | undefined>;
  /** @throws {ConflictError} when the fingerprint or canonical URL is taken. */
  createOpportunity(record: Opportunity): Promise<Opportunity>;
  /**
   * Records a further sighting of a listing already known.
   *
   * `fill` carries facts the new sighting supplies and the stored record lacks.
   * The service decides what may be filled; the store only applies it. Nothing
   * already known is ever overwritten here — a later, weaker source must not be
   * able to rewrite a deadline read from the institution's own page.
   */
  recordSighting(input: {
    userId: string;
    opportunityId: string;
    entry: Provenance;
    fill: Partial<
      Pick<
        Opportunity,
        | "location"
        | "description"
        | "requirements"
        | "compensation"
        | "postedAt"
        | "closesAt"
        | "externalRef"
        | "canonicalUrl"
      >
    >;
    now: Date;
  }): Promise<Opportunity>;
  listOpportunities(
    userId: string,
    filter: { kind?: OpportunityKind; limit: number },
  ): Promise<Opportunity[]>;

  // ── Applications ────────────────────────────────────────────────────────
  getApplication(userId: string, id: string): Promise<Application | undefined>;
  findApplicationByOpportunity(
    userId: string,
    opportunityId: string,
  ): Promise<Application | undefined>;
  /** @throws {ConflictError} when this owner already applied to this listing. */
  createApplication(record: Application): Promise<Application>;
  updateApplication(input: {
    userId: string;
    id: string;
    state?: ApplicationState;
    matchScore?: number | null;
    notes?: string;
    now: Date;
  }): Promise<Application>;
  listApplications(
    userId: string,
    filter: { state?: ApplicationState; limit: number },
  ): Promise<Application[]>;

  // ── Documents ───────────────────────────────────────────────────────────
  createDocumentVariant(record: DocumentVariant): Promise<DocumentVariant>;
  getDocumentVariant(userId: string, id: string): Promise<DocumentVariant | undefined>;
  listDocumentVariants(userId: string, applicationId: string): Promise<DocumentVariant[]>;
  /** Highest revision of each kind. The payload a submission would carry. */
  latestDocumentVariants(userId: string, applicationId: string): Promise<DocumentVariant[]>;
  nextDocumentRevision(
    userId: string,
    applicationId: string,
    kind: DocumentVariantKind,
  ): Promise<number>;

  // ── Contacts ────────────────────────────────────────────────────────────
  createContact(record: Contact): Promise<Contact>;
  getContact(userId: string, id: string): Promise<Contact | undefined>;
  listContacts(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<Contact[]>;

  // ── Deadlines ───────────────────────────────────────────────────────────
  createDeadline(record: Deadline): Promise<Deadline>;
  getDeadline(userId: string, id: string): Promise<Deadline | undefined>;
  listDeadlines(
    userId: string,
    filter: { applicationId?: string; state?: DeadlineState; dueBefore?: Date; limit: number },
  ): Promise<Deadline[]>;
  updateDeadline(input: {
    userId: string;
    id: string;
    state?: DeadlineState;
    /** Appended, never replaced: a sent reminder cannot be un-sent. */
    recordRemindedOffsetMinutes?: number;
    now: Date;
  }): Promise<Deadline>;

  // ── Interviews, outcomes, follow-ups ────────────────────────────────────
  createInterview(record: Interview): Promise<Interview>;
  updateInterview(input: {
    userId: string;
    id: string;
    state: InterviewState;
    now: Date;
  }): Promise<Interview>;
  listInterviews(userId: string, applicationId: string): Promise<Interview[]>;

  /** @throws {ConflictError} when an outcome is already recorded. */
  createOutcome(record: Outcome): Promise<Outcome>;
  getOutcome(userId: string, applicationId: string): Promise<Outcome | undefined>;

  createFollowUp(record: FollowUp): Promise<FollowUp>;
  updateFollowUp(input: {
    userId: string;
    id: string;
    state: FollowUpState;
    now: Date;
  }): Promise<FollowUp>;
  listFollowUps(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<FollowUp[]>;

  // ── Durable confirmations ───────────────────────────────────────────────
  getConfirmation(userId: string, id: string): Promise<ConfirmationRecord | undefined>;
  /**
   * The live confirmation for an application and purpose, if any.
   *
   * "Live" means pending or approved-unspent, and the partial unique index
   * guarantees there is at most one. The service calls this before asking a new
   * question, so a stale question is retired rather than left answerable.
   */
  findLiveConfirmation(input: {
    userId: string;
    applicationId: string;
    purpose: ConfirmationPurpose;
  }): Promise<ConfirmationRecord | undefined>;
  /** @throws {ConflictError} when a live confirmation already exists. */
  createConfirmation(record: ConfirmationRecord): Promise<ConfirmationRecord>;
  updateConfirmation(input: {
    userId: string;
    id: string;
    state: ConfirmationState;
    now: Date;
  }): Promise<ConfirmationRecord>;
  listConfirmations(userId: string, applicationId: string): Promise<ConfirmationRecord[]>;

  // ── Submission attempts ─────────────────────────────────────────────────
  findAttemptByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<SubmissionAttempt | undefined>;
  /** @throws {ConflictError} when the idempotency key is already recorded. */
  createAttempt(record: SubmissionAttempt): Promise<SubmissionAttempt>;
  finishAttempt(input: {
    userId: string;
    id: string;
    state: Exclude<SubmissionAttemptState, "pending">;
    receipt: string | null;
    failureReason: string | null;
    now: Date;
  }): Promise<SubmissionAttempt>;
  listAttempts(userId: string, applicationId: string): Promise<SubmissionAttempt[]>;

  // ── Immutable history ───────────────────────────────────────────────────
  /** Allocates the next sequence for the application and appends. */
  appendEvent(input: {
    id: string;
    userId: string;
    applicationId: string;
    kind: string;
    fromState: ApplicationState | null;
    toState: ApplicationState | null;
    summary: string;
    context: Record<string, unknown>;
    now: Date;
  }): Promise<ApplicationEvent>;
  listEvents(userId: string, applicationId: string): Promise<ApplicationEvent[]>;
}

/**
 * In-memory implementation.
 *
 * Not a mock: it is the default store, it enforces the same uniqueness rules as
 * the migration, and the service test suite runs against it. That is deliberate
 * — a fake that is more permissive than production turns every uniqueness bug
 * into a surprise at deployment. Where the database has a unique index, this
 * class scans and throws `ConflictError`; the scan is O(n) and n is one
 * person's job search.
 */
export class InMemoryCareerStore implements CareerStore {
  readonly #profiles = new Map<string, CareerProfile>();
  readonly #opportunities = new Map<string, Opportunity>();
  readonly #applications = new Map<string, Application>();
  readonly #documents = new Map<string, DocumentVariant>();
  readonly #contacts = new Map<string, Contact>();
  readonly #deadlines = new Map<string, Deadline>();
  readonly #interviews = new Map<string, Interview>();
  readonly #outcomes = new Map<string, Outcome>();
  readonly #followUps = new Map<string, FollowUp>();
  readonly #confirmations = new Map<string, ConfirmationRecord>();
  readonly #attempts = new Map<string, SubmissionAttempt>();
  readonly #events = new Map<string, ApplicationEvent>();

  // ── Profile ───────────────────────────────────────────────────────────────

  getProfile(userId: string): Promise<CareerProfile | undefined> {
    return Promise.resolve(clone(this.#profiles.get(userId)));
  }

  saveProfile(input: {
    userId: string;
    id: string;
    profile: CareerProfileInput;
    now: Date;
  }): Promise<CareerProfile> {
    const existing = this.#profiles.get(input.userId);
    const saved: CareerProfile = {
      ...input.profile,
      id: existing?.id ?? input.id,
      userId: input.userId,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.#profiles.set(input.userId, saved);
    return Promise.resolve(clone(saved));
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  getOpportunity(userId: string, id: string): Promise<Opportunity | undefined> {
    return Promise.resolve(clone(owned(this.#opportunities.get(id), userId)));
  }

  findOpportunityByFingerprint(
    userId: string,
    fingerprint: string,
  ): Promise<Opportunity | undefined> {
    return Promise.resolve(
      clone(
        [...this.#opportunities.values()].find(
          (item) => item.userId === userId && item.fingerprint === fingerprint,
        ),
      ),
    );
  }

  findOpportunityByCanonicalUrl(
    userId: string,
    canonicalUrl: string,
  ): Promise<Opportunity | undefined> {
    return Promise.resolve(
      clone(
        [...this.#opportunities.values()].find(
          (item) => item.userId === userId && item.canonicalUrl === canonicalUrl,
        ),
      ),
    );
  }

  createOpportunity(record: Opportunity): Promise<Opportunity> {
    for (const existing of this.#opportunities.values()) {
      if (existing.userId !== record.userId) continue;
      if (existing.fingerprint === record.fingerprint) {
        throw duplicate("career_opportunities", "fingerprint");
      }
      if (record.canonicalUrl !== null && existing.canonicalUrl === record.canonicalUrl) {
        throw duplicate("career_opportunities", "canonicalUrl");
      }
    }
    this.#opportunities.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  recordSighting(input: {
    userId: string;
    opportunityId: string;
    entry: Provenance;
    fill: Partial<Opportunity>;
    now: Date;
  }): Promise<Opportunity> {
    const record = this.#require(
      owned(this.#opportunities.get(input.opportunityId), input.userId),
      "opportunity",
    );
    const updated: Opportunity = {
      ...record,
      ...input.fill,
      id: record.id,
      userId: record.userId,
      fingerprint: record.fingerprint,
      provenance: [...record.provenance, input.entry],
      createdAt: record.createdAt,
      updatedAt: input.now,
    };
    this.#opportunities.set(record.id, updated);
    return Promise.resolve(clone(updated));
  }

  listOpportunities(
    userId: string,
    filter: { kind?: OpportunityKind; limit: number },
  ): Promise<Opportunity[]> {
    const items = [...this.#opportunities.values()]
      .filter((item) => item.userId === userId)
      .filter((item) => filter.kind === undefined || item.kind === filter.kind)
      .sort((left, right) => +right.createdAt - +left.createdAt)
      .slice(0, filter.limit);
    return Promise.resolve(items.map((item) => clone(item)));
  }

  // ── Applications ──────────────────────────────────────────────────────────

  getApplication(userId: string, id: string): Promise<Application | undefined> {
    return Promise.resolve(clone(owned(this.#applications.get(id), userId)));
  }

  findApplicationByOpportunity(
    userId: string,
    opportunityId: string,
  ): Promise<Application | undefined> {
    return Promise.resolve(
      clone(
        [...this.#applications.values()].find(
          (item) => item.userId === userId && item.opportunityId === opportunityId,
        ),
      ),
    );
  }

  createApplication(record: Application): Promise<Application> {
    const clash = [...this.#applications.values()].some(
      (item) => item.userId === record.userId && item.opportunityId === record.opportunityId,
    );
    if (clash) throw duplicate("career_applications", "opportunityId");

    this.#applications.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  updateApplication(input: {
    userId: string;
    id: string;
    state?: ApplicationState;
    matchScore?: number | null;
    notes?: string;
    now: Date;
  }): Promise<Application> {
    const record = this.#require(
      owned(this.#applications.get(input.id), input.userId),
      "application",
    );
    const updated: Application = {
      ...record,
      ...(input.state === undefined ? {} : { state: input.state, stateChangedAt: input.now }),
      ...(input.matchScore === undefined ? {} : { matchScore: input.matchScore }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      updatedAt: input.now,
    };
    this.#applications.set(record.id, updated);
    return Promise.resolve(clone(updated));
  }

  listApplications(
    userId: string,
    filter: { state?: ApplicationState; limit: number },
  ): Promise<Application[]> {
    const items = [...this.#applications.values()]
      .filter((item) => item.userId === userId)
      .filter((item) => filter.state === undefined || item.state === filter.state)
      .sort((left, right) => +right.updatedAt - +left.updatedAt)
      .slice(0, filter.limit);
    return Promise.resolve(items.map((item) => clone(item)));
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  createDocumentVariant(record: DocumentVariant): Promise<DocumentVariant> {
    const clash = [...this.#documents.values()].some(
      (item) =>
        item.applicationId === record.applicationId &&
        item.kind === record.kind &&
        item.revision === record.revision,
    );
    if (clash) throw duplicate("career_document_variants", "revision");

    this.#documents.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  getDocumentVariant(userId: string, id: string): Promise<DocumentVariant | undefined> {
    return Promise.resolve(clone(owned(this.#documents.get(id), userId)));
  }

  listDocumentVariants(userId: string, applicationId: string): Promise<DocumentVariant[]> {
    return Promise.resolve(this.#variantsOf(userId, applicationId).map((item) => clone(item)));
  }

  latestDocumentVariants(userId: string, applicationId: string): Promise<DocumentVariant[]> {
    const best = new Map<DocumentVariantKind, DocumentVariant>();
    for (const variant of this.#variantsOf(userId, applicationId)) {
      const current = best.get(variant.kind);
      if (current === undefined || variant.revision > current.revision) {
        best.set(variant.kind, variant);
      }
    }
    return Promise.resolve(
      [...best.values()].sort((left, right) => left.kind.localeCompare(right.kind)).map(clone),
    );
  }

  nextDocumentRevision(
    userId: string,
    applicationId: string,
    kind: DocumentVariantKind,
  ): Promise<number> {
    const highest = this.#variantsOf(userId, applicationId)
      .filter((item) => item.kind === kind)
      .reduce((max, item) => Math.max(max, item.revision), 0);
    return Promise.resolve(highest + 1);
  }

  #variantsOf(userId: string, applicationId: string): DocumentVariant[] {
    return [...this.#documents.values()]
      .filter((item) => item.userId === userId && item.applicationId === applicationId)
      .sort((left, right) => left.revision - right.revision);
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  createContact(record: Contact): Promise<Contact> {
    this.#contacts.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  getContact(userId: string, id: string): Promise<Contact | undefined> {
    return Promise.resolve(clone(owned(this.#contacts.get(id), userId)));
  }

  listContacts(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<Contact[]> {
    const items = [...this.#contacts.values()]
      .filter((item) => item.userId === userId)
      .filter(
        (item) => filter.applicationId === undefined || item.applicationId === filter.applicationId,
      )
      .sort((left, right) => +right.createdAt - +left.createdAt)
      .slice(0, filter.limit);
    return Promise.resolve(items.map(clone));
  }

  // ── Deadlines ─────────────────────────────────────────────────────────────

  createDeadline(record: Deadline): Promise<Deadline> {
    this.#deadlines.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  getDeadline(userId: string, id: string): Promise<Deadline | undefined> {
    return Promise.resolve(clone(owned(this.#deadlines.get(id), userId)));
  }

  listDeadlines(
    userId: string,
    filter: { applicationId?: string; state?: DeadlineState; dueBefore?: Date; limit: number },
  ): Promise<Deadline[]> {
    const items = [...this.#deadlines.values()]
      .filter((item) => item.userId === userId)
      .filter(
        (item) => filter.applicationId === undefined || item.applicationId === filter.applicationId,
      )
      .filter((item) => filter.state === undefined || item.state === filter.state)
      .filter((item) => filter.dueBefore === undefined || item.dueAt <= filter.dueBefore)
      .sort((left, right) => +left.dueAt - +right.dueAt)
      .slice(0, filter.limit);
    return Promise.resolve(items.map(clone));
  }

  updateDeadline(input: {
    userId: string;
    id: string;
    state?: DeadlineState;
    recordRemindedOffsetMinutes?: number;
    now: Date;
  }): Promise<Deadline> {
    const record = this.#require(owned(this.#deadlines.get(input.id), input.userId), "deadline");
    const offset = input.recordRemindedOffsetMinutes;
    const updated: Deadline = {
      ...record,
      ...(input.state === undefined ? {} : { state: input.state }),
      remindedOffsetsMinutes:
        offset === undefined || record.remindedOffsetsMinutes.includes(offset)
          ? record.remindedOffsetsMinutes
          : [...record.remindedOffsetsMinutes, offset],
      updatedAt: input.now,
    };
    this.#deadlines.set(record.id, updated);
    return Promise.resolve(clone(updated));
  }

  // ── Interviews, outcomes, follow-ups ──────────────────────────────────────

  createInterview(record: Interview): Promise<Interview> {
    this.#interviews.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  updateInterview(input: {
    userId: string;
    id: string;
    state: InterviewState;
    now: Date;
  }): Promise<Interview> {
    const record = this.#require(owned(this.#interviews.get(input.id), input.userId), "interview");
    const updated: Interview = { ...record, state: input.state, updatedAt: input.now };
    this.#interviews.set(record.id, updated);
    return Promise.resolve(clone(updated));
  }

  listInterviews(userId: string, applicationId: string): Promise<Interview[]> {
    const items = [...this.#interviews.values()]
      .filter((item) => item.userId === userId && item.applicationId === applicationId)
      .sort((left, right) => +left.scheduledAt - +right.scheduledAt);
    return Promise.resolve(items.map(clone));
  }

  createOutcome(record: Outcome): Promise<Outcome> {
    const clash = [...this.#outcomes.values()].some(
      (item) => item.applicationId === record.applicationId,
    );
    if (clash) throw duplicate("career_outcomes", "applicationId");

    this.#outcomes.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  getOutcome(userId: string, applicationId: string): Promise<Outcome | undefined> {
    return Promise.resolve(
      clone(
        [...this.#outcomes.values()].find(
          (item) => item.userId === userId && item.applicationId === applicationId,
        ),
      ),
    );
  }

  createFollowUp(record: FollowUp): Promise<FollowUp> {
    this.#followUps.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  updateFollowUp(input: {
    userId: string;
    id: string;
    state: FollowUpState;
    now: Date;
  }): Promise<FollowUp> {
    const record = this.#require(owned(this.#followUps.get(input.id), input.userId), "follow-up");
    const updated: FollowUp = { ...record, state: input.state, updatedAt: input.now };
    this.#followUps.set(record.id, updated);
    return Promise.resolve(clone(updated));
  }

  listFollowUps(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<FollowUp[]> {
    const items = [...this.#followUps.values()]
      .filter((item) => item.userId === userId)
      .filter(
        (item) => filter.applicationId === undefined || item.applicationId === filter.applicationId,
      )
      .sort((left, right) => +left.dueAt - +right.dueAt)
      .slice(0, filter.limit);
    return Promise.resolve(items.map(clone));
  }

  // ── Durable confirmations ─────────────────────────────────────────────────

  getConfirmation(userId: string, id: string): Promise<ConfirmationRecord | undefined> {
    return Promise.resolve(clone(owned(this.#confirmations.get(id), userId)));
  }

  findLiveConfirmation(input: {
    userId: string;
    applicationId: string;
    purpose: ConfirmationPurpose;
  }): Promise<ConfirmationRecord | undefined> {
    return Promise.resolve(
      clone(
        [...this.#confirmations.values()].find(
          (item) =>
            item.userId === input.userId &&
            item.applicationId === input.applicationId &&
            item.purpose === input.purpose &&
            isLive(item.state),
        ),
      ),
    );
  }

  createConfirmation(record: ConfirmationRecord): Promise<ConfirmationRecord> {
    const clash = [...this.#confirmations.values()].some(
      (item) =>
        item.userId === record.userId &&
        item.applicationId === record.applicationId &&
        item.purpose === record.purpose &&
        isLive(item.state),
    );
    if (clash) throw duplicate("career_confirmations", "live");

    this.#confirmations.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  updateConfirmation(input: {
    userId: string;
    id: string;
    state: ConfirmationState;
    now: Date;
  }): Promise<ConfirmationRecord> {
    const record = this.#require(
      owned(this.#confirmations.get(input.id), input.userId),
      "confirmation",
    );
    const updated: ConfirmationRecord = {
      ...record,
      state: input.state,
      decidedAt: input.state === "pending" ? null : (record.decidedAt ?? input.now),
      consumedAt: input.state === "consumed" ? input.now : null,
    };
    this.#confirmations.set(record.id, updated);
    return Promise.resolve(clone(updated));
  }

  listConfirmations(userId: string, applicationId: string): Promise<ConfirmationRecord[]> {
    const items = [...this.#confirmations.values()]
      .filter((item) => item.userId === userId && item.applicationId === applicationId)
      .sort((left, right) => +left.requestedAt - +right.requestedAt);
    return Promise.resolve(items.map(clone));
  }

  // ── Submission attempts ───────────────────────────────────────────────────

  findAttemptByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<SubmissionAttempt | undefined> {
    return Promise.resolve(
      clone(
        [...this.#attempts.values()].find(
          (item) => item.userId === userId && item.idempotencyKey === idempotencyKey,
        ),
      ),
    );
  }

  createAttempt(record: SubmissionAttempt): Promise<SubmissionAttempt> {
    const clash = [...this.#attempts.values()].some(
      (item) => item.userId === record.userId && item.idempotencyKey === record.idempotencyKey,
    );
    if (clash) throw duplicate("career_submission_attempts", "idempotencyKey");

    this.#attempts.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  finishAttempt(input: {
    userId: string;
    id: string;
    state: Exclude<SubmissionAttemptState, "pending">;
    receipt: string | null;
    failureReason: string | null;
    now: Date;
  }): Promise<SubmissionAttempt> {
    const record = this.#require(owned(this.#attempts.get(input.id), input.userId), "attempt");
    const updated: SubmissionAttempt = {
      ...record,
      state: input.state,
      receipt: input.receipt,
      failureReason: input.failureReason,
      finishedAt: input.now,
    };
    this.#attempts.set(record.id, updated);
    return Promise.resolve(clone(updated));
  }

  listAttempts(userId: string, applicationId: string): Promise<SubmissionAttempt[]> {
    const items = [...this.#attempts.values()]
      .filter((item) => item.userId === userId && item.applicationId === applicationId)
      .sort((left, right) => +left.startedAt - +right.startedAt);
    return Promise.resolve(items.map(clone));
  }

  // ── Immutable history ─────────────────────────────────────────────────────

  appendEvent(input: {
    id: string;
    userId: string;
    applicationId: string;
    kind: string;
    fromState: ApplicationState | null;
    toState: ApplicationState | null;
    summary: string;
    context: Record<string, unknown>;
    now: Date;
  }): Promise<ApplicationEvent> {
    const highest = [...this.#events.values()]
      .filter((item) => item.applicationId === input.applicationId)
      .reduce((max, item) => Math.max(max, item.sequence), 0);

    const record: ApplicationEvent = {
      id: input.id,
      userId: input.userId,
      applicationId: input.applicationId,
      sequence: highest + 1,
      kind: input.kind,
      fromState: input.fromState,
      toState: input.toState,
      summary: input.summary,
      context: input.context,
      createdAt: input.now,
    };
    this.#events.set(record.id, clone(record));
    return Promise.resolve(clone(record));
  }

  listEvents(userId: string, applicationId: string): Promise<ApplicationEvent[]> {
    const items = [...this.#events.values()]
      .filter((item) => item.userId === userId && item.applicationId === applicationId)
      .sort((left, right) => left.sequence - right.sequence);
    return Promise.resolve(items.map(clone));
  }

  #require<T>(record: T | undefined, what: string): T {
    if (record === undefined) {
      throw new ConflictError({
        message: `Career ${what} vanished between read and write`,
        userMessage: "The requested resource does not exist.",
      });
    }
    return record;
  }
}

/** Pending or approved-unspent. The states the partial unique index covers. */
function isLive(state: ConfirmationState): boolean {
  return state === "pending" || state === "approved";
}

/**
 * Filters out a record belonging to someone else.
 *
 * Returning `undefined` rather than throwing is the point: the caller then
 * reports "does not exist", which is the same answer an unknown identifier
 * gets, so neither can be used to probe for the other.
 */
function owned<T extends { userId: string }>(record: T | undefined, userId: string): T | undefined {
  return record?.userId === userId ? record : undefined;
}

function duplicate(table: string, column: string): ConflictError {
  return new ConflictError({
    message: `Unique constraint on ${table}.${column}`,
    userMessage: "This record already exists.",
    context: { table, column },
  });
}

/**
 * Defensive copy.
 *
 * Without it, a caller holding a returned record could mutate the store's own
 * object, and the in-memory store would behave unlike the database in the one
 * way that matters: a failed write would appear to have succeeded. The copy is
 * shallow for scalars and rebuilds arrays, which is everything these records
 * contain apart from `Date`, which is immutable in practice here.
 */
function clone<T>(record: T): T {
  if (record === undefined || record === null || typeof record !== "object") return record;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    copy[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return copy as T;
}
