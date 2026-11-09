import { ConflictError } from "@nexus/shared";
import type {
  LinkedInAutomationConsent,
  LinkedInContentSettings,
  LinkedInReactionType,
} from "@nexus/linkedin";

/**
 * Persistence for LinkedIn content management.
 *
 * Every read and write takes the owner, as in the career store: a record
 * belonging to someone else is reported as absent. State changes are
 * conditional (`expectStates`) so two concurrent callers — a scheduler tick and
 * a click — cannot both move the same post to `publishing`; the loser gets
 * `undefined` and the service answers 409.
 */

export const LINKEDIN_POST_STATES = [
  "draft",
  "awaiting_approval",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "rejected",
  "cancelled",
] as const;
export type LinkedInPostState = (typeof LINKEDIN_POST_STATES)[number];

export const LINKEDIN_ENGAGEMENT_STATES = [
  "proposed",
  "queued",
  "executing",
  "executed",
  "failed",
  "rejected",
  "cancelled",
] as const;
export type LinkedInEngagementState = (typeof LINKEDIN_ENGAGEMENT_STATES)[number];
export type LinkedInEngagementKind = "reaction" | "comment";

export interface LinkedInPostRecord {
  id: string;
  userId: string;
  state: LinkedInPostState;
  text: string;
  topic: string | null;
  visibility: "PUBLIC" | "CONNECTIONS";
  scheduledAt: Date | null;
  publishedAt: Date | null;
  externalId: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkedInEngagementRecord {
  id: string;
  userId: string;
  kind: LinkedInEngagementKind;
  target: string;
  reaction: LinkedInReactionType | null;
  text: string | null;
  rationale: string | null;
  state: LinkedInEngagementState;
  executeAfter: Date | null;
  executedAt: Date | null;
  executor: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkedInAuditRecord {
  id: string;
  userId: string;
  actor: string;
  action: string;
  subjectType: "post" | "engagement" | "settings" | "consent" | "discovery";
  subjectId: string | null;
  outcome: "ok" | "blocked" | "failed";
  summary: string;
  context: Record<string, unknown>;
  createdAt: Date;
}

export interface StoredLinkedInSettings {
  settings: LinkedInContentSettings;
  active: boolean;
  consent: LinkedInAutomationConsent;
  updatedAt: Date;
}

export type PostPatch = Partial<
  Pick<
    LinkedInPostRecord,
    | "state"
    | "text"
    | "topic"
    | "visibility"
    | "scheduledAt"
    | "publishedAt"
    | "externalId"
    | "failureReason"
  >
>;

export type EngagementPatch = Partial<
  Pick<
    LinkedInEngagementRecord,
    "state" | "text" | "reaction" | "executeAfter" | "executedAt" | "executor" | "failureReason"
  >
>;

export interface LinkedInContentStore {
  getSettings(userId: string): Promise<StoredLinkedInSettings | undefined>;
  saveSettings(input: {
    userId: string;
    settings: LinkedInContentSettings;
    active: boolean;
    now: Date;
  }): Promise<StoredLinkedInSettings>;
  /** Creates the row with `defaults` when the owner never saved settings. */
  setConsent(input: {
    userId: string;
    consent: LinkedInAutomationConsent;
    defaults: LinkedInContentSettings;
    now: Date;
  }): Promise<StoredLinkedInSettings>;
  listActiveOwners(limit: number): Promise<string[]>;

  createPost(record: LinkedInPostRecord): Promise<LinkedInPostRecord>;
  getPost(userId: string, id: string): Promise<LinkedInPostRecord | undefined>;
  /** Applies `patch` only when the current state is one of `expectStates`. */
  updatePost(input: {
    userId: string;
    id: string;
    expectStates: readonly LinkedInPostState[];
    patch: PostPatch;
    now: Date;
  }): Promise<LinkedInPostRecord | undefined>;
  listPosts(
    userId: string,
    filter: { states?: readonly LinkedInPostState[]; limit: number },
  ): Promise<LinkedInPostRecord[]>;
  listDuePosts(userId: string, now: Date, limit: number): Promise<LinkedInPostRecord[]>;

  /** @throws {ConflictError} when this owner already has this kind on this target. */
  createEngagement(record: LinkedInEngagementRecord): Promise<LinkedInEngagementRecord>;
  getEngagement(userId: string, id: string): Promise<LinkedInEngagementRecord | undefined>;
  updateEngagement(input: {
    userId: string;
    id: string;
    expectStates: readonly LinkedInEngagementState[];
    patch: EngagementPatch;
    now: Date;
  }): Promise<LinkedInEngagementRecord | undefined>;
  listEngagements(
    userId: string,
    filter: { states?: readonly LinkedInEngagementState[]; limit: number },
  ): Promise<LinkedInEngagementRecord[]>;
  listDueEngagements(userId: string, now: Date, limit: number): Promise<LinkedInEngagementRecord[]>;
  /** Execution times of engagements executed by the executor since `since`. */
  executedEngagementTimes(userId: string, since: Date): Promise<Date[]>;

  appendAudit(record: LinkedInAuditRecord): Promise<LinkedInAuditRecord>;
  listAudit(userId: string, limit: number): Promise<LinkedInAuditRecord[]>;
}

export class InMemoryLinkedInContentStore implements LinkedInContentStore {
  readonly #settings = new Map<string, StoredLinkedInSettings>();
  readonly #posts = new Map<string, LinkedInPostRecord>();
  readonly #engagements = new Map<string, LinkedInEngagementRecord>();
  readonly #audit: LinkedInAuditRecord[] = [];

  getSettings(userId: string): Promise<StoredLinkedInSettings | undefined> {
    return Promise.resolve(copy(this.#settings.get(userId)));
  }

  saveSettings(input: {
    userId: string;
    settings: LinkedInContentSettings;
    active: boolean;
    now: Date;
  }): Promise<StoredLinkedInSettings> {
    const existing = this.#settings.get(input.userId);
    const row: StoredLinkedInSettings = {
      settings: structuredClone(input.settings),
      active: input.active,
      consent: existing?.consent ?? { acceptedAt: null, version: null },
      updatedAt: input.now,
    };
    this.#settings.set(input.userId, row);
    return Promise.resolve(copy(row)!);
  }

  setConsent(input: {
    userId: string;
    consent: LinkedInAutomationConsent;
    defaults: LinkedInContentSettings;
    now: Date;
  }): Promise<StoredLinkedInSettings> {
    const existing = this.#settings.get(input.userId);
    const row: StoredLinkedInSettings = {
      settings: existing?.settings ?? structuredClone(input.defaults),
      active: existing?.active ?? false,
      consent: { ...input.consent },
      updatedAt: input.now,
    };
    this.#settings.set(input.userId, row);
    return Promise.resolve(copy(row)!);
  }

  listActiveOwners(limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.#settings.entries()]
        .filter(([, row]) => row.active)
        .map(([userId]) => userId)
        .slice(0, limit),
    );
  }

  createPost(record: LinkedInPostRecord): Promise<LinkedInPostRecord> {
    this.#posts.set(record.id, { ...record });
    return Promise.resolve({ ...record });
  }

  getPost(userId: string, id: string): Promise<LinkedInPostRecord | undefined> {
    const row = this.#posts.get(id);
    return Promise.resolve(row?.userId === userId ? { ...row } : undefined);
  }

  updatePost(input: {
    userId: string;
    id: string;
    expectStates: readonly LinkedInPostState[];
    patch: PostPatch;
    now: Date;
  }): Promise<LinkedInPostRecord | undefined> {
    const row = this.#posts.get(input.id);
    if (row?.userId !== input.userId || !input.expectStates.includes(row.state)) {
      return Promise.resolve(undefined);
    }
    const next = { ...row, ...input.patch, updatedAt: input.now };
    this.#posts.set(row.id, next);
    return Promise.resolve({ ...next });
  }

  listPosts(
    userId: string,
    filter: { states?: readonly LinkedInPostState[]; limit: number },
  ): Promise<LinkedInPostRecord[]> {
    return Promise.resolve(
      [...this.#posts.values()]
        .filter(
          (row) =>
            row.userId === userId &&
            (filter.states === undefined || filter.states.includes(row.state)),
        )
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, filter.limit)
        .map((row) => ({ ...row })),
    );
  }

  listDuePosts(userId: string, now: Date, limit: number): Promise<LinkedInPostRecord[]> {
    return Promise.resolve(
      [...this.#posts.values()]
        .filter(
          (row) =>
            row.userId === userId &&
            row.state === "scheduled" &&
            row.scheduledAt !== null &&
            row.scheduledAt <= now,
        )
        .sort((a, b) => +(a.scheduledAt ?? 0) - +(b.scheduledAt ?? 0))
        .slice(0, limit)
        .map((row) => ({ ...row })),
    );
  }

  createEngagement(record: LinkedInEngagementRecord): Promise<LinkedInEngagementRecord> {
    const duplicate = [...this.#engagements.values()].some(
      (row) =>
        row.userId === record.userId && row.kind === record.kind && row.target === record.target,
    );
    if (duplicate) {
      return Promise.reject(
        new ConflictError({
          message: "Unique constraint on linkedin_engagements(userId, kind, target)",
          userMessage: `A ${record.kind} on this post already exists.`,
        }),
      );
    }
    this.#engagements.set(record.id, { ...record });
    return Promise.resolve({ ...record });
  }

  getEngagement(userId: string, id: string): Promise<LinkedInEngagementRecord | undefined> {
    const row = this.#engagements.get(id);
    return Promise.resolve(row?.userId === userId ? { ...row } : undefined);
  }

  updateEngagement(input: {
    userId: string;
    id: string;
    expectStates: readonly LinkedInEngagementState[];
    patch: EngagementPatch;
    now: Date;
  }): Promise<LinkedInEngagementRecord | undefined> {
    const row = this.#engagements.get(input.id);
    if (row?.userId !== input.userId || !input.expectStates.includes(row.state)) {
      return Promise.resolve(undefined);
    }
    const next = { ...row, ...input.patch, updatedAt: input.now };
    this.#engagements.set(row.id, next);
    return Promise.resolve({ ...next });
  }

  listEngagements(
    userId: string,
    filter: { states?: readonly LinkedInEngagementState[]; limit: number },
  ): Promise<LinkedInEngagementRecord[]> {
    return Promise.resolve(
      [...this.#engagements.values()]
        .filter(
          (row) =>
            row.userId === userId &&
            (filter.states === undefined || filter.states.includes(row.state)),
        )
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, filter.limit)
        .map((row) => ({ ...row })),
    );
  }

  listDueEngagements(
    userId: string,
    now: Date,
    limit: number,
  ): Promise<LinkedInEngagementRecord[]> {
    return Promise.resolve(
      [...this.#engagements.values()]
        .filter(
          (row) =>
            row.userId === userId &&
            row.state === "queued" &&
            (row.executeAfter === null || row.executeAfter <= now),
        )
        .sort((a, b) => +(a.executeAfter ?? 0) - +(b.executeAfter ?? 0))
        .slice(0, limit)
        .map((row) => ({ ...row })),
    );
  }

  executedEngagementTimes(userId: string, since: Date): Promise<Date[]> {
    return Promise.resolve(
      [...this.#engagements.values()]
        .filter(
          (row) =>
            row.userId === userId &&
            row.state === "executed" &&
            row.executor !== "manual" &&
            row.executedAt !== null &&
            row.executedAt >= since,
        )
        .map((row) => row.executedAt!),
    );
  }

  appendAudit(record: LinkedInAuditRecord): Promise<LinkedInAuditRecord> {
    this.#audit.push({ ...record });
    return Promise.resolve({ ...record });
  }

  listAudit(userId: string, limit: number): Promise<LinkedInAuditRecord[]> {
    return Promise.resolve(
      [...this.#audit]
        .reverse()
        .filter((row) => row.userId === userId)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, limit)
        .map((row) => ({ ...row })),
    );
  }
}

function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
