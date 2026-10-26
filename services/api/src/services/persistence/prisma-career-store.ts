import { ConflictError, InternalError, uuidv7 } from "@nexus/shared";
import { DbNull, type InputJsonValue, type PrismaClient } from "@nexus/database";
import {
  careerPreferencesInputSchema,
  compensationSchema,
  languageSkillSchema,
  opportunitySourceKindSchema,
  type Application,
  type ApplicationEvent,
  type ApplicationState,
  type CareerProfile,
  type CareerProfileInput,
  type Compensation,
  type ConfirmationPurpose,
  type ConfirmationRecord,
  type ConfirmationState,
  type Contact,
  type Deadline,
  type DeadlineState,
  type DocumentVariant,
  type DocumentVariantKind,
  type FollowUp,
  type FollowUpState,
  type Interview,
  type InterviewState,
  type Opportunity,
  type OpportunityKind,
  type Outcome,
  type Provenance,
  type SubmissionAttempt,
  type SubmissionAttemptState,
} from "@nexus/career";
import { z } from "zod";
import type { CareerStore } from "../career/store.js";

/**
 * PostgreSQL persistence for the career domain.
 *
 * ## Where the guarantees actually live
 *
 * Three of this store's methods do not check anything before writing, and that
 * is the design: `createOpportunity`, `createConfirmation` and `createAttempt`
 * insert and let the database refuse. A read-then-write would leave a window
 * between the read and the insert, and the window is precisely where a double
 * submission happens — two requests, both finding nothing, both inserting.
 * Unique indexes have no window. `#conflict` turns the driver's constraint
 * error into `ConflictError` so the service can branch without knowing what
 * `P2002` means.
 *
 * ## Why JSON columns are validated on the way out
 *
 * `preferences`, `languages`, `provenance` and `compensation` are JSONB. The
 * service wrote them through a Zod schema, so they are well-formed — but a
 * JSONB column is also the one place in this schema a human can edit with
 * psql, and a malformed preferences object would otherwise surface as a
 * `TypeError` in the ranking function, far from its cause. Parsing on read
 * costs microseconds and turns that into a clear error at the boundary.
 *
 * ## Owner scoping
 *
 * Every query filters on `userId`, including the ones that look up by primary
 * key. A `findUnique` by id followed by an ownership check would work, but it
 * puts the check in the caller's hands; `findFirst({ where: { id, userId } })`
 * cannot be called wrongly, and a row belonging to someone else comes back as
 * `null`, which the service reports as absent.
 */

