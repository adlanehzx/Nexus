import { ConflictError } from "@nexus/shared";
import type { InputJsonValue, PrismaClient } from "@nexus/database";
import {
  DEFAULT_CAREER_AUTONOMY_SETTINGS,
  careerAutonomySettingsSchema,
  type CareerAutonomySettings,
} from "@nexus/career";
import {
  DEFAULT_LINKEDIN_CONTENT_SETTINGS,
  linkedInContentSettingsSchema,
  linkedInReactionTypeSchema,
  type LinkedInAutomationConsent,
  type LinkedInContentSettings,
} from "@nexus/linkedin";
import type {
  CareerAutonomyStore,
  StoredCareerAutonomySettings,
} from "../career/autonomy-store.js";
import type {
  EngagementPatch,
  LinkedInAuditRecord,
  LinkedInContentStore,
  LinkedInEngagementRecord,
  LinkedInEngagementState,
  LinkedInPostRecord,
  LinkedInPostState,
  PostPatch,
  StoredLinkedInSettings,
} from "../linkedin-content/store.js";

/**
 * PostgreSQL persistence for Lab 1 (career autonomy, LinkedIn content).
 *
 * JSON settings are parsed through their Zod schema on the way out, as the
 * career store does: a row edited by hand into an invalid shape falls back to
 * the safe defaults instead of surfacing as a `TypeError` in the scheduler.
 * Falling back to defaults is safe by construction — defaults never contain an
 * autonomous mode.
 *
 * State changes use `updateMany` with the expected states in the `where`
 * clause, so the database decides which of two concurrent callers wins.
 */
export class PrismaCareerAutonomyStore implements CareerAutonomyStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async get(userId: string): Promise<StoredCareerAutonomySettings | undefined> {
    const row = await this.#prisma.careerAutonomySettings.findUnique({ where: { userId } });
    if (row === null) return undefined;
    return {
      settings: parseCareerAutonomy(row.settings),
      active: row.autonomyActive,
      updatedAt: row.updatedAt,
    };
  }

  async save(input: {
    userId: string;
    settings: CareerAutonomySettings;
    active: boolean;
    now: Date;
  }): Promise<StoredCareerAutonomySettings> {
    const row = await this.#prisma.careerAutonomySettings.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        settings: input.settings,
        autonomyActive: input.active,
        createdAt: input.now,
        updatedAt: input.now,
      },
      update: {
        settings: input.settings,
        autonomyActive: input.active,
        updatedAt: input.now,
      },
    });
    return {
      settings: parseCareerAutonomy(row.settings),
      active: row.autonomyActive,
      updatedAt: row.updatedAt,
    };
  }

  async listActiveOwners(limit: number): Promise<string[]> {
    const rows = await this.#prisma.careerAutonomySettings.findMany({
      where: { autonomyActive: true },
      select: { userId: true },
      take: limit,
    });
    return rows.map((row) => row.userId);
  }
}

