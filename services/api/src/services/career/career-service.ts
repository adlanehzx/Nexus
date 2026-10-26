import { ConflictError, NotFoundError, ValidationError, toAppError, uuidv7 } from "@nexus/shared";
import {
  INGEST_LIMITS,
  assertSubmittable,
  assertTransition,
  assessCompleteness,
  canonicalizeListingUrl,
  contactEmailHash,
  contentHash,
  draftingBlockers,
  isTerminalApplicationState,
  opportunityFingerprint,
  rankOpportunities,
  redactForAudit,
  sanitizeExternalText,
  submissionIdempotencyKey,
  submissionPayloadHash,
  type Application,
  type ApplicationEvent,
  type ApplicationState,
  type CareerProfile,
  type CareerProfileInput,
  type CompletenessReport,
  type Contact,
  type ContactInput,
  type Deadline,
  type DeadlineInput,
  type DocumentDraftInput,
  type DocumentVariant,
  type FollowUp,
  type FollowUpInput,
  type Interview,
  type InterviewInput,
  type MatchExplanation,
  type Opportunity,
  type OpportunityIngestInput,
  type OpportunityKind,
  type Outcome,
  type OutcomeInput,
  type Provenance,
  type SubmissionAttempt,
  type ConfirmationRecord,
} from "@nexus/career";
import type { NotificationService } from "../notification-service.js";
import type { SecurityEventKind, SecurityLog } from "../observability.js";
import type { CareerStore } from "./store.js";
import {
  RecordingSubmissionAdapter,
  type SubmissionAdapter,
  type SubmissionPayload,
} from "./submission-adapter.js";

/**
 * The career and education service.
 *
 * ## The one rule everything else serves
 *
 * A submission leaves this process only when a human has approved **the exact
 * payload** that is about to leave, that approval has been written to the
 * database, and no earlier attempt carrying the same derived key exists. Every
 * other method here either builds towards that moment or records what happened
 * afterwards.
 *
 * Three mechanisms implement it, and they are deliberately independent, so that
 * a bug in one does not silently disable the others:
 *
 *  1. **The lifecycle.** `assertSubmittable` refuses anything that is not
 *     `approved`, and the transition table makes `approved` reachable only from
 *     `awaiting_confirmation`. A rejected or expired application is turned away
 *     before any work is done on its behalf.
 *  2. **The durable approval.** The decision is a row bound to a payload hash,
 *     not a promise in memory. It therefore survives a restart, which is the
 *     whole reason it is not delegated to `ConfirmationBroker` — that class is
 *     right for a task waiting on a person and wrong for an authorisation that
 *     must still be valid tomorrow. Edit a document and the hash changes, so
 *     the approval stops applying without anyone having to revoke it.
 *  3. **The derived idempotency key.** `(applicationId, payloadHash,
 *     confirmationId)` hashed. A retry after a crash reproduces the key and
 *     collides with the row the crashed attempt already wrote, so the unique
 *     index refuses the second submission — no application code needs to have
 *     survived the crash for this to hold.
 *
 * ## Why a failed attempt needs a new approval
 *
 * When the adapter throws, it is genuinely unknown whether the submission
 * landed. Retrying under the same approval would be a guess, so the approval is
 * marked spent, the application returns to `drafting`, and the owner is asked
 * again. Asking twice is a small cost; sending twice is not recoverable.
 */

export interface CareerServiceOptions {
  store: CareerStore;
  /**
   * Where a submission would go. Defaults to the recording adapter, which
   * writes nothing outside the process.
   */
  adapter?: SubmissionAdapter;
  notifications?: NotificationService | undefined;
  /** Refusals are security events. Optional so the service stays testable. */
  securityLog?: SecurityLog | undefined;
  now?: () => Date;
  /** Injectable so tests get stable identifiers. */
  newId?: () => string;
  /** How long an unanswered approval stays answerable. Default 24 hours. */
  confirmationTtlMs?: number;
  dashboardBaseUrl?: string;
}

export interface ProfileReport {
  profile: CareerProfile | null;
  completeness: CompletenessReport | null;
}

export interface IngestOutcome {
  fingerprint: string;
  opportunityId: string;
  status: "created" | "merged";
  /** Why this listing was treated as new or as already known. */
  reason: string;
}

export interface IngestReport {
  created: number;
  merged: number;
  outcomes: IngestOutcome[];
}

export interface RankedOpportunity {
  opportunity: Opportunity;
  explanation: MatchExplanation;
  /** The application for this listing, when one exists. */
  applicationState: ApplicationState | null;
}

export interface SubmissionResult {
  attempt: SubmissionAttempt;
  /**
   * True when this call did not reach the adapter because an attempt with the
   * same derived key already existed. The exactly-once guarantee, observable.
   */
  replayed: boolean;
}

export interface ApplicationDetail {
  application: Application;
  opportunity: Opportunity;
  documents: DocumentVariant[];
  contacts: Contact[];
  deadlines: Deadline[];
  interviews: Interview[];
  followUps: FollowUp[];
  outcome: Outcome | null;
  attempts: SubmissionAttempt[];
  confirmations: ConfirmationRecord[];
}

const DEFAULT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1_000;

/** Targets the generic transition endpoint must never reach. */
const GUARDED_TRANSITION_TARGETS: readonly ApplicationState[] = ["approved", "submitted"];

export class CareerService {
  readonly #store: CareerStore;
  readonly #adapter: SubmissionAdapter;
  readonly #notifications: NotificationService | undefined;
  readonly #securityLog: SecurityLog | undefined;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #confirmationTtlMs: number;
  readonly #dashboardBaseUrl: string;

  constructor(options: CareerServiceOptions) {
    this.#store = options.store;
    this.#adapter = options.adapter ?? new RecordingSubmissionAdapter();
    this.#notifications = options.notifications;
    this.#securityLog = options.securityLog;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => uuidv7());
    this.#confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.#dashboardBaseUrl = options.dashboardBaseUrl ?? "http://localhost:3000";
  }