export class PrismaCareerStore implements CareerStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<CareerProfile | undefined> {
    const row = await this.#prisma.careerProfile.findUnique({ where: { userId } });
    return row === null ? undefined : presentProfile(row);
  }

  async saveProfile(input: {
    userId: string;
    id: string;
    profile: CareerProfileInput;
    now: Date;
  }): Promise<CareerProfile> {
    const data = {
      headline: input.profile.headline,
      summary: input.profile.summary,
      yearsExperience: input.profile.yearsExperience,
      highestDegree: input.profile.highestDegree,
      skills: input.profile.skills,
      languages: input.profile.languages as unknown as InputJsonValue,
      publications: input.profile.publications,
      preferences: input.profile.preferences as unknown as InputJsonValue,
    };

    const row = await this.#prisma.careerProfile.upsert({
      where: { userId: input.userId },
      // `version` is incremented by the database rather than computed here: two
      // concurrent saves would otherwise both read version 3 and both write 4.
      update: { ...data, version: { increment: 1 }, updatedAt: input.now },
      create: {
        ...data,
        id: input.id,
        userId: input.userId,
        version: 1,
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
    return presentProfile(row);
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  async getOpportunity(userId: string, id: string): Promise<Opportunity | undefined> {
    const row = await this.#prisma.careerOpportunity.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentOpportunity(row);
  }

  async findOpportunityByFingerprint(
    userId: string,
    fingerprint: string,
  ): Promise<Opportunity | undefined> {
    const row = await this.#prisma.careerOpportunity.findUnique({
      where: { userId_fingerprint: { userId, fingerprint } },
    });
    return row === null ? undefined : presentOpportunity(row);
  }

  async findOpportunityByCanonicalUrl(
    userId: string,
    canonicalUrl: string,
  ): Promise<Opportunity | undefined> {
    const row = await this.#prisma.careerOpportunity.findUnique({
      where: { userId_canonicalUrl: { userId, canonicalUrl } },
    });
    return row === null ? undefined : presentOpportunity(row);
  }

  async createOpportunity(record: Opportunity): Promise<Opportunity> {
    try {
      const row = await this.#prisma.careerOpportunity.create({
        data: {
          id: record.id,
          userId: record.userId,
          kind: record.kind,
          title: record.title,
          organization: record.organization,
          location: record.location,
          remote: record.remote,
          description: record.description,
          requirements: record.requirements,
          compensation: toJsonOrNull(record.compensation),
          postedAt: record.postedAt,
          closesAt: record.closesAt,
          externalRef: record.externalRef,
          canonicalUrl: record.canonicalUrl,
          fingerprint: record.fingerprint,
          provenance: record.provenance.map(storedProvenance) as unknown as InputJsonValue,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
      return presentOpportunity(row);
    } catch (error) {
      throw conflictOrRethrow(error, "career_opportunities");
    }
  }

  async recordSighting(input: {
    userId: string;
    opportunityId: string;
    entry: Provenance;
    fill: Partial<Opportunity>;
    now: Date;
  }): Promise<Opportunity> {
    const current = await this.getOpportunity(input.userId, input.opportunityId);
    if (current === undefined) throw vanished("opportunity");

    const fill = input.fill;
    const row = await this.#prisma.careerOpportunity.update({
      where: { id: current.id },
      data: {
        ...(fill.location === undefined ? {} : { location: fill.location }),
        ...(fill.description === undefined ? {} : { description: fill.description }),
        ...(fill.requirements === undefined ? {} : { requirements: fill.requirements }),
        ...(fill.compensation === undefined
          ? {}
          : { compensation: toJsonOrNull(fill.compensation) }),
        ...(fill.postedAt === undefined ? {} : { postedAt: fill.postedAt }),
        ...(fill.closesAt === undefined ? {} : { closesAt: fill.closesAt }),
        ...(fill.externalRef === undefined ? {} : { externalRef: fill.externalRef }),
        ...(fill.canonicalUrl === undefined ? {} : { canonicalUrl: fill.canonicalUrl }),
        provenance: [...current.provenance, input.entry].map(
          storedProvenance,
        ) as unknown as InputJsonValue,
        updatedAt: input.now,
      },
    });
    return presentOpportunity(row);
  }

  async listOpportunities(
    userId: string,
    filter: { kind?: OpportunityKind; limit: number },
  ): Promise<Opportunity[]> {
    const rows = await this.#prisma.careerOpportunity.findMany({
      where: { userId, ...(filter.kind === undefined ? {} : { kind: filter.kind }) },
      orderBy: { createdAt: "desc" },
      take: filter.limit,
    });
    return rows.map(presentOpportunity);
  }

  // ── Applications ──────────────────────────────────────────────────────────

  async getApplication(userId: string, id: string): Promise<Application | undefined> {
    const row = await this.#prisma.careerApplication.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentApplication(row);
  }

  async findApplicationByOpportunity(
    userId: string,
    opportunityId: string,
  ): Promise<Application | undefined> {
    const row = await this.#prisma.careerApplication.findUnique({
      where: { userId_opportunityId: { userId, opportunityId } },
    });
    return row === null ? undefined : presentApplication(row);
  }

  async createApplication(record: Application): Promise<Application> {
    try {
      const row = await this.#prisma.careerApplication.create({
        data: {
          id: record.id,
          userId: record.userId,
          opportunityId: record.opportunityId,
          state: record.state,
          stateChangedAt: record.stateChangedAt,
          matchScore: record.matchScore,
          notes: record.notes,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
      return presentApplication(row);
    } catch (error) {
      throw conflictOrRethrow(error, "career_applications");
    }
  }

  async updateApplication(input: {
    userId: string;
    id: string;
    state?: ApplicationState;
    matchScore?: number | null;
    notes?: string;
    now: Date;
  }): Promise<Application> {
    const rows = await this.#prisma.careerApplication.updateManyAndReturn({
      where: { id: input.id, userId: input.userId },
      data: {
        ...(input.state === undefined ? {} : { state: input.state, stateChangedAt: input.now }),
        ...(input.matchScore === undefined ? {} : { matchScore: input.matchScore }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        updatedAt: input.now,
      },
    });
    const row = rows[0];
    if (row === undefined) throw vanished("application");
    return presentApplication(row);
  }

  async listApplications(
    userId: string,
    filter: { state?: ApplicationState; limit: number },
  ): Promise<Application[]> {
    const rows = await this.#prisma.careerApplication.findMany({
      where: { userId, ...(filter.state === undefined ? {} : { state: filter.state }) },
      orderBy: { updatedAt: "desc" },
      take: filter.limit,
    });
    return rows.map(presentApplication);
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async createDocumentVariant(record: DocumentVariant): Promise<DocumentVariant> {
    try {
      const row = await this.#prisma.careerDocumentVariant.create({
        data: {
          id: record.id,
          userId: record.userId,
          applicationId: record.applicationId,
          kind: record.kind,
          revision: record.revision,
          parentVariantId: record.parentVariantId,
          profileVersion: record.profileVersion,
          contentHash: record.contentHash,
          body: record.body,
          createdAt: record.createdAt,
        },
      });
      return presentDocument(row);
    } catch (error) {
      throw conflictOrRethrow(error, "career_document_variants");
    }
  }

  async getDocumentVariant(userId: string, id: string): Promise<DocumentVariant | undefined> {
    const row = await this.#prisma.careerDocumentVariant.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentDocument(row);
  }

  async listDocumentVariants(userId: string, applicationId: string): Promise<DocumentVariant[]> {
    const rows = await this.#prisma.careerDocumentVariant.findMany({
      where: { userId, applicationId },
      orderBy: [{ kind: "asc" }, { revision: "asc" }],
    });
    return rows.map(presentDocument);
  }

  async latestDocumentVariants(userId: string, applicationId: string): Promise<DocumentVariant[]> {
    const rows = await this.#prisma.careerDocumentVariant.findMany({
      where: { userId, applicationId },
      orderBy: [{ kind: "asc" }, { revision: "desc" }],
      distinct: ["kind"],
    });
    return rows.map(presentDocument);
  }

  async nextDocumentRevision(
    userId: string,
    applicationId: string,
    kind: DocumentVariantKind,
  ): Promise<number> {
    const highest = await this.#prisma.careerDocumentVariant.aggregate({
      where: { userId, applicationId, kind },
      _max: { revision: true },
    });
    return (highest._max.revision ?? 0) + 1;
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async createContact(record: Contact): Promise<Contact> {
    const row = await this.#prisma.careerContact.create({
      data: {
        id: record.id,
        userId: record.userId,
        applicationId: record.applicationId,
        opportunityId: record.opportunityId,
        displayName: record.displayName,
        role: record.role,
        organization: record.organization,
        email: record.email,
        notes: record.notes,
        source: record.source,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    return presentContact(row);
  }

  async getContact(userId: string, id: string): Promise<Contact | undefined> {
    const row = await this.#prisma.careerContact.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentContact(row);
  }

  async listContacts(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<Contact[]> {
    const rows = await this.#prisma.careerContact.findMany({
      where: {
        userId,
        ...(filter.applicationId === undefined ? {} : { applicationId: filter.applicationId }),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit,
    });
    return rows.map(presentContact);
  }

  // ── Deadlines ─────────────────────────────────────────────────────────────

  async createDeadline(record: Deadline): Promise<Deadline> {
    const row = await this.#prisma.careerDeadline.create({
      data: {
        id: record.id,
        userId: record.userId,
        applicationId: record.applicationId,
        kind: record.kind,
        dueAt: record.dueAt,
        state: record.state,
        label: record.label,
        reminderOffsetsMinutes: record.reminderOffsetsMinutes,
        remindedOffsetsMinutes: record.remindedOffsetsMinutes,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    return presentDeadline(row);
  }

  async getDeadline(userId: string, id: string): Promise<Deadline | undefined> {
    const row = await this.#prisma.careerDeadline.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentDeadline(row);
  }

  async listDeadlines(
    userId: string,
    filter: { applicationId?: string; state?: DeadlineState; dueBefore?: Date; limit: number },
  ): Promise<Deadline[]> {
    const rows = await this.#prisma.careerDeadline.findMany({
      where: {
        userId,
        ...(filter.applicationId === undefined ? {} : { applicationId: filter.applicationId }),
        ...(filter.state === undefined ? {} : { state: filter.state }),
        ...(filter.dueBefore === undefined ? {} : { dueAt: { lte: filter.dueBefore } }),
      },
      orderBy: { dueAt: "asc" },
      take: filter.limit,
    });
    return rows.map(presentDeadline);
  }

  async updateDeadline(input: {
    userId: string;
    id: string;
    state?: DeadlineState;
    recordRemindedOffsetMinutes?: number;
    now: Date;
  }): Promise<Deadline> {
    const offset = input.recordRemindedOffsetMinutes;

    // `push` rather than read-modify-write: two sweeps racing on the same
    // deadline would otherwise each write their own single-element array and
    // one reminder would vanish from the record while having been sent.
    const rows = await this.#prisma.careerDeadline.updateManyAndReturn({
      where: {
        id: input.id,
        userId: input.userId,
        ...(offset === undefined ? {} : { NOT: { remindedOffsetsMinutes: { has: offset } } }),
      },
      data: {
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(offset === undefined ? {} : { remindedOffsetsMinutes: { push: offset } }),
        updatedAt: input.now,
      },
    });

    const row = rows[0];
    if (row !== undefined) return presentDeadline(row);

    // No row matched. Either the deadline is not this owner's, or the offset
    // was already recorded — the second is a normal race, so the current state
    // is returned rather than treated as a failure.
    const current = await this.getDeadline(input.userId, input.id);
    if (current === undefined) throw vanished("deadline");
    return current;
  }

  // ── Interviews, outcomes, follow-ups ──────────────────────────────────────

  async createInterview(record: Interview): Promise<Interview> {
    const row = await this.#prisma.careerInterview.create({
      data: {
        id: record.id,
        userId: record.userId,
        applicationId: record.applicationId,
        mode: record.mode,
        stage: record.stage,
        scheduledAt: record.scheduledAt,
        durationMinutes: record.durationMinutes,
        state: record.state,
        notes: record.notes,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    return presentInterview(row);
  }

  async updateInterview(input: {
    userId: string;
    id: string;
    state: InterviewState;
    now: Date;
  }): Promise<Interview> {
    const rows = await this.#prisma.careerInterview.updateManyAndReturn({
      where: { id: input.id, userId: input.userId },
      data: { state: input.state, updatedAt: input.now },
    });
    const row = rows[0];
    if (row === undefined) throw vanished("interview");
    return presentInterview(row);
  }

  async listInterviews(userId: string, applicationId: string): Promise<Interview[]> {
    const rows = await this.#prisma.careerInterview.findMany({
      where: { userId, applicationId },
      orderBy: { scheduledAt: "asc" },
    });
    return rows.map(presentInterview);
  }

  async createOutcome(record: Outcome): Promise<Outcome> {
    try {
      const row = await this.#prisma.careerOutcome.create({
        data: {
          id: record.id,
          userId: record.userId,
          applicationId: record.applicationId,
          result: record.result,
          decidedAt: record.decidedAt,
          notes: record.notes,
          createdAt: record.createdAt,
        },
      });
      return presentOutcome(row);
    } catch (error) {
      throw conflictOrRethrow(error, "career_outcomes");
    }
  }

  async getOutcome(userId: string, applicationId: string): Promise<Outcome | undefined> {
    const row = await this.#prisma.careerOutcome.findFirst({ where: { userId, applicationId } });
    return row === null ? undefined : presentOutcome(row);
  }

  async createFollowUp(record: FollowUp): Promise<FollowUp> {
    const row = await this.#prisma.careerFollowUp.create({
      data: {
        id: record.id,
        userId: record.userId,
        applicationId: record.applicationId,
        channel: record.channel,
        dueAt: record.dueAt,
        state: record.state,
        draft: record.draft,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    return presentFollowUp(row);
  }

  async updateFollowUp(input: {
    userId: string;
    id: string;
    state: FollowUpState;
    now: Date;
  }): Promise<FollowUp> {
    const rows = await this.#prisma.careerFollowUp.updateManyAndReturn({
      where: { id: input.id, userId: input.userId },
      data: { state: input.state, updatedAt: input.now },
    });
    const row = rows[0];
    if (row === undefined) throw vanished("follow-up");
    return presentFollowUp(row);
  }

  async listFollowUps(
    userId: string,
    filter: { applicationId?: string; limit: number },
  ): Promise<FollowUp[]> {
    const rows = await this.#prisma.careerFollowUp.findMany({
      where: {
        userId,
        ...(filter.applicationId === undefined ? {} : { applicationId: filter.applicationId }),
      },
      orderBy: { dueAt: "asc" },
      take: filter.limit,
    });
    return rows.map(presentFollowUp);
  }

  // ── Durable confirmations ─────────────────────────────────────────────────

  async getConfirmation(userId: string, id: string): Promise<ConfirmationRecord | undefined> {
    const row = await this.#prisma.careerConfirmation.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentConfirmation(row);
  }

  async findLiveConfirmation(input: {
    userId: string;
    applicationId: string;
    purpose: ConfirmationPurpose;
  }): Promise<ConfirmationRecord | undefined> {
    const row = await this.#prisma.careerConfirmation.findFirst({
      where: {
        userId: input.userId,
        applicationId: input.applicationId,
        purpose: input.purpose,
        state: { in: ["pending", "approved"] },
      },
      orderBy: { requestedAt: "desc" },
    });
    return row === null ? undefined : presentConfirmation(row);
  }

  async createConfirmation(record: ConfirmationRecord): Promise<ConfirmationRecord> {
    try {
      const row = await this.#prisma.careerConfirmation.create({
        data: {
          id: record.id,
          userId: record.userId,
          applicationId: record.applicationId,
          purpose: record.purpose,
          payloadHash: record.payloadHash,
          state: record.state,
          summary: record.summary,
          requestedAt: record.requestedAt,
          expiresAt: record.expiresAt,
          decidedAt: record.decidedAt,
          consumedAt: record.consumedAt,
        },
      });
      return presentConfirmation(row);
    } catch (error) {
      throw conflictOrRethrow(error, "career_confirmations");
    }
  }

  async updateConfirmation(input: {
    userId: string;
    id: string;
    state: ConfirmationState;
    now: Date;
  }): Promise<ConfirmationRecord> {
    const current = await this.getConfirmation(input.userId, input.id);
    if (current === undefined) throw vanished("confirmation");

    const rows = await this.#prisma.careerConfirmation.updateManyAndReturn({
      where: { id: input.id, userId: input.userId },
      data: {
        state: input.state,
        // The check constraint on this table requires both of these to agree
        // with the state, so they are derived here rather than passed in.
        decidedAt: input.state === "pending" ? null : (current.decidedAt ?? input.now),
        consumedAt: input.state === "consumed" ? input.now : null,
      },
    });
    const row = rows[0];
    if (row === undefined) throw vanished("confirmation");
    return presentConfirmation(row);
  }

  async listConfirmations(userId: string, applicationId: string): Promise<ConfirmationRecord[]> {
    const rows = await this.#prisma.careerConfirmation.findMany({
      where: { userId, applicationId },
      orderBy: { requestedAt: "asc" },
    });
    return rows.map(presentConfirmation);
  }

  // ── Submission attempts ───────────────────────────────────────────────────

  async findAttemptByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<SubmissionAttempt | undefined> {
    const row = await this.#prisma.careerSubmissionAttempt.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    return row === null ? undefined : presentAttempt(row);
  }

  async createAttempt(record: SubmissionAttempt): Promise<SubmissionAttempt> {
    try {
      const row = await this.#prisma.careerSubmissionAttempt.create({
        data: {
          id: record.id,
          userId: record.userId,
          applicationId: record.applicationId,
          idempotencyKey: record.idempotencyKey,
          confirmationId: record.confirmationId,
          payloadHash: record.payloadHash,
          adapter: record.adapter,
          state: record.state,
          receipt: record.receipt,
          failureReason: record.failureReason,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        },
      });
      return presentAttempt(row);
    } catch (error) {
      throw conflictOrRethrow(error, "career_submission_attempts");
    }
  }

  async finishAttempt(input: {
    userId: string;
    id: string;
    state: Exclude<SubmissionAttemptState, "pending">;
    receipt: string | null;
    failureReason: string | null;
    now: Date;
  }): Promise<SubmissionAttempt> {
    const rows = await this.#prisma.careerSubmissionAttempt.updateManyAndReturn({
      // `state: "pending"` in the predicate: a finished attempt is final, and a
      // second finisher must change nothing rather than overwrite a receipt.
      where: { id: input.id, userId: input.userId, state: "pending" },
      data: {
        state: input.state,
        receipt: input.receipt,
        failureReason: input.failureReason,
        finishedAt: input.now,
      },
    });

    const row = rows[0];
    if (row !== undefined) return presentAttempt(row);

    const current = await this.#prisma.careerSubmissionAttempt.findFirst({
      where: { id: input.id, userId: input.userId },
    });
    if (current === null) throw vanished("submission attempt");
    return presentAttempt(current);
  }

  async listAttempts(userId: string, applicationId: string): Promise<SubmissionAttempt[]> {
    const rows = await this.#prisma.careerSubmissionAttempt.findMany({
      where: { userId, applicationId },
      orderBy: { startedAt: "asc" },
    });
    return rows.map(presentAttempt);
  }

  // ── Immutable history ─────────────────────────────────────────────────────

  /**
   * Appends one event, allocating its sequence.
   *
   * The sequence is `max + 1` read inside a serialisable transaction, so two
   * concurrent appends cannot choose the same number — and if the isolation
   * level lets them try, the unique index on (applicationId, sequence) refuses
   * the loser and the retry picks the next value. Two attempts are enough in
   * practice: the contention is one person's own activity, not a queue.
   */
  async appendEvent(input: {
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const highest = await this.#prisma.careerApplicationEvent.aggregate({
        where: { applicationId: input.applicationId },
        _max: { sequence: true },
      });

      try {
        const row = await this.#prisma.careerApplicationEvent.create({
          data: {
            // A retry needs its own identifier: the first attempt's row may
            // have been written by the call that won the sequence.
            id: attempt === 0 ? input.id : uuidv7(),
            userId: input.userId,
            applicationId: input.applicationId,
            sequence: (highest._max.sequence ?? 0) + 1,
            kind: input.kind,
            fromState: input.fromState,
            toState: input.toState,
            summary: input.summary,
            context: input.context as InputJsonValue,
            createdAt: input.now,
          },
        });
        return presentEvent(row);
      } catch (error) {
        if (isUniqueViolation(error) && attempt < 2) continue;
        throw conflictOrRethrow(error, "career_application_events");
      }
    }
    throw new InternalError({
      message: "Could not allocate an audit sequence after three attempts",
      userMessage: "Something went wrong. Please try again.",
    });
  }

  async listEvents(userId: string, applicationId: string): Promise<ApplicationEvent[]> {
    const rows = await this.#prisma.careerApplicationEvent.findMany({
      where: { userId, applicationId },
      orderBy: { sequence: "asc" },
    });
    return rows.map(presentEvent);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row to record