export class PrismaLinkedInContentStore implements LinkedInContentStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async getSettings(userId: string): Promise<StoredLinkedInSettings | undefined> {
    const row = await this.#prisma.linkedInContentSettings.findUnique({ where: { userId } });
    return row === null ? undefined : presentSettings(row);
  }

  async saveSettings(input: {
    userId: string;
    settings: LinkedInContentSettings;
    active: boolean;
    now: Date;
  }): Promise<StoredLinkedInSettings> {
    const row = await this.#prisma.linkedInContentSettings.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        settings: input.settings,
        active: input.active,
        createdAt: input.now,
        updatedAt: input.now,
      },
      // Consent columns are deliberately absent: only `setConsent` writes them.
      update: {
        settings: input.settings,
        active: input.active,
        updatedAt: input.now,
      },
    });
    return presentSettings(row);
  }

  async setConsent(input: {
    userId: string;
    consent: LinkedInAutomationConsent;
    defaults: LinkedInContentSettings;
    now: Date;
  }): Promise<StoredLinkedInSettings> {
    const row = await this.#prisma.linkedInContentSettings.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        settings: input.defaults,
        active: false,
        automationConsentAt: input.consent.acceptedAt,
        automationConsentVersion: input.consent.version,
        createdAt: input.now,
        updatedAt: input.now,
      },
      update: {
        automationConsentAt: input.consent.acceptedAt,
        automationConsentVersion: input.consent.version,
        updatedAt: input.now,
      },
    });
    return presentSettings(row);
  }

  async listActiveOwners(limit: number): Promise<string[]> {
    const rows = await this.#prisma.linkedInContentSettings.findMany({
      where: { active: true },
      select: { userId: true },
      take: limit,
    });
    return rows.map((row) => row.userId);
  }

  async createPost(record: LinkedInPostRecord): Promise<LinkedInPostRecord> {
    const row = await this.#prisma.linkedInPost.create({ data: { ...record } });
    return presentPost(row);
  }

  async getPost(userId: string, id: string): Promise<LinkedInPostRecord | undefined> {
    const row = await this.#prisma.linkedInPost.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentPost(row);
  }

  async updatePost(input: {
    userId: string;
    id: string;
    expectStates: readonly LinkedInPostState[];
    patch: PostPatch;
    now: Date;
  }): Promise<LinkedInPostRecord | undefined> {
    const result = await this.#prisma.linkedInPost.updateMany({
      where: { id: input.id, userId: input.userId, state: { in: [...input.expectStates] } },
      data: { ...input.patch, updatedAt: input.now },
    });
    if (result.count === 0) return undefined;
    return this.getPost(input.userId, input.id);
  }

  async listPosts(
    userId: string,
    filter: { states?: readonly LinkedInPostState[]; limit: number },
  ): Promise<LinkedInPostRecord[]> {
    const rows = await this.#prisma.linkedInPost.findMany({
      where: {
        userId,
        ...(filter.states === undefined ? {} : { state: { in: [...filter.states] } }),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit,
    });
    return rows.map(presentPost);
  }

  async listDuePosts(userId: string, now: Date, limit: number): Promise<LinkedInPostRecord[]> {
    const rows = await this.#prisma.linkedInPost.findMany({
      where: { userId, state: "scheduled", scheduledAt: { lte: now } },
      orderBy: { scheduledAt: "asc" },
      take: limit,
    });
    return rows.map(presentPost);
  }

  async createEngagement(record: LinkedInEngagementRecord): Promise<LinkedInEngagementRecord> {
    try {
      const row = await this.#prisma.linkedInEngagement.create({ data: { ...record } });
      return presentEngagement(row);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "P2002"
      ) {
        throw new ConflictError({
          message: "Unique constraint on linkedin_engagements(userId, kind, target)",
          userMessage: `A ${record.kind} on this post already exists.`,
        });
      }
      throw error;
    }
  }

  async getEngagement(userId: string, id: string): Promise<LinkedInEngagementRecord | undefined> {
    const row = await this.#prisma.linkedInEngagement.findFirst({ where: { id, userId } });
    return row === null ? undefined : presentEngagement(row);
  }

  async updateEngagement(input: {
    userId: string;
    id: string;
    expectStates: readonly LinkedInEngagementState[];
    patch: EngagementPatch;
    now: Date;
  }): Promise<LinkedInEngagementRecord | undefined> {
    const result = await this.#prisma.linkedInEngagement.updateMany({
      where: { id: input.id, userId: input.userId, state: { in: [...input.expectStates] } },
      data: { ...input.patch, updatedAt: input.now },
    });
    if (result.count === 0) return undefined;
    return this.getEngagement(input.userId, input.id);
  }

  async listEngagements(
    userId: string,
    filter: { states?: readonly LinkedInEngagementState[]; limit: number },
  ): Promise<LinkedInEngagementRecord[]> {
    const rows = await this.#prisma.linkedInEngagement.findMany({
      where: {
        userId,
        ...(filter.states === undefined ? {} : { state: { in: [...filter.states] } }),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit,
    });
    return rows.map(presentEngagement);
  }

  async listDueEngagements(
    userId: string,
    now: Date,
    limit: number,
  ): Promise<LinkedInEngagementRecord[]> {
    const rows = await this.#prisma.linkedInEngagement.findMany({
      where: {
        userId,
        state: "queued",
        OR: [{ executeAfter: null }, { executeAfter: { lte: now } }],
      },
      orderBy: { executeAfter: "asc" },
      take: limit,
    });
    return rows.map(presentEngagement);
  }

  async executedEngagementTimes(userId: string, since: Date): Promise<Date[]> {
    const rows = await this.#prisma.linkedInEngagement.findMany({
      where: {
        userId,
        state: "executed",
        executor: { not: "manual" },
        executedAt: { gte: since },
      },
      select: { executedAt: true },
    });
    return rows.map((row) => row.executedAt).filter((time): time is Date => time !== null);
  }

  async appendAudit(record: LinkedInAuditRecord): Promise<LinkedInAuditRecord> {
    const row = await this.#prisma.linkedInAuditEvent.create({
      data: { ...record, context: record.context as InputJsonValue },
    });
    return presentAudit(row);
  }

  async listAudit(userId: string, limit: number): Promise<LinkedInAuditRecord[]> {
    const rows = await this.#prisma.linkedInAuditEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(presentAudit);
  }
}

function parseCareerAutonomy(value: unknown): CareerAutonomySettings {
  const parsed = careerAutonomySettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_CAREER_AUTONOMY_SETTINGS;
}

function presentSettings(row: {
  settings: unknown;
  active: boolean;
  automationConsentAt: Date | null;
  automationConsentVersion: number | null;
  updatedAt: Date;
}): StoredLinkedInSettings {
  const parsed = linkedInContentSettingsSchema.safeParse(row.settings);
  return {
    settings: parsed.success ? parsed.data : DEFAULT_LINKEDIN_CONTENT_SETTINGS,
    active: row.active,
    consent: { acceptedAt: row.automationConsentAt, version: row.automationConsentVersion },
    updatedAt: row.updatedAt,
  };
}

function presentPost(row: {
  id: string;
  userId: string;
  state: string;
  text: string;
  topic: string | null;
  visibility: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  externalId: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): LinkedInPostRecord {
  return {
    ...row,
    state: row.state as LinkedInPostState,
    visibility: row.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
  };
}

function presentEngagement(row: {
  id: string;
  userId: string;
  kind: string;
  target: string;
  reaction: string | null;
  text: string | null;
  rationale: string | null;
  state: string;
  executeAfter: Date | null;
  executedAt: Date | null;
  executor: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): LinkedInEngagementRecord {
  const reaction = linkedInReactionTypeSchema.safeParse(row.reaction);
  return {
    ...row,
    kind: row.kind === "comment" ? "comment" : "reaction",
    reaction: reaction.success ? reaction.data : null,
    state: row.state as LinkedInEngagementState,
  };
}

function presentAudit(row: {
  id: string;
  userId: string;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  outcome: string;
  summary: string;
  context: unknown;
  createdAt: Date;
}): LinkedInAuditRecord {
  return {
    ...row,
    subjectType: row.subjectType as LinkedInAuditRecord["subjectType"],
    outcome: row.outcome as LinkedInAuditRecord["outcome"],
    context:
      typeof row.context === "object" && row.context !== null && !Array.isArray(row.context)
        ? (row.context as Record<string, unknown>)
        : {},
  };
}