  /** Which adapter is mounted, and whether it leaves the machine. */
  get adapterDescriptor(): { name: string; performsExternalSideEffects: boolean } {
    return {
      name: this.#adapter.name,
      performsExternalSideEffects: this.#adapter.performsExternalSideEffects,
    };
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async profile(userId: string): Promise<ProfileReport> {
    const profile = await this.#store.getProfile(userId);
    return {
      profile: profile ?? null,
      completeness: profile === undefined ? null : assessCompleteness(profile),
    };
  }

  async saveProfile(userId: string, input: CareerProfileInput): Promise<ProfileReport> {
    const profile = await this.#store.saveProfile({
      userId,
      id: this.#newId(),
      profile: input,
      now: this.#now(),
    });
    return { profile, completeness: assessCompleteness(profile) };
  }

  // ── Ingest and deduplication ──────────────────────────────────────────────

  /**
   * Ingests listings, deduplicating against what the owner already has.
   *
   * Sanitisation happens here and not in the route schema, because the route
   * can only bound a field's length — it cannot strip a bidirectional override
   * or redact a key, and both arrive in practice.
   *
   * The conflict path is not an error case. Two concurrent ingests of one
   * posting race for the unique index; the loser reads the winner's row and
   * merges into it, which is the same outcome as if it had arrived second.
   */
  async ingest(userId: string, inputs: readonly OpportunityIngestInput[]): Promise<IngestReport> {
    const outcomes: IngestOutcome[] = [];

    for (const input of inputs) {
      outcomes.push(await this.#ingestOne(userId, input));
    }

    return {
      created: outcomes.filter((outcome) => outcome.status === "created").length,
      merged: outcomes.filter((outcome) => outcome.status === "merged").length,
      outcomes,
    };
  }

  async #ingestOne(userId: string, input: OpportunityIngestInput): Promise<IngestOutcome> {
    const now = this.#now();

    const title = sanitizeExternalText(input.title, INGEST_LIMITS.title).value;
    const organization = sanitizeExternalText(input.organization, INGEST_LIMITS.organization).value;
    const location = sanitizeExternalText(input.location, INGEST_LIMITS.location).value;
    const description = sanitizeExternalText(input.description, INGEST_LIMITS.description).value;
    const requirements = input.requirements
      .map((item) => sanitizeExternalText(item, INGEST_LIMITS.requirement).value)
      .filter((item) => item.length > 0);
    const externalRef =
      input.externalRef === null
        ? null
        : sanitizeExternalText(input.externalRef, 128).value || null;

    // A title that sanitises to nothing was punctuation and invisible
    // characters. Refusing is better than storing a listing nobody can read.
    if (title === "" || organization === "") {
      throw new ValidationError({
        message: "Ingested listing has no readable title or organisation after sanitisation",
        userMessage: "This listing has no readable title or organisation.",
      });
    }

    const canonicalUrl =
      input.source.url === null ? null : canonicalizeListingUrl(input.source.url);
    const fingerprint = opportunityFingerprint({
      kind: input.kind,
      title,
      organization,
      location,
      externalRef,
    });

    const entry: Provenance = {
      kind: input.source.kind,
      url: canonicalUrl,
      evidence: sanitizeExternalText(input.source.evidence, 400).value,
      observedAt: now,
    };

    const byFingerprint = await this.#store.findOpportunityByFingerprint(userId, fingerprint);
    const byUrl =
      byFingerprint === undefined && canonicalUrl !== null
        ? await this.#store.findOpportunityByCanonicalUrl(userId, canonicalUrl)
        : undefined;
    const known = byFingerprint ?? byUrl;

    if (known !== undefined) {
      const merged = await this.#store.recordSighting({
        userId,
        opportunityId: known.id,
        entry,
        fill: fillableFacts(known, {
          location,
          description,
          requirements,
          compensation: input.compensation,
          postedAt: input.postedAt,
          closesAt: input.closesAt,
          externalRef,
          canonicalUrl,
        }),
        now,
      });

      return {
        fingerprint,
        opportunityId: merged.id,
        status: "merged",
        reason:
          byFingerprint === undefined
            ? "Already known under the same canonical URL; recorded as a further sighting."
            : "Already known under the same content fingerprint; recorded as a further sighting.",
      };
    }

    const record: Opportunity = {
      id: this.#newId(),
      userId,
      kind: input.kind,
      title,
      organization,
      location,
      remote: input.remote,
      description,
      requirements,
      compensation: input.compensation,
      postedAt: input.postedAt,
      closesAt: input.closesAt,
      externalRef,
      canonicalUrl,
      fingerprint,
      provenance: [entry],
      untrustedContent: true,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const created = await this.#store.createOpportunity(record);
      return {
        fingerprint,
        opportunityId: created.id,
        status: "created",
        reason: "No existing listing matched the fingerprint or the canonical URL.",
      };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;

      // Lost a race against a concurrent ingest of the same posting. The
      // winner's row is authoritative; merge into it.
      const winner =
        (await this.#store.findOpportunityByFingerprint(userId, fingerprint)) ??
        (canonicalUrl === null
          ? undefined
          : await this.#store.findOpportunityByCanonicalUrl(userId, canonicalUrl));

      if (winner === undefined) throw error;

      const merged = await this.#store.recordSighting({
        userId,
        opportunityId: winner.id,
        entry,
        fill: {},
        now,
      });
      return {
        fingerprint,
        opportunityId: merged.id,
        status: "merged",
        reason: "A concurrent ingest created this listing first; recorded as a further sighting.",
      };
    }
  }

  // ── Search and ranking ────────────────────────────────────────────────────

  async search(
    userId: string,
    query: { kind?: OpportunityKind; limit: number; includeExcluded: boolean },
  ): Promise<RankedOpportunity[]> {
    const profile = await this.#requireProfile(userId);
    const opportunities = await this.#store.listOpportunities(userId, {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      // Over-fetch so the ranking sees more than one page before cutting.
      limit: Math.min(query.limit * 4, 400),
    });

    const ranked = rankOpportunities({ profile, opportunities, now: this.#now() });
    const byId = new Map(opportunities.map((item) => [item.id, item]));
    const applications = await this.#store.listApplications(userId, { limit: 500 });
    const stateByOpportunity = new Map(
      applications.map((item) => [item.opportunityId, item.state]),
    );

    const results: RankedOpportunity[] = [];
    for (const explanation of ranked) {
      if (explanation.excluded && !query.includeExcluded) continue;
      const opportunity = byId.get(explanation.opportunityId);
      if (opportunity === undefined) continue;
      results.push({
        opportunity,
        explanation,
        applicationState: stateByOpportunity.get(opportunity.id) ?? null,
      });
      if (results.length >= query.limit) break;
    }
    return results;
  }

  // ── Shortlisting ──────────────────────────────────────────────────────────

  /**
   * Keeps an opportunity, creating its application if needed.
   *
   * The match score is frozen at this moment. A later profile edit must not
   * rewrite the number that justified the decision — an audit trail whose
   * figures move is not an audit trail.
   */
  async shortlist(userId: string, opportunityId: string): Promise<Application> {
    const opportunity = await this.#requireOpportunity(userId, opportunityId);
    const profile = await this.#requireProfile(userId);
    const now = this.#now();

    const explanation = rankOpportunities({
      profile,
      opportunities: [opportunity],
      now,
    })[0];

    if (explanation?.excluded === true) {
      throw new ConflictError({
        message: `Shortlist refused for an excluded opportunity: ${explanation.exclusionReason ?? ""}`,
        userMessage: explanation.exclusionReason ?? "This opportunity is excluded by preferences.",
        context: { opportunityId },
      });
    }

    const existing = await this.#store.findApplicationByOpportunity(userId, opportunityId);
    if (existing !== undefined) {
      if (existing.state === "shortlisted") return existing;
      assertTransition({ from: existing.state, to: "shortlisted", applicationId: existing.id });
      return this.#transition(
        existing,
        "shortlisted",
        "application.shortlisted",
        { score: explanation?.score ?? null },
        { matchScore: explanation?.score ?? null },
      );
    }

    const application = await this.#store.createApplication({
      id: this.#newId(),
      userId,
      opportunityId,
      state: "discovered",
      stateChangedAt: now,
      matchScore: explanation?.score ?? null,
      notes: "",
      createdAt: now,
      updatedAt: now,
    });

    await this.#appendEvent(application, "application.discovered", null, "discovered", {
      opportunityId,
      score: explanation?.score ?? null,
      factors: explanation?.factors.map((factor) => factor.factor) ?? [],
    });

    return this.#transition(
      application,
      "shortlisted",
      "application.shortlisted",
      { score: explanation?.score ?? null },
      { matchScore: explanation?.score ?? null },
    );
  }

  // ── Applications ──────────────────────────────────────────────────────────

  listApplications(
    userId: string,
    filter: { state?: ApplicationState; limit: number },
  ): Promise<Application[]> {
    return this.#store.listApplications(userId, filter);
  }

  async applicationDetail(userId: string, applicationId: string): Promise<ApplicationDetail> {
    const application = await this.#requireApplication(userId, applicationId);
    const opportunity = await this.#requireOpportunity(userId, application.opportunityId);

    return {
      application,
      opportunity,
      documents: await this.#store.listDocumentVariants(userId, applicationId),
      contacts: await this.#store.listContacts(userId, { applicationId, limit: 50 }),
      deadlines: await this.#store.listDeadlines(userId, { applicationId, limit: 50 }),
      interviews: await this.#store.listInterviews(userId, applicationId),
      followUps: await this.#store.listFollowUps(userId, { applicationId, limit: 50 }),
      outcome: (await this.#store.getOutcome(userId, applicationId)) ?? null,
      attempts: await this.#store.listAttempts(userId, applicationId),
      confirmations: await this.#store.listConfirmations(userId, applicationId),
    };
  }

  history(userId: string, applicationId: string): Promise<ApplicationEvent[]> {
    return this.#store.listEvents(userId, applicationId);
  }

  /**
   * Moves an application along the lifecycle.
   *
   * `approved` and `submitted` are refused here however legal the transition
   * would be. Those two states are what the confirmation and submission paths
   * exist to grant, and a generic transition endpoint that could reach them
   * would make the whole mechanism optional — which is the same as absent.
   */
  async advance(
    userId: string,
    applicationId: string,
    to: ApplicationState,
    reason: string,
  ): Promise<Application> {
    if (GUARDED_TRANSITION_TARGETS.includes(to)) {
      this.#recordRefusal(userId, "career.transition_guarded", `Generic transition to ${to}`, {
        applicationId,
        to,
      });
      throw new ConflictError({
        message: `Generic transition to ${to} refused: reserved for the approval and submission paths`,
        userMessage:
          to === "approved"
            ? "An application becomes approved by answering its confirmation, not by a state change."
            : "An application becomes submitted by submitting it, not by a state change.",
        context: { applicationId, to },
      });
    }

    const application = await this.#requireApplication(userId, applicationId);
    assertTransition({ from: application.state, to, applicationId });

    // Leaving the approval window invalidates any live approval: the owner has
    // changed their mind about this payload, whatever they said earlier.
    if (application.state === "awaiting_confirmation" || application.state === "approved") {
      await this.#retireLiveConfirmation(userId, applicationId, "expired");
    }

    return this.#transition(application, to, `application.${to}`, { reason });
  }

  /** Begins tailoring documents. Refuses when the profile cannot support it. */
  async startDrafting(userId: string, applicationId: string): Promise<Application> {
    const application = await this.#requireApplication(userId, applicationId);
    if (application.state === "drafting") return application;

    const opportunity = await this.#requireOpportunity(userId, application.opportunityId);
    const profile = await this.#requireProfile(userId);

    const blockers = draftingBlockers(profile, opportunity.kind);
    if (blockers.length > 0) {
      throw new ConflictError({
        message: `Drafting refused, profile incomplete for ${opportunity.kind}: ${blockers.join("; ")}`,
        userMessage: `The profile is missing what this kind of application needs: ${blockers.join(" ")}`,
        context: { applicationId, kind: opportunity.kind },
      });
    }

    assertTransition({ from: application.state, to: "drafting", applicationId });
    return this.#transition(application, "drafting", "application.drafting", {});
  }

  /**
   * Records a tailored document.
   *
   * Only while `drafting`: editing a payload that is awaiting approval, or one
   * already approved, would separate what the owner saw from what would be
   * sent. The owner has to step back to drafting first, which invalidates the
   * approval explicitly rather than behind their back.
   */
  async draftDocument(
    userId: string,
    applicationId: string,
    input: DocumentDraftInput,
  ): Promise<DocumentVariant> {
    const application = await this.#requireApplication(userId, applicationId);
    if (application.state !== "drafting") {
      throw new ConflictError({
        message: `Document draft refused: application is ${application.state}, not drafting`,
        userMessage: isTerminalApplicationState(application.state)
          ? `This application is ${application.state} and no longer accepts documents.`
          : "Move this application back to drafting before changing its documents.",
        context: { applicationId, state: application.state },
      });
    }

    const profile = await this.#requireProfile(userId);

    if (input.parentVariantId !== null) {
      const parent = await this.#store.getDocumentVariant(userId, input.parentVariantId);
      if (parent?.applicationId !== applicationId) {
        throw new NotFoundError({
          message: "Parent document variant is unknown or belongs to another application",
          userMessage: "The requested resource does not exist.",
        });
      }
      if (parent.kind !== input.kind) {
        throw new ValidationError({
          message: `Lineage refused: parent is ${parent.kind}, revision is ${input.kind}`,
          userMessage: "A document revision must have the same kind as the document it revises.",
        });
      }
    }

    const body = sanitizeExternalText(input.body, INGEST_LIMITS.documentBody).value;
    const revision = await this.#store.nextDocumentRevision(userId, applicationId, input.kind);

    const variant = await this.#store.createDocumentVariant({
      id: this.#newId(),
      userId,
      applicationId,
      kind: input.kind,
      revision,
      parentVariantId: input.parentVariantId,
      profileVersion: profile.version,
      contentHash: contentHash(body),
      body,
      createdAt: this.#now(),
    });

    await this.#appendEvent(application, "document.drafted", null, null, {
      documentVariantId: variant.id,
      kind: variant.kind,
      revision: variant.revision,
      contentHash: variant.contentHash,
      profileVersion: variant.profileVersion,
    });

    return variant;
  }

  listDocuments(userId: string, applicationId: string): Promise<DocumentVariant[]> {
    return this.#store.listDocumentVariants(userId, applicationId);
  }

  getDocument(userId: string, documentId: string): Promise<DocumentVariant | undefined> {
    return this.#store.getDocumentVariant(userId, documentId);
  }

  // ── Durable confirmation ──────────────────────────────────────────────────

  /**
   * Asks the owner to approve what would be submitted.
   *
   * Idempotent for an unchanged payload: a second request finds the live
   * approval for the same hash and returns it, rather than queueing a second
   * question. A *changed* payload retires the stale question first, because a
   * question about documents that no longer exist must not remain answerable.
   */
  async requestApproval(
    userId: string,
    applicationId: string,
  ): Promise<{ confirmation: ConfirmationRecord; application: Application }> {
    const application = await this.#requireApplication(userId, applicationId);

    // Checked before anything is written: an application that cannot reach
    // `awaiting_confirmation` must not leave a retired confirmation behind.
    if (application.state !== "awaiting_confirmation") {
      assertTransition({ from: application.state, to: "awaiting_confirmation", applicationId });
    }

    const payload = await this.#buildPayload(userId, application);
    const now = this.#now();

    const live = await this.#store.findLiveConfirmation({
      userId,
      applicationId,
      purpose: "submit_application",
    });

    if (live?.payloadHash === payload.payloadHash && live.expiresAt > now) {
      return { confirmation: live, application };
    }

    if (live !== undefined) {
      await this.#store.updateConfirmation({ userId, id: live.id, state: "expired", now });
      await this.#appendEvent(application, "confirmation.superseded", null, null, {
        confirmationId: live.id,
        reason:
          live.expiresAt <= now
            ? "The previous request expired."
            : "The payload changed after the previous request.",
      });
    }

    const summary =
      `Submit ${payload.documents.length} document(s) for ` +
      `"${payload.opportunity.title}" at ${payload.opportunity.organization}`;

    const confirmation = await this.#store.createConfirmation({
      id: this.#newId(),
      userId,
      applicationId,
      purpose: "submit_application",
      payloadHash: payload.payloadHash,
      state: "pending",
      summary: summary.slice(0, 400),
      requestedAt: now,
      expiresAt: new Date(now.getTime() + this.#confirmationTtlMs),
      decidedAt: null,
      consumedAt: null,
    });

    const moved =
      application.state === "awaiting_confirmation"
        ? application
        : await this.#transition(application, "awaiting_confirmation", "confirmation.requested", {
            confirmationId: confirmation.id,
            payloadHash: confirmation.payloadHash,
          });

    this.#notify({
      userId,
      title: "Approval required before submitting",
      body: confirmation.summary,
      severity: "warning",
      path: `/dashboard?tab=career&confirmationId=${encodeURIComponent(confirmation.id)}`,
      actionTitle: "Review and approve",
      groupKey: `career-confirmation-${confirmation.id}`,
      tags: ["career", "confirmation"],
    });

    return { confirmation, application: moved };
  }

  /**
   * Records the owner's decision.
   *
   * Expiry is evaluated on read rather than by a timer, and silence therefore
   * means refusal: a request answered after its window closes is recorded as
   * expired and authorises nothing. A timer would have the same effect while
   * the process is up and no effect at all across a restart, which is exactly
   * the case that matters.
   */
  async decideConfirmation(
    userId: string,
    confirmationId: string,
    decision: "approved" | "rejected" | "cancelled",
    reason?: string,
  ): Promise<{ confirmation: ConfirmationRecord; application: Application }> {
    const existing = await this.#store.getConfirmation(userId, confirmationId);
    if (existing === undefined) {
      throw new NotFoundError({
        message: `Unknown career confirmation: ${confirmationId}`,
        userMessage: "The requested resource does not exist.",
      });
    }

    const application = await this.#requireApplication(userId, existing.applicationId);
    const now = this.#now();

    if (existing.state !== "pending") {
      throw new ConflictError({
        message: `Confirmation already ${existing.state}`,
        userMessage: `This approval request was already ${existing.state}.`,
        context: { confirmationId },
      });
    }

    if (existing.expiresAt <= now) {
      await this.#store.updateConfirmation({ userId, id: confirmationId, state: "expired", now });
      await this.#appendEvent(application, "confirmation.expired", null, null, { confirmationId });
      const returned = await this.#transition(application, "drafting", "application.drafting", {
        reason: "The approval request expired unanswered.",
      });
      throw new ConflictError({
        message: "Confirmation expired before it was answered",
        userMessage: "This approval request expired. Request approval again to submit.",
        context: { confirmationId, applicationState: returned.state },
      });
    }

    // The payload may have changed since the question was asked even though the
    // application never left `awaiting_confirmation` — a document written
    // through another route, for instance. Approving a stale hash would
    // authorise something nobody read.
    const payload = await this.#buildPayload(userId, application);
    if (decision === "approved" && payload.payloadHash !== existing.payloadHash) {
      await this.#store.updateConfirmation({
        userId,
        id: confirmationId,
        state: "expired",
        now,
      });
      await this.#appendEvent(application, "confirmation.stale", null, null, {
        confirmationId,
        approvedHash: existing.payloadHash,
        currentHash: payload.payloadHash,
      });
      throw new ConflictError({
        message: "Approval refused: the payload changed after the request",
        userMessage: "The documents changed since this request. Request approval again.",
        context: { confirmationId },
      });
    }

    const confirmation = await this.#store.updateConfirmation({
      userId,
      id: confirmationId,
      state: decision,
      now,
    });

    await this.#appendEvent(application, `confirmation.${decision}`, null, null, {
      confirmationId,
      payloadHash: confirmation.payloadHash,
      ...(reason !== undefined ? { reason } : {}),
    });

    const fallbackReason =
      decision === "cancelled"
        ? "The approval request was cancelled."
        : "The owner declined to submit this payload.";

    const moved =
      decision === "approved"
        ? await this.#transition(application, "approved", "application.approved", {
            confirmationId,
            payloadHash: confirmation.payloadHash,
          })
        : await this.#transition(application, "drafting", "application.drafting", {
            reason: reason ?? fallbackReason,
          });

    return { confirmation, application: moved };
  }

  pendingConfirmations(userId: string, applicationId: string): Promise<ConfirmationRecord[]> {
    return this.#store.listConfirmations(userId, applicationId);
  }

  // ── Submission ────────────────────────────────────────────────────────────

  /**
   * Hands the approved payload to the adapter, at most once.
   *
   * The order of checks is the security argument and is worth reading as one:
   * lifecycle first, so a rejected or expired application costs nothing; then
   * the payload, rebuilt from current rows rather than trusted from the
   * request; then the durable approval, matched on that payload's hash; then
   * the idempotency key, which closes the crash window. Only after all four
   * does the adapter see anything.
   */
  async submit(userId: string, applicationId: string): Promise<SubmissionResult> {
    const application = await this.#requireApplication(userId, applicationId);

    try {
      assertSubmittable({ state: application.state, applicationId });
    } catch (error) {
      this.#recordRefusal(
        userId,
        "career.submission_refused",
        `Submission refused in state ${application.state}`,
        { applicationId, state: application.state },
      );
      throw error;
    }

    const payload = await this.#buildPayload(userId, application);
    const now = this.#now();

    const approval = await this.#store.findLiveConfirmation({
      userId,
      applicationId,
      purpose: "submit_application",
    });

    if (approval?.state !== "approved") {
      this.#recordRefusal(
        userId,
        "career.submission_unapproved",
        "Submission attempted without a durable approval",
        { applicationId },
      );
      throw new ConflictError({
        message: "Submission refused: no durable approval is live for this application",
        userMessage: "This submission has not been approved. Request approval first.",
        context: { applicationId },
      });
    }

    if (approval.payloadHash !== payload.payloadHash) {
      this.#recordRefusal(
        userId,
        "career.submission_payload_changed",
        "Submission attempted with a payload that differs from the approved one",
        { applicationId, confirmationId: approval.id },
      );
      throw new ConflictError({
        message: "Submission refused: the payload differs from the approved one",
        userMessage: "The documents changed after approval. Request approval again.",
        context: { applicationId },
      });
    }

    if (approval.expiresAt <= now) {
      await this.#store.updateConfirmation({ userId, id: approval.id, state: "expired", now });
      throw new ConflictError({
        message: "Submission refused: the approval expired",
        userMessage: "The approval expired. Request approval again to submit.",
        context: { applicationId },
      });
    }

    const idempotencyKey = submissionIdempotencyKey({
      applicationId,
      payloadHash: payload.payloadHash,
      confirmationId: approval.id,
    });

    const recorded = await this.#store.findAttemptByIdempotencyKey(userId, idempotencyKey);
    if (recorded !== undefined) return { attempt: recorded, replayed: true };

    let attempt: SubmissionAttempt;
    try {
      attempt = await this.#store.createAttempt({
        id: this.#newId(),
        userId,
        applicationId,
        idempotencyKey,
        confirmationId: approval.id,
        payloadHash: payload.payloadHash,
        adapter: this.#adapter.name,
        state: "pending",
        receipt: null,
        failureReason: null,
        startedAt: now,
        finishedAt: null,
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;

      // Another call won the index between the read above and this insert.
      const winner = await this.#store.findAttemptByIdempotencyKey(userId, idempotencyKey);
      if (winner === undefined) throw error;
      return { attempt: winner, replayed: true };
    }

    try {
      const receipt = await this.#adapter.submit(payload);
      const finished = await this.#store.finishAttempt({
        userId,
        id: attempt.id,
        state: "succeeded",
        receipt: receipt.reference.slice(0, 200),
        failureReason: null,
        now: this.#now(),
      });

      // The approval is spent. Doing this before the transition means a crash
      // between the two leaves an approval that can no longer authorise a
      // second submission, which is the safe way round.
      await this.#store.updateConfirmation({
        userId,
        id: approval.id,
        state: "consumed",
        now: this.#now(),
      });

      await this.#transition(application, "submitted", "application.submitted", {
        attemptId: finished.id,
        adapter: finished.adapter,
        performsExternalSideEffects: this.#adapter.performsExternalSideEffects,
        payloadHash: finished.payloadHash,
      });

      this.#notify({
        userId,
        title: "Application submitted",
        body: `${payload.opportunity.title} at ${payload.opportunity.organization}`,
        severity: "info",
        path: `/dashboard?tab=career&applicationId=${encodeURIComponent(applicationId)}`,
        actionTitle: "View application",
        groupKey: `career-application-${applicationId}`,
        tags: ["career", "submitted"],
      });

      return { attempt: finished, replayed: false };
    } catch (error) {
      const appError = toAppError(error);
      const failed = await this.#store.finishAttempt({
        userId,
        id: attempt.id,
        state: "failed",
        receipt: null,
        // The adapter's message is already redacted by `AppError`; bound it
        // again because a 10 kB failure string in a database column is a
        // denial of service dressed as diagnostics.
        failureReason: appError.userMessage.slice(0, 400),
        now: this.#now(),
      });

      // Unknown outcome: the adapter may have accepted before failing. The
      // approval is spent and the owner is asked again rather than retried.
      await this.#store.updateConfirmation({
        userId,
        id: approval.id,
        state: "consumed",
        now: this.#now(),
      });
      await this.#transition(application, "drafting", "application.drafting", {
        reason: "A submission attempt failed with an unknown outcome; approval must be renewed.",
        attemptId: failed.id,
      });

      throw appError;
    }
  }

  // ── Outcomes ──────────────────────────────────────────────────────────────

  /**
   * Records how it ended.
   *
   * The outcome is a fact about the world and the state is a fact about the
   * process; the two are written together so they cannot disagree, but the
   * outcome row is what statistics read. An outcome whose implied state is
   * unreachable is refused rather than quietly recorded against a state that
   * contradicts it.
   */
  async recordOutcome(
    userId: string,
    applicationId: string,
    input: OutcomeInput,
  ): Promise<{ outcome: Outcome; application: Application }> {
    const application = await this.#requireApplication(userId, applicationId);
    const implied = IMPLIED_STATE[input.result];

    if (application.state !== implied) {
      assertTransition({ from: application.state, to: implied, applicationId });
    }

    const outcome = await this.#store.createOutcome({
      id: this.#newId(),
      userId,
      applicationId,
      result: input.result,
      decidedAt: input.decidedAt,
      notes: sanitizeExternalText(input.notes, INGEST_LIMITS.note).value,
      createdAt: this.#now(),
    });

    const moved =
      application.state === implied
        ? application
        : await this.#transition(application, implied, `outcome.${input.result}`, {
            outcomeId: outcome.id,
            result: outcome.result,
          });

    await this.#appendEvent(moved, "outcome.recorded", null, null, {
      outcomeId: outcome.id,
      result: outcome.result,
    });

    return { outcome, application: moved };
  }

  outcome(userId: string, applicationId: string): Promise<Outcome | undefined> {
    return this.#store.getOutcome(userId, applicationId);
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async addContact(userId: string, input: ContactInput): Promise<Contact> {
    if (input.applicationId !== null) await this.#requireApplication(userId, input.applicationId);
    if (input.opportunityId !== null) await this.#requireOpportunity(userId, input.opportunityId);

    const now = this.#now();
    return this.#store.createContact({
      id: this.#newId(),
      userId,
      applicationId: input.applicationId,
      opportunityId: input.opportunityId,
      displayName: sanitizeExternalText(input.displayName, 120).value,
      role: sanitizeExternalText(input.role, 120).value,
      organization: sanitizeExternalText(input.organization, INGEST_LIMITS.organization).value,
      email: input.email,
      notes: sanitizeExternalText(input.notes, INGEST_LIMITS.note).value,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    });
  }

  listContacts(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<Contact[]> {
    return this.#store.listContacts(userId, filter);
  }

  // ── Deadlines and reminders ───────────────────────────────────────────────

  async addDeadline(
    userId: string,
    applicationId: string,
    input: DeadlineInput,
  ): Promise<Deadline> {
    const application = await this.#requireApplication(userId, applicationId);
    const now = this.#now();

    const deadline = await this.#store.createDeadline({
      id: this.#newId(),
      userId,
      applicationId,
      kind: input.kind,
      dueAt: input.dueAt,
      state: "pending",
      // Descending, so the earliest reminder is examined first and a single
      // sweep cannot fire a later offset before an earlier one.
      reminderOffsetsMinutes: [...new Set(input.reminderOffsetsMinutes)].sort(
        (left, right) => right - left,
      ),
      remindedOffsetsMinutes: [],
      label: sanitizeExternalText(input.label, 200).value,
      createdAt: now,
      updatedAt: now,
    });

    await this.#appendEvent(application, "deadline.added", null, null, {
      deadlineId: deadline.id,
      kind: deadline.kind,
      dueAt: deadline.dueAt.toISOString(),
    });

    return deadline;
  }

  listDeadlines(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<Deadline[]> {
    return this.#store.listDeadlines(userId, { ...filter, state: "pending" });
  }

  /**
   * Fires the reminders that have come due.
   *
   * Idempotent across restarts, and that is the only interesting thing about
   * it: the offsets already notified live in a database column, not in a timer
   * or a set in memory. A process that restarts between two sweeps re-reads
   * what it already sent and sends nothing twice — which matters because a
   * reminder that arrives four times is a reminder the owner turns off.
   */
  async dueReminders(
    userId: string,
    options: { limit: number } = { limit: 50 },
  ): Promise<{ deadline: Deadline; offsetMinutes: number }[]> {
    const now = this.#now();
    const pending = await this.#store.listDeadlines(userId, {
      state: "pending",
      limit: options.limit,
    });

    const fired: { deadline: Deadline; offsetMinutes: number }[] = [];

    for (const deadline of pending) {
      const due = deadline.reminderOffsetsMinutes
        .filter((offset) => !deadline.remindedOffsetsMinutes.includes(offset))
        .filter((offset) => deadline.dueAt.getTime() - offset * 60_000 <= now.getTime())
        // Largest offset first: the "one day before" reminder is sent before
        // the "three hours before" one even if both became due at once.
        .sort((left, right) => right - left);

      for (const offset of due) {
        const updated = await this.#store.updateDeadline({
          userId,
          id: deadline.id,
          recordRemindedOffsetMinutes: offset,
          now,
        });

        this.#notify({
          userId,
          title: `Deadline in ${formatMinutes(offset)}: ${deadline.kind.replace(/_/g, " ")}`,
          body: deadline.label === "" ? "A career deadline is approaching." : deadline.label,
          severity: "warning",
          path: `/dashboard?tab=career&applicationId=${encodeURIComponent(deadline.applicationId)}`,
          actionTitle: "View application",
          groupKey: `career-deadline-${deadline.id}`,
          tags: ["career", "deadline"],
        });

        fired.push({ deadline: updated, offsetMinutes: offset });
      }
    }

    return fired;
  }

  /**
   * Closes applications whose listing deadline has passed.
   *
   * Run on demand rather than on a schedule: this service owns no timer, so an
   * installation decides when to sweep, and the result is the same whether it
   * runs once an hour or once a week. Applications already submitted are left
   * alone — their deadline has been met, whatever the date says.
   */
  async sweepExpired(userId: string): Promise<Application[]> {
    const now = this.#now();
    const applications = await this.#store.listApplications(userId, { limit: 500 });
    const expired: Application[] = [];

    for (const application of applications) {
      if (!PRE_SUBMISSION_STATES.includes(application.state)) continue;

      const opportunity = await this.#store.getOpportunity(userId, application.opportunityId);
      const closesAt = opportunity?.closesAt;
      if (closesAt === undefined || closesAt === null || closesAt > now) continue;

      if (application.state === "awaiting_confirmation" || application.state === "approved") {
        await this.#retireLiveConfirmation(userId, application.id, "expired");
      }

      expired.push(
        await this.#transition(application, "expired", "application.expired", {
          reason: "The listing deadline passed before submission.",
          closesAt: closesAt.toISOString(),
        }),
      );
    }

    return expired;
  }

  // ── Interviews and follow-ups ─────────────────────────────────────────────

  async scheduleInterview(
    userId: string,
    applicationId: string,
    input: InterviewInput,
  ): Promise<{ interview: Interview; application: Application }> {
    const application = await this.#requireApplication(userId, applicationId);
    const now = this.#now();

    const interview = await this.#store.createInterview({
      id: this.#newId(),
      userId,
      applicationId,
      mode: input.mode,
      stage: sanitizeExternalText(input.stage, 120).value,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      state: "scheduled",
      notes: sanitizeExternalText(input.notes, INGEST_LIMITS.note).value,
      createdAt: now,
      updatedAt: now,
    });

    const moved =
      application.state === "interview"
        ? application
        : await this.#transition(application, "interview", "application.interview", {
            interviewId: interview.id,
            stage: interview.stage,
          });

    return { interview, application: moved };
  }

  async completeInterview(
    userId: string,
    interviewId: string,
    state: "completed" | "cancelled" | "no_show",
  ): Promise<Interview> {
    return this.#store.updateInterview({ userId, id: interviewId, state, now: this.#now() });
  }

  listInterviews(userId: string, applicationId: string): Promise<Interview[]> {
    return this.#store.listInterviews(userId, applicationId);
  }

  /**
   * Prepares a follow-up for the owner to send.
   *
   * The draft is stored and shown. Nothing here opens a mailbox, and the
   * channel vocabulary says so: every value ends in `_draft` or is
   * `manual_note`.
   */
  async planFollowUp(
    userId: string,
    applicationId: string,
    input: FollowUpInput,
  ): Promise<FollowUp> {
    const application = await this.#requireApplication(userId, applicationId);
    const now = this.#now();

    const followUp = await this.#store.createFollowUp({
      id: this.#newId(),
      userId,
      applicationId,
      channel: input.channel,
      dueAt: input.dueAt,
      state: input.draft === "" ? "planned" : "drafted",
      draft: sanitizeExternalText(input.draft, INGEST_LIMITS.note).value,
      createdAt: now,
      updatedAt: now,
    });

    await this.#appendEvent(application, "follow_up.planned", null, null, {
      followUpId: followUp.id,
      channel: followUp.channel,
      dueAt: followUp.dueAt.toISOString(),
    });

    return followUp;
  }

  listFollowUps(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<FollowUp[]> {
    return this.#store.listFollowUps(userId, filter);
  }

  markFollowUp(
    userId: string,
    followUpId: string,
    state: "drafted" | "done" | "cancelled",
  ): Promise<FollowUp> {
    return this.#store.updateFollowUp({ userId, id: followUpId, state, now: this.#now() });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Rebuilds the submission payload from current rows.
   *
   * Never from the request. A caller that could supply the payload could supply
   * a different one than the approved hash covers, and the approval would be
   * checked against the attacker's own description of what they were sending.
   */
  async #buildPayload(userId: string, application: Application): Promise<SubmissionPayload> {
    const opportunity = await this.#requireOpportunity(userId, application.opportunityId);
    const documents = await this.#store.latestDocumentVariants(userId, application.id);

    if (documents.length === 0) {
      throw new ConflictError({
        message: "No document variant exists for this application",
        userMessage: "Draft at least one document before requesting approval.",
        context: { applicationId: application.id },
      });
    }

    const contacts = await this.#store.listContacts(userId, {
      applicationId: application.id,
      limit: 10,
    });
    const recipient = contacts.find((contact) => contact.email !== null);
    const recipientHash =
      recipient?.email === undefined || recipient.email === null
        ? null
        : contactEmailHash(recipient.email);

    return {
      applicationId: application.id,
      opportunity: {
        kind: opportunity.kind,
        title: opportunity.title,
        organization: opportunity.organization,
        canonicalUrl: opportunity.canonicalUrl,
      },
      documents: documents.map((variant) => ({
        kind: variant.kind,
        contentHash: variant.contentHash,
        length: variant.body.length,
      })),
      recipientHash,
      payloadHash: submissionPayloadHash({
        opportunityFingerprint: opportunity.fingerprint,
        documentHashes: documents.map((variant) => variant.contentHash),
        contactEmailHash: recipientHash,
      }),
    };
  }

  async #transition(
    application: Application,
    to: ApplicationState,
    kind: string,
    context: Record<string, unknown>,
    patch: { matchScore?: number | null } = {},
  ): Promise<Application> {
    assertTransition({ from: application.state, to, applicationId: application.id });

    const updated = await this.#store.updateApplication({
      userId: application.userId,
      id: application.id,
      state: to,
      ...(patch.matchScore === undefined ? {} : { matchScore: patch.matchScore }),
      now: this.#now(),
    });

    await this.#appendEvent(application, kind, application.state, to, context);
    return updated;
  }

  async #appendEvent(
    application: Application,
    kind: string,
    fromState: ApplicationState | null,
    toState: ApplicationState | null,
    context: Record<string, unknown>,
  ): Promise<ApplicationEvent> {
    return this.#store.appendEvent({
      id: this.#newId(),
      userId: application.userId,
      applicationId: application.id,
      kind,
      fromState,
      toState,
      summary: `${kind}${toState === null ? "" : ` -> ${toState}`}`,
      context: redactForAudit(context),
      now: this.#now(),
    });
  }

  async #retireLiveConfirmation(
    userId: string,
    applicationId: string,
    state: "expired" | "consumed",
  ): Promise<void> {
    const live = await this.#store.findLiveConfirmation({
      userId,
      applicationId,
      purpose: "submit_application",
    });
    if (live === undefined) return;
    await this.#store.updateConfirmation({ userId, id: live.id, state, now: this.#now() });
  }

  async #requireProfile(userId: string): Promise<CareerProfile> {
    const profile = await this.#store.getProfile(userId);
    if (profile === undefined) {
      throw new ConflictError({
        message: "Career profile is required and does not exist",
        userMessage: "Create a career profile before using this feature.",
      });
    }
    return profile;
  }

  async #requireApplication(userId: string, applicationId: string): Promise<Application> {
    const application = await this.#store.getApplication(userId, applicationId);
    if (application === undefined) {
      throw new NotFoundError({
        message: `Unknown career application for this owner: ${applicationId}`,
        // Identical to the message an unknown identifier gets: the difference
        // between "not yours" and "does not exist" is itself information.
        userMessage: "The requested resource does not exist.",
      });
    }
    return application;
  }

  async #requireOpportunity(userId: string, opportunityId: string): Promise<Opportunity> {
    const opportunity = await this.#store.getOpportunity(userId, opportunityId);
    if (opportunity === undefined) {
      throw new NotFoundError({
        message: `Unknown career opportunity for this owner: ${opportunityId}`,
        userMessage: "The requested resource does not exist.",
      });
    }
    return opportunity;
  }

  #recordRefusal(
    userId: string,
    kind: SecurityEventKind,
    summary: string,
    context: Record<string, unknown>,
  ): void {
    this.#securityLog?.record({
      kind,
      userId,
      summary,
      context: redactForAudit(context),
    });
  }

  #notify(input: {
    userId: string;
    title: string;
    body: string;
    severity: "info" | "warning";
    path: string;
    actionTitle: string;
    groupKey: string;
    tags: string[];
  }): void {
    if (this.#notifications === undefined) return;

    void this.#notifications
      .create({
        userId: input.userId,
        title: input.title.slice(0, 120),
        // Bodies are built from listing titles, which are untrusted. They were
        // sanitised on ingest; bounding again here costs nothing and means a
        // later ingest path that forgets cannot reach a push notification.
        body: input.body.slice(0, 400),
        severity: input.severity,
        url: `${this.#dashboardBaseUrl.replace(/\/$/, "")}${input.path}`,
        actionTitle: input.actionTitle,
        groupKey: input.groupKey,
        tags: input.tags,
      })
      .catch(() => {
        // A notification failure must not undo a state change that succeeded.
      });
  }
}