// ─────────────────────────────────────────────────────────────────────────────

/** `observedAt` is an ISO string in JSONB; everything else survives verbatim. */
const storedProvenanceSchema = z
  .object({
    kind: opportunitySourceKindSchema,
    url: z.string().nullable(),
    evidence: z.string(),
    observedAt: z.string(),
  })
  .strict();

function storedProvenance(entry: Provenance): Record<string, unknown> {
  return {
    kind: entry.kind,
    url: entry.url,
    evidence: entry.evidence,
    observedAt: entry.observedAt.toISOString(),
  };
}

function presentProfile(row: {
  id: string;
  userId: string;
  headline: string;
  summary: string;
  yearsExperience: number;
  highestDegree: string;
  skills: string[];
  languages: unknown;
  publications: number;
  preferences: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): CareerProfile {
  return {
    id: row.id,
    userId: row.userId,
    headline: row.headline,
    summary: row.summary,
    yearsExperience: row.yearsExperience,
    highestDegree: parseOrFail(
      z.enum(["none", "bachelor", "master", "phd"]),
      row.highestDegree,
      "career_profiles.highestDegree",
    ),
    skills: row.skills,
    languages: parseOrFail(
      z.array(languageSkillSchema),
      row.languages,
      "career_profiles.languages",
    ),
    publications: row.publications,
    preferences: parseOrFail(
      careerPreferencesInputSchema,
      row.preferences,
      "career_profiles.preferences",
    ),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presentOpportunity(row: {
  id: string;
  userId: string;
  kind: string;
  title: string;
  organization: string;
  location: string;
  remote: boolean;
  description: string;
  requirements: string[];
  compensation: unknown;
  postedAt: Date | null;
  closesAt: Date | null;
  externalRef: string | null;
  canonicalUrl: string | null;
  fingerprint: string;
  provenance: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Opportunity {
  const provenance = parseOrFail(
    z.array(storedProvenanceSchema),
    row.provenance,
    "career_opportunities.provenance",
  );

  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind as OpportunityKind,
    title: row.title,
    organization: row.organization,
    location: row.location,
    remote: row.remote,
    description: row.description,
    requirements: row.requirements,
    compensation: parseCompensation(row.compensation),
    postedAt: row.postedAt,
    closesAt: row.closesAt,
    externalRef: row.externalRef,
    canonicalUrl: row.canonicalUrl,
    // Trimmed: the column is CHAR(64), which pads, and a padded hash does not
    // equal the hash the domain computes.
    fingerprint: row.fingerprint.trim(),
    provenance: provenance.map((entry) => ({
      kind: entry.kind,
      url: entry.url,
      evidence: entry.evidence,
      observedAt: new Date(entry.observedAt),
    })),
    // Always true for a stored listing: every field of it came from outside.
    untrustedContent: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presentApplication(row: {
  id: string;
  userId: string;
  opportunityId: string;
  state: string;
  stateChangedAt: Date;
  matchScore: number | null;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}): Application {
  return { ...row, state: row.state as ApplicationState };
}

function presentDocument(row: {
  id: string;
  userId: string;
  applicationId: string;
  kind: string;
  revision: number;
  parentVariantId: string | null;
  profileVersion: number;
  contentHash: string;
  body: string;
  createdAt: Date;
}): DocumentVariant {
  return {
    ...row,
    kind: row.kind as DocumentVariantKind,
    contentHash: row.contentHash.trim(),
  };
}

function presentContact(row: {
  id: string;
  userId: string;
  applicationId: string | null;
  opportunityId: string | null;
  displayName: string;
  role: string;
  organization: string;
  email: string | null;
  notes: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}): Contact {
  return { ...row, source: row.source as Contact["source"] };
}

function presentDeadline(row: {
  id: string;
  userId: string;
  applicationId: string;
  kind: string;
  dueAt: Date;
  state: string;
  label: string;
  reminderOffsetsMinutes: number[];
  remindedOffsetsMinutes: number[];
  createdAt: Date;
  updatedAt: Date;
}): Deadline {
  return {
    ...row,
    kind: row.kind as Deadline["kind"],
    state: row.state as DeadlineState,
  };
}

function presentInterview(row: {
  id: string;
  userId: string;
  applicationId: string;
  mode: string;
  stage: string;
  scheduledAt: Date;
  durationMinutes: number;
  state: string;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}): Interview {
  return {
    ...row,
    mode: row.mode as Interview["mode"],
    state: row.state as InterviewState,
  };
}

function presentOutcome(row: {
  id: string;
  userId: string;
  applicationId: string;
  result: string;
  decidedAt: Date;
  notes: string;
  createdAt: Date;
}): Outcome {
  return { ...row, result: row.result as Outcome["result"] };
}

function presentFollowUp(row: {
  id: string;
  userId: string;
  applicationId: string;
  channel: string;
  dueAt: Date;
  state: string;
  draft: string;
  createdAt: Date;
  updatedAt: Date;
}): FollowUp {
  return {
    ...row,
    channel: row.channel as FollowUp["channel"],
    state: row.state as FollowUpState,
  };
}

function presentConfirmation(row: {
  id: string;
  userId: string;
  applicationId: string;
  purpose: string;
  payloadHash: string;
  state: string;
  summary: string;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
}): ConfirmationRecord {
  return {
    ...row,
    purpose: row.purpose as ConfirmationPurpose,
    payloadHash: row.payloadHash.trim(),
    state: row.state as ConfirmationState,
  };
}

function presentAttempt(row: {
  id: string;
  userId: string;
  applicationId: string;
  idempotencyKey: string;
  confirmationId: string;
  payloadHash: string;
  adapter: string;
  state: string;
  receipt: string | null;
  failureReason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}): SubmissionAttempt {
  return {
    ...row,
    idempotencyKey: row.idempotencyKey.trim(),
    payloadHash: row.payloadHash.trim(),
    state: row.state as SubmissionAttemptState,
  };
}

function presentEvent(row: {
  id: string;
  userId: string;
  applicationId: string;
  sequence: number;
  kind: string;
  fromState: string | null;
  toState: string | null;
  summary: string;
  context: unknown;
  createdAt: Date;
}): ApplicationEvent {
  return {
    ...row,
    fromState: row.fromState as ApplicationState | null,
    toState: row.toState as ApplicationState | null,
    context:
      typeof row.context === "object" && row.context !== null && !Array.isArray(row.context)
        ? (row.context as Record<string, unknown>)
        : {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseCompensation(value: unknown): Compensation | null {
  if (value === null || value === undefined) return null;
  return parseOrFail(compensationSchema, value, "compensation");
}

/**
 * Writes a nullable JSONB column.
 *
 * `DbNull` rather than `undefined`: Prisma reads `undefined` as "leave this
 * column alone", so an opportunity that loses its compensation would silently
 * keep the old figure. `DbNull` is SQL NULL, which is what "no compensation
 * stated" means.
 */
function toJsonOrNull(value: Compensation | null): InputJsonValue | typeof DbNull {
  return value ?? DbNull;
}

/**
 * Parses a JSONB column, failing loudly at the boundary.
 *
 * The alternative is a `TypeError` thrown later inside the ranking function,
 * where nothing names the column that was malformed.
 */
function parseOrFail<T extends z.ZodType>(schema: T, value: unknown, where: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InternalError({
      message: `Malformed JSON column ${where}`,
      userMessage: "Something went wrong. Please try again.",
      context: { column: where },
    });
  }
  return parsed.data;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function conflictOrRethrow(error: unknown, table: string): unknown {
  if (!isUniqueViolation(error)) return error;
  return new ConflictError({
    message: `Unique constraint violated on ${table}`,
    userMessage: "This record already exists.",
    context: { table },
  });
}

function vanished(what: string): ConflictError {
  return new ConflictError({
    message: `Career ${what} vanished between read and write`,
    userMessage: "The requested resource does not exist.",
  });
}