/** States in which a passed deadline means the opportunity was lost. */
const PRE_SUBMISSION_STATES: readonly ApplicationState[] = [
  "discovered",
  "shortlisted",
  "drafting",
  "awaiting_confirmation",
  "approved",
];

/** The lifecycle state each outcome implies. */
const IMPLIED_STATE: Readonly<Record<OutcomeInput["result"], ApplicationState>> = {
  offer: "offer",
  rejection: "rejected",
  no_response: "expired",
  withdrawn: "withdrawn",
  expired: "expired",
};

/**
 * Facts a new sighting may contribute.
 *
 * Only what is currently absent, and only from the incoming sighting. A listing
 * whose deadline was read from the institution's own page must not have that
 * date rewritten by an aggregator that guessed — so the rule is "fill the
 * blanks, never correct the record", and a disagreement between two sources
 * stays visible in `provenance` instead of being resolved silently.
 */
function fillableFacts(
  known: Opportunity,
  incoming: {
    location: string;
    description: string;
    requirements: string[];
    compensation: Opportunity["compensation"];
    postedAt: Date | null;
    closesAt: Date | null;
    externalRef: string | null;
    canonicalUrl: string | null;
  },
): Partial<Opportunity> {
  const fill: Partial<Opportunity> = {};

  if (known.location === "" && incoming.location !== "") fill.location = incoming.location;
  if (known.description === "" && incoming.description !== "") {
    fill.description = incoming.description;
  }
  if (known.requirements.length === 0 && incoming.requirements.length > 0) {
    fill.requirements = incoming.requirements;
  }
  if (known.compensation === null && incoming.compensation !== null) {
    fill.compensation = incoming.compensation;
  }
  if (known.postedAt === null && incoming.postedAt !== null) fill.postedAt = incoming.postedAt;
  if (known.closesAt === null && incoming.closesAt !== null) fill.closesAt = incoming.closesAt;
  if (known.externalRef === null && incoming.externalRef !== null) {
    fill.externalRef = incoming.externalRef;
  }
  if (known.canonicalUrl === null && incoming.canonicalUrl !== null) {
    fill.canonicalUrl = incoming.canonicalUrl;
  }

  return fill;
}

function formatMinutes(minutes: number): string {
  if (minutes >= 1_440) return `${String(Math.round(minutes / 1_440))} day(s)`;
  if (minutes >= 60) return `${String(Math.round(minutes / 60))} hour(s)`;
  return `${String(minutes)} minute(s)`;
}
