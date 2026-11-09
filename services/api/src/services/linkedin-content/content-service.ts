import { redactForAudit } from "@nexus/career";
import {
  DEFAULT_LINKEDIN_CONTENT_SETTINGS,
  LINKEDIN_AUTOMATION_CONSENT_VERSION,
  LINKEDIN_AUTOMATION_WARNING,
  LINKEDIN_AUTONOMOUS_ACTOR,
  LINKEDIN_OWNER_ACTOR,
  LinkedInApiError,
  LinkedInConsentRequiredError,
  applyHashtagPolicy,
  checkEngagementRateLimit,
  effectiveLinkedInMode,
  hasValidAutomationConsent,
  humanLikeDelayMs,
  mergeLinkedInContentSettings,
  upcomingPostSlots,
  withinWeeklyPostCap,
  type LinkedInAutomationConsent,
  type LinkedInAutonomyMode,
  type LinkedInClient,
  type LinkedInContentAction,
  type LinkedInContentSettings,
  type LinkedInContentSettingsPatch,
  type LinkedInReactionType,
} from "@nexus/linkedin";
import {
  ConflictError,
  DependencyError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  toAppError,
  uuidv7,
} from "@nexus/shared";
import { ZodError } from "zod";
import type { ContentDrafter } from "./drafter.js";
import type { EngagementExecutor } from "./engagement-executor.js";
import type {
  LinkedInAuditRecord,
  LinkedInContentStore,
  LinkedInEngagementKind,
  LinkedInEngagementRecord,
  LinkedInEngagementState,
  LinkedInPostRecord,
  LinkedInPostState,
  StoredLinkedInSettings,
} from "./store.js";

/**
 * LinkedIn content management on the member's behalf.
 *
 * ## Channels
 *
 * Posts are published through the official Posts API with the member's own
 * OAuth token (resolved per user from the vault by `LinkedInIntegrationService`;
 * this class never sees where the token lives and never logs it). Reactions
 * and comments go through the pluggable `EngagementExecutor`.
 *
 * ## Modes
 *
 * Each of publishPost / react / comment is `manual`, `approval` or
 * `autonomous`. `autonomous` is downgraded to `approval` by the kill switch,
 * and — for react and comment — by a missing or outdated automation consent.
 * A downgrade never loses work: queued items go back to the approval queue.
 *
 * ## Failure is visible
 *
 * When LinkedIn or the browser worker is unavailable the item is marked
 * `failed` with the reason, an audit row is written and the caller gets a 503.
 * Nothing is ever reported as published or executed without LinkedIn (or the
 * worker) having confirmed it.
 */

export const PREPARE_ACTOR = "nexus-prepare" as const;

export interface LinkedInContentServiceOptions {
  store: LinkedInContentStore;
  drafter: ContentDrafter;
  executor: EngagementExecutor;
  /** Per-user official API client. Throws when LinkedIn is not connected. */
  resolveClient: (userId: string) => Promise<LinkedInClient>;
  connection?: (userId: string) => Promise<{ configured: boolean; connected: boolean }>;
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
}

export interface LinkedInSettingsView {
  settings: LinkedInContentSettings;
  effectiveModes: Record<LinkedInContentAction, LinkedInAutonomyMode>;
  consent: {
    acceptedAt: string | null;
    version: number | null;
    currentVersion: number;
    valid: boolean;
    warning: string;
  };
  configured: boolean;
  connection: { configured: boolean; connected: boolean } | null;
  executor: string;
  drafter: string;
}

const EDITABLE_POST_STATES: readonly LinkedInPostState[] = [
  "draft",
  "awaiting_approval",
  "scheduled",
  "failed",
];
const SLOT_HOLDING_STATES: readonly LinkedInPostState[] = [
  "awaiting_approval",
  "scheduled",
  "publishing",
  "published",
];
const DRAFT_FAILURE_BACKOFF_MS = 60 * 60_000;

export class LinkedInContentService {
  readonly #store: LinkedInContentStore;
  readonly #drafter: ContentDrafter;
  readonly #executor: EngagementExecutor;
  readonly #resolveClient: (userId: string) => Promise<LinkedInClient>;
  readonly #connection:
    ((userId: string) => Promise<{ configured: boolean; connected: boolean }>) | undefined;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #newId: () => string;
  readonly #draftFailures = new Map<string, number>();
  readonly #ticking = new Set<string>();

  constructor(options: LinkedInContentServiceOptions) {
    this.#store = options.store;
    this.#drafter = options.drafter;
    this.#executor = options.executor;
    this.#resolveClient = options.resolveClient;
    this.#connection = options.connection;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#newId = options.newId ?? (() => uuidv7());
  }

  // ── Settings and consent ──────────────────────────────────────────────────

  async settingsView(userId: string): Promise<LinkedInSettingsView> {
    const row = await this.#store.getSettings(userId);
    const settings = row?.settings ?? DEFAULT_LINKEDIN_CONTENT_SETTINGS;
    const consent = row?.consent ?? { acceptedAt: null, version: null };
    let connection: LinkedInSettingsView["connection"] = null;
    if (this.#connection !== undefined) {
      connection = await this.#connection(userId).catch(() => ({
        configured: false,
        connected: false,
      }));
    }
    return {
      settings,
      effectiveModes: effectiveModes(settings, consent),
      consent: {
        acceptedAt: consent.acceptedAt?.toISOString() ?? null,
        version: consent.version,
        currentVersion: LINKEDIN_AUTOMATION_CONSENT_VERSION,
        valid: hasValidAutomationConsent(consent),
        warning: LINKEDIN_AUTOMATION_WARNING,
      },
      configured: row !== undefined,
      connection,
      executor: this.#executor.name,
      drafter: this.#drafter.name,
    };
  }

  async updateSettings(
    userId: string,
    patch: LinkedInContentSettingsPatch,
  ): Promise<LinkedInSettingsView> {
    const row = await this.#store.getSettings(userId);
    const current = row?.settings ?? DEFAULT_LINKEDIN_CONTENT_SETTINGS;
    const consent = row?.consent ?? { acceptedAt: null, version: null };
    let next: LinkedInContentSettings;
    try {
      next = mergeLinkedInContentSettings(current, patch, consent);
    } catch (error) {
      if (error instanceof LinkedInConsentRequiredError) {
        await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "settings.update", "settings", null, {
          outcome: "blocked",
          summary: error.message,
          context: { actions: error.actions },
        });
        throw new ConflictError({
          message: error.message,
          userMessage:
            "Autonomous reactions and comments require you to accept the LinkedIn automation risk first.",
          context: { code: "LINKEDIN_CONSENT_REQUIRED" },
        });
      }
      if (error instanceof ZodError) {
        throw new ValidationError({
          message: `Invalid LinkedIn settings: ${error.issues.map((i) => i.message).join("; ")}`,
          userMessage: error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join(" "),
        });
      }
      throw error;
    }
    await this.#store.saveSettings({
      userId,
      settings: next,
      active: isActive(next),
      now: this.#now(),
    });
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "settings.update", "settings", null, {
      summary: `Modes: post ${next.modes.publishPost}, react ${next.modes.react}, comment ${next.modes.comment}${next.killSwitch ? " (kill switch ON)" : ""}`,
      context: { modes: next.modes, killSwitch: next.killSwitch },
    });
    if (next.killSwitch && !current.killSwitch) await this.#unqueue(userId, "kill switch on");
    return this.settingsView(userId);
  }

  /** Records the explicit acceptance of the automation warning, with its timestamp. */
  async acceptAutomationRisk(userId: string, version: number): Promise<LinkedInSettingsView> {
    if (version !== LINKEDIN_AUTOMATION_CONSENT_VERSION) {
      throw new ConflictError({
        message: `Consent for warning v${String(version)}, current is v${String(LINKEDIN_AUTOMATION_CONSENT_VERSION)}`,
        userMessage: "The warning text changed. Read the current warning and accept it again.",
      });
    }
    const now = this.#now();
    await this.#store.setConsent({
      userId,
      consent: { acceptedAt: now, version },
      defaults: DEFAULT_LINKEDIN_CONTENT_SETTINGS,
      now,
    });
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "consent.accept", "consent", null, {
      summary: `Accepted the LinkedIn automation risk (warning v${String(version)}).`,
      context: { version, acceptedAt: now.toISOString() },
    });
    return this.settingsView(userId);
  }

  /** Withdraws consent: autonomous engagement falls back to approval at once. */
  async revokeAutomationRisk(userId: string): Promise<LinkedInSettingsView> {
    const row = await this.#store.getSettings(userId);
    const now = this.#now();
    await this.#store.setConsent({
      userId,
      consent: { acceptedAt: null, version: null },
      defaults: DEFAULT_LINKEDIN_CONTENT_SETTINGS,
      now,
    });
    if (row !== undefined) {
      const settings = structuredClone(row.settings);
      for (const action of ["react", "comment"] as const) {
        if (settings.modes[action] === "autonomous") settings.modes[action] = "approval";
      }
      await this.#store.saveSettings({ userId, settings, active: isActive(settings), now });
    }
    await this.#unqueue(userId, "automation consent withdrawn");
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "consent.revoke", "consent", null, {
      summary: "Withdrew the LinkedIn automation consent.",
      context: {},
    });
    return this.settingsView(userId);
  }

  audit(userId: string, limit: number): Promise<LinkedInAuditRecord[]> {
    return this.#store.listAudit(userId, limit);
  }

  // ── Posts ─────────────────────────────────────────────────────────────────

  listPosts(
    userId: string,
    filter: { states?: readonly LinkedInPostState[]; limit: number },
  ): Promise<LinkedInPostRecord[]> {
    return this.#store.listPosts(userId, filter);
  }

  /** A post written by the member. Scheduling it is the member's approval. */
  async createPost(
    userId: string,
    input: { text: string; scheduledAt?: Date | null; topic?: string | null },
  ): Promise<LinkedInPostRecord> {
    const { settings } = await this.#settings(userId);
    const now = this.#now();
    const scheduledAt = input.scheduledAt ?? null;
    if (scheduledAt !== null) await this.#assertWeeklyCap(userId, settings, scheduledAt, null);
    const post = await this.#store.createPost({
      id: this.#newId(),
      userId,
      state: scheduledAt === null ? "draft" : "scheduled",
      text: input.text,
      topic: input.topic ?? null,
      visibility: settings.posts.visibility,
      scheduledAt,
      publishedAt: null,
      externalId: null,
      failureReason: null,
      createdBy: LINKEDIN_OWNER_ACTOR,
      createdAt: now,
      updatedAt: now,
    });
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "post.create", "post", post.id, {
      summary:
        scheduledAt === null ? "Draft written" : `Scheduled for ${scheduledAt.toISOString()}`,
      context: { state: post.state },
    });
    return post;
  }

  /**
   * Nexus drafts a post from the configured topics and voice.
   *
   * The resulting state follows the publish mode: `manual` keeps it as a draft
   * for the member, `approval` queues it for one-click approval on the next free
   * slot, `autonomous` schedules it on that slot directly.
   */
  async generatePost(
    userId: string,
    input: { topic?: string; scheduledAt?: Date | null } = {},
    actorHint?: string,
  ): Promise<LinkedInPostRecord> {
    const { settings, consent } = await this.#settings(userId);
    const mode = effectiveLinkedInMode(settings, "publishPost", consent);
    const topic = input.topic ?? (await this.#nextTopic(userId, settings));
    if (topic === null) {
      throw new ValidationError({
        message: "No topic given and none configured",
        userMessage: "Add at least one topic to your LinkedIn post configuration.",
      });
    }
    const draft = await this.#drafter.draftPost({
      topic,
      tone: settings.posts.tone,
      language: settings.posts.language,
      maxChars: 2_800,
      userId,
    });
    const text = applyHashtagPolicy(draft.text, settings.posts.hashtags, draft.hashtags).slice(
      0,
      3_000,
    );
    const slot =
      input.scheduledAt !== undefined
        ? input.scheduledAt
        : mode === "manual"
          ? null
          : await this.#nextFreeSlot(userId, settings);
    const state: LinkedInPostState =
      mode === "autonomous" && slot !== null
        ? "scheduled"
        : mode === "manual"
          ? "draft"
          : "awaiting_approval";
    const actor = actorHint ?? (state === "scheduled" ? LINKEDIN_AUTONOMOUS_ACTOR : PREPARE_ACTOR);
    const now = this.#now();
    const post = await this.#store.createPost({
      id: this.#newId(),
      userId,
      state,
      text,
      topic,
      visibility: settings.posts.visibility,
      scheduledAt: slot,
      publishedAt: null,
      externalId: null,
      failureReason: null,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    });
    await this.#audit(userId, actor, "post.generate", "post", post.id, {
      summary: `Drafted a post about "${topic}" (${state}${slot === null ? "" : `, slot ${slot.toISOString()}`})`,
      context: { mode, state, drafter: this.#drafter.name },
    });
    return post;
  }

  async updatePost(
    userId: string,
    id: string,
    patch: { text?: string; scheduledAt?: Date | null },
  ): Promise<LinkedInPostRecord> {
    const existing = await this.#requirePost(userId, id);
    const { settings } = await this.#settings(userId);
    if (patch.scheduledAt !== undefined && patch.scheduledAt !== null) {
      await this.#assertWeeklyCap(userId, settings, patch.scheduledAt, id);
    }
    // An edit by the member is a review: a post Nexus scheduled alone becomes
    // the member's own post from here on.
    const updated = await this.#store.updatePost({
      userId,
      id,
      expectStates: EDITABLE_POST_STATES,
      patch: {
        ...(patch.text === undefined ? {} : { text: patch.text }),
        ...(patch.scheduledAt === undefined ? {} : { scheduledAt: patch.scheduledAt }),
      },
      now: this.#now(),
    });
    if (updated === undefined) throw postStateConflict(existing.state);
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "post.edit", "post", id, {
      summary: "Post edited",
      context: { fields: Object.keys(patch) },
    });
    return updated;
  }

  /** One click: the member approves; the post is scheduled for its slot (or now). */
  async approvePost(userId: string, id: string): Promise<LinkedInPostRecord> {
    const existing = await this.#requirePost(userId, id);
    const { settings } = await this.#settings(userId);
    const now = this.#now();
    const at =
      existing.scheduledAt !== null && existing.scheduledAt > now ? existing.scheduledAt : now;
    await this.#assertWeeklyCap(userId, settings, at, id);
    const updated = await this.#store.updatePost({
      userId,
      id,
      expectStates: ["draft", "awaiting_approval"],
      patch: { state: "scheduled", scheduledAt: at, failureReason: null },
      now,
    });
    if (updated === undefined) throw postStateConflict(existing.state);
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "post.approve", "post", id, {
      summary: `Approved, scheduled for ${at.toISOString()}`,
      context: {},
    });
    // Due now: publish straight away rather than waiting for the next tick.
    if (at <= now) return this.#publish(updated, ["scheduled"], LINKEDIN_OWNER_ACTOR);
    return updated;
  }

  async rejectPost(userId: string, id: string): Promise<LinkedInPostRecord> {
    return this.#closePost(userId, id, "rejected", ["draft", "awaiting_approval"], "post.reject");
  }

  async cancelPost(userId: string, id: string): Promise<LinkedInPostRecord> {
    return this.#closePost(userId, id, "cancelled", EDITABLE_POST_STATES, "post.cancel");
  }

  /** The member publishes right now (also the retry path of a failed post). */
  async publishNow(userId: string, id: string): Promise<LinkedInPostRecord> {
    const existing = await this.#requirePost(userId, id);
    const { settings } = await this.#settings(userId);
    await this.#assertWeeklyCap(userId, settings, this.#now(), id);
    return this.#publish(existing, EDITABLE_POST_STATES, LINKEDIN_OWNER_ACTOR);
  }

  // ── Engagement ────────────────────────────────────────────────────────────

  listEngagements(
    userId: string,
    filter: { states?: readonly LinkedInEngagementState[]; limit: number },
  ): Promise<LinkedInEngagementRecord[]> {
    return this.#store.listEngagements(userId, filter);
  }

  /**
   * Adds a reaction or comment to the queue.
   *
   * Duplicates (same kind on the same target) are refused with 409 — the
   * unique index makes that hold under concurrency too.
   */
  async proposeEngagement(
    userId: string,
    input: {
      kind: LinkedInEngagementKind;
      target: string;
      reaction?: LinkedInReactionType;
      text?: string;
      rationale?: string;
      context?: string;
    },
    actor: string = LINKEDIN_OWNER_ACTOR,
  ): Promise<LinkedInEngagementRecord> {
    const { settings, consent } = await this.#settings(userId);
    const action = input.kind === "reaction" ? "react" : "comment";
    const mode = effectiveLinkedInMode(settings, action, consent);
    if (actor !== LINKEDIN_OWNER_ACTOR && mode === "manual") {
      throw new ConflictError({
        message: `Nexus may not propose ${action} in manual mode`,
        userMessage: `${action} is set to manual: Nexus does not propose it.`,
      });
    }
    let text: string | null = null;
    if (input.kind === "comment") {
      text =
        input.text ??
        (await this.#drafter.draftComment({
          target: input.target,
          context: input.context ?? null,
          tone: settings.posts.tone,
          language: settings.posts.language,
          maxChars: 1_000,
          userId,
        }));
    }
    const now = this.#now();
    const queued = mode === "autonomous";
    const record = await this.#store.createEngagement({
      id: this.#newId(),
      userId,
      kind: input.kind,
      target: input.target,
      reaction:
        input.kind === "reaction" ? (input.reaction ?? settings.engagement.defaultReaction) : null,
      text,
      rationale: input.rationale ?? null,
      state: queued ? "queued" : "proposed",
      executeAfter: queued
        ? new Date(now.getTime() + humanLikeDelayMs(settings.engagement, this.#random))
        : null,
      executedAt: null,
      executor: null,
      failureReason: null,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    });
    await this.#audit(userId, actor, `${action}.propose`, "engagement", record.id, {
      summary: `${input.kind} on ${input.target} (${record.state})`,
      context: { mode, state: record.state, executeAfter: record.executeAfter?.toISOString() },
    });
    return record;
  }

  /**
   * One click: the member approves and the executor runs it now.
   *
   * Running it goes through browser automation, so the automation consent is
   * required here as well; without it the member can still do it themselves
   * and use `markEngagementDone`.
   */
  async approveEngagement(userId: string, id: string): Promise<LinkedInEngagementRecord> {
    const existing = await this.#requireEngagement(userId, id);
    const { settings, consent } = await this.#settings(userId);
    if (!hasValidAutomationConsent(consent)) {
      throw new ConflictError({
        message: "Engagement execution refused: no automation consent",
        userMessage:
          "Executing reactions and comments uses browser automation. Accept the risk in the LinkedIn settings first, or do it yourself and mark it done.",
        context: { code: "LINKEDIN_CONSENT_REQUIRED" },
      });
    }
    const verdict = checkEngagementRateLimit({
      settings: { ...settings, killSwitch: false },
      consent,
      recent: await this.#store.executedEngagementTimes(
        userId,
        new Date(this.#now().getTime() - 86_400_000),
      ),
      now: this.#now(),
    });
    // The member is clicking: the active-hours window is for unattended runs.
    if (!verdict.allowed && verdict.code !== "outside_active_hours") {
      await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "engagement.approve", "engagement", id, {
        outcome: "blocked",
        summary: verdict.reason ?? "Rate limited",
        context: { code: verdict.code, retryAt: verdict.retryAt?.toISOString() },
      });
      throw new RateLimitError({
        message: `Engagement rate limit: ${verdict.code ?? ""}`,
        userMessage: `${verdict.reason ?? "Rate limit reached."} Try again after ${verdict.retryAt?.toISOString() ?? "a while"}.`,
      });
    }
    return this.#execute(existing, ["proposed", "failed"], LINKEDIN_OWNER_ACTOR);
  }

  async rejectEngagement(userId: string, id: string): Promise<LinkedInEngagementRecord> {
    return this.#closeEngagement(
      userId,
      id,
      "rejected",
      ["proposed", "queued"],
      "engagement.reject",
    );
  }

  async cancelEngagement(userId: string, id: string): Promise<LinkedInEngagementRecord> {
    return this.#closeEngagement(
      userId,
      id,
      "cancelled",
      ["proposed", "queued", "failed"],
      "engagement.cancel",
    );
  }

  /** The member did it by hand on LinkedIn: recorded, never executed by Nexus. */
  async markEngagementDone(userId: string, id: string): Promise<LinkedInEngagementRecord> {
    const existing = await this.#requireEngagement(userId, id);
    const now = this.#now();
    const updated = await this.#store.updateEngagement({
      userId,
      id,
      expectStates: ["proposed", "queued", "failed"],
      patch: { state: "executed", executedAt: now, executor: "manual", failureReason: null },
      now,
    });
    if (updated === undefined) throw engagementStateConflict(existing.state);
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "engagement.manual_done", "engagement", id, {
      summary: `${existing.kind} done by hand on ${existing.target}`,
      context: {},
    });
    return updated;
  }

  /** Asks the executor for posts to engage with, and queues proposals per mode. */
  async discover(
    userId: string,
    limit: number,
  ): Promise<{ created: LinkedInEngagementRecord[]; skipped: number; errors: string[] }> {
    const { settings, consent } = await this.#settings(userId);
    if (!hasValidAutomationConsent(consent)) {
      throw new ConflictError({
        message: "Discovery refused: no automation consent",
        userMessage:
          "Finding posts reads your LinkedIn feed through browser automation. Accept the risk in the LinkedIn settings first.",
        context: { code: "LINKEDIN_CONSENT_REQUIRED" },
      });
    }
    const reactMode = effectiveLinkedInMode(settings, "react", consent);
    const commentMode = effectiveLinkedInMode(settings, "comment", consent);
    if (reactMode === "manual" && commentMode === "manual") {
      throw new ConflictError({
        message: "Discovery refused: react and comment are manual",
        userMessage:
          "Reactions and comments are both manual: there is nothing for Nexus to propose.",
      });
    }
    const topics =
      settings.engagement.topics.length > 0 ? settings.engagement.topics : settings.posts.topics;
    if (topics.length === 0) {
      throw new ValidationError({
        message: "No engagement topics",
        userMessage: "Add engagement topics (or post topics) first.",
      });
    }
    await this.#executor.assertAvailable();
    let found;
    try {
      found = await this.#executor.discover({ userId, topics, limit });
    } catch (error) {
      const appError = toAppError(error);
      await this.#audit(userId, PREPARE_ACTOR, "discovery.run", "discovery", null, {
        outcome: "failed",
        summary: appError.userMessage,
        context: { executor: this.#executor.name },
      });
      throw error;
    }
    const created: LinkedInEngagementRecord[] = [];
    const errors: string[] = [];
    let skipped = 0;
    for (const post of found) {
      const plans: { kind: LinkedInEngagementKind; mode: LinkedInAutonomyMode }[] = [
        { kind: "reaction", mode: reactMode },
        { kind: "comment", mode: commentMode },
      ];
      for (const plan of plans) {
        if (plan.mode === "manual") continue;
        try {
          created.push(
            await this.proposeEngagement(
              userId,
              {
                kind: plan.kind,
                target: post.target,
                rationale: post.summary.slice(0, 400),
                context: post.summary,
              },
              plan.mode === "autonomous" ? LINKEDIN_AUTONOMOUS_ACTOR : PREPARE_ACTOR,
            ),
          );
        } catch (error) {
          if (error instanceof ConflictError) skipped += 1;
          else errors.push(toAppError(error).userMessage);
        }
      }
    }
    await this.#audit(userId, PREPARE_ACTOR, "discovery.run", "discovery", null, {
      summary: `Found ${String(found.length)} post(s), queued ${String(created.length)} action(s)`,
      context: { skipped, errors: errors.length },
    });
    return { created, skipped, errors };
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  /** One scheduler pass over every active owner. */
  async tick(limit = 100): Promise<void> {
    for (const userId of await this.#store.listActiveOwners(limit)) {
      if (this.#ticking.has(userId)) continue;
      this.#ticking.add(userId);
      try {
        await this.tickOwner(userId);
      } catch {
        // One owner's failure is recorded in their audit trail, never fatal to others.
      } finally {
        this.#ticking.delete(userId);
      }
    }
  }

  async tickOwner(userId: string): Promise<void> {
    await this.#draftUpcoming(userId);
    await this.#publishDue(userId);
    await this.#executeDue(userId);
  }

  async #draftUpcoming(userId: string): Promise<void> {
    const { settings, consent } = await this.#settings(userId);
    const mode = effectiveLinkedInMode(settings, "publishPost", consent);
    if (mode === "manual" || settings.posts.topics.length === 0) return;
    const failedAt = this.#draftFailures.get(userId);
    if (failedAt !== undefined && this.#now().getTime() - failedAt < DRAFT_FAILURE_BACKOFF_MS)
      return;

    const now = this.#now();
    const until = new Date(now.getTime() + settings.posts.draftLeadHours * 3_600_000);
    const holding = await this.#slotHolders(userId);
    for (const slot of upcomingPostSlots(settings.posts.schedule, now, until)) {
      if (holding.some((post) => post.scheduledAt?.getTime() === slot.getTime())) continue;
      if (
        !withinWeeklyPostCap({
          maxPostsPerWeek: settings.posts.maxPostsPerWeek,
          at: slot,
          existing: capTimes(holding),
        })
      ) {
        continue;
      }
      try {
        const post = await this.generatePost(userId, { scheduledAt: slot });
        holding.push(post);
      } catch (error) {
        this.#draftFailures.set(userId, now.getTime());
        await this.#audit(userId, PREPARE_ACTOR, "post.generate", "post", null, {
          outcome: "failed",
          summary: toAppError(error).userMessage,
          context: { slot: slot.toISOString() },
        });
        return;
      }
    }
    this.#draftFailures.delete(userId);
  }

  async #publishDue(userId: string): Promise<void> {
    const { settings, consent } = await this.#settings(userId);
    for (const post of await this.#store.listDuePosts(userId, this.#now(), 5)) {
      const autonomous = post.createdBy === LINKEDIN_AUTONOMOUS_ACTOR;
      if (autonomous && effectiveLinkedInMode(settings, "publishPost", consent) !== "autonomous") {
        // Kill switch or mode change since scheduling: back to the member.
        const moved = await this.#store.updatePost({
          userId,
          id: post.id,
          expectStates: ["scheduled"],
          patch: { state: "awaiting_approval", failureReason: "Held back: autonomy paused." },
          now: this.#now(),
        });
        if (moved !== undefined) {
          await this.#audit(userId, LINKEDIN_AUTONOMOUS_ACTOR, "post.publish", "post", post.id, {
            outcome: "blocked",
            summary: "Autonomous publication paused; moved to the approval queue.",
            context: { killSwitch: settings.killSwitch },
          });
        }
        continue;
      }
      try {
        await this.#publish(
          post,
          ["scheduled"],
          autonomous ? LINKEDIN_AUTONOMOUS_ACTOR : LINKEDIN_OWNER_ACTOR,
        );
      } catch {
        // Already marked failed and audited by #publish.
      }
    }
  }

  async #executeDue(userId: string): Promise<void> {
    const { settings, consent } = await this.#settings(userId);
    const due = await this.#store.listDueEngagements(userId, this.#now(), 5);
    for (const item of due) {
      const action = item.kind === "reaction" ? "react" : "comment";
      if (effectiveLinkedInMode(settings, action, consent) !== "autonomous") {
        await this.#store.updateEngagement({
          userId,
          id: item.id,
          expectStates: ["queued"],
          patch: {
            state: "proposed",
            executeAfter: null,
            failureReason: "Held back: autonomy paused.",
          },
          now: this.#now(),
        });
        await this.#audit(
          userId,
          LINKEDIN_AUTONOMOUS_ACTOR,
          `${action}.execute`,
          "engagement",
          item.id,
          {
            outcome: "blocked",
            summary: "Autonomy paused (kill switch, mode or consent); moved to the approval queue.",
            context: {},
          },
        );
        continue;
      }
      const now = this.#now();
      const recent = await this.#store.executedEngagementTimes(
        userId,
        new Date(now.getTime() - 86_400_000),
      );
      const verdict = checkEngagementRateLimit({ settings, consent, recent, now });
      const lastRun = recent.reduce((max, time) => Math.max(max, time.getTime()), 0);
      const spacingMs = settings.engagement.minDelaySeconds * 1_000;
      if (!verdict.allowed || now.getTime() - lastRun < spacingMs) {
        const base = verdict.retryAt?.getTime() ?? lastRun + spacingMs;
        const retryAt = new Date(
          Math.max(base, now.getTime()) + humanLikeDelayMs(settings.engagement, this.#random),
        );
        await this.#store.updateEngagement({
          userId,
          id: item.id,
          expectStates: ["queued"],
          patch: {
            executeAfter: retryAt,
            failureReason: `Deferred: ${verdict.reason ?? "human-like spacing between actions"}`,
          },
          now,
        });
        continue;
      }
      try {
        await this.#execute(item, ["queued"], LINKEDIN_AUTONOMOUS_ACTOR);
      } catch {
        // Marked failed and audited by #execute.
      }
      // One action per owner per tick: spacing comes from the random delays.
      return;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async #publish(
    post: LinkedInPostRecord,
    from: readonly LinkedInPostState[],
    actor: string,
  ): Promise<LinkedInPostRecord> {
    const userId = post.userId;
    const claimed = await this.#store.updatePost({
      userId,
      id: post.id,
      expectStates: from,
      patch: { state: "publishing", failureReason: null },
      now: this.#now(),
    });
    if (claimed === undefined) throw postStateConflict(post.state);

    let client: LinkedInClient;
    let authorUrn: string;
    try {
      client = await this.#resolveClient(userId);
      authorUrn = await client.getAuthorUrn();
    } catch (error) {
      // Nothing was sent: the outcome is known.
      throw await this.#failPost(claimed, actor, describeLinkedInError(error, false), error);
    }
    let externalId: string;
    try {
      const result = await client.createTextPost({
        authorUrn,
        text: claimed.text,
        visibility: claimed.visibility,
      });
      externalId = result.id;
    } catch (error) {
      throw await this.#failPost(claimed, actor, describeLinkedInError(error, true), error);
    }
    const now = this.#now();
    const published = await this.#store.updatePost({
      userId,
      id: post.id,
      expectStates: ["publishing"],
      patch: { state: "published", publishedAt: now, externalId },
      now,
    });
    await this.#audit(userId, actor, "post.publish", "post", post.id, {
      summary: `Published on LinkedIn (${externalId})`,
      context: { externalId, channel: "official-api" },
    });
    return published ?? { ...claimed, state: "published", publishedAt: now, externalId };
  }

  async #failPost(
    post: LinkedInPostRecord,
    actor: string,
    reason: string,
    cause: unknown,
  ): Promise<DependencyError> {
    await this.#store.updatePost({
      userId: post.userId,
      id: post.id,
      expectStates: ["publishing"],
      patch: { state: "failed", failureReason: reason.slice(0, 400) },
      now: this.#now(),
    });
    await this.#audit(post.userId, actor, "post.publish", "post", post.id, {
      outcome: "failed",
      summary: reason,
      context: { channel: "official-api" },
    });
    return new DependencyError({
      message: `LinkedIn publication failed: ${reason}`,
      userMessage: reason,
      cause,
    });
  }

  async #execute(
    item: LinkedInEngagementRecord,
    from: readonly LinkedInEngagementState[],
    actor: string,
  ): Promise<LinkedInEngagementRecord> {
    const userId = item.userId;
    const action = item.kind === "reaction" ? "react" : "comment";
    const claimed = await this.#store.updateEngagement({
      userId,
      id: item.id,
      expectStates: from,
      patch: { state: "executing", failureReason: null },
      now: this.#now(),
    });
    if (claimed === undefined) throw engagementStateConflict(item.state);
    try {
      await this.#executor.assertAvailable();
      const result = await this.#executor.execute({
        userId,
        kind: claimed.kind,
        target: claimed.target,
        reaction: claimed.reaction,
        text: claimed.text,
      });
      const now = this.#now();
      const done = await this.#store.updateEngagement({
        userId,
        id: item.id,
        expectStates: ["executing"],
        patch: { state: "executed", executedAt: now, executor: this.#executor.name },
        now,
      });
      await this.#audit(userId, actor, `${action}.execute`, "engagement", item.id, {
        summary: `${claimed.kind} executed on ${claimed.target}`,
        context: { executor: this.#executor.name, reference: result.reference },
      });
      return done ?? { ...claimed, state: "executed", executedAt: now };
    } catch (error) {
      const appError = toAppError(error);
      await this.#store.updateEngagement({
        userId,
        id: item.id,
        expectStates: ["executing"],
        patch: {
          state: "failed",
          executor: this.#executor.name,
          failureReason: appError.userMessage.slice(0, 400),
        },
        now: this.#now(),
      });
      await this.#audit(userId, actor, `${action}.execute`, "engagement", item.id, {
        outcome: "failed",
        summary: appError.userMessage,
        context: { executor: this.#executor.name },
      });
      throw appError instanceof DependencyError
        ? appError
        : new DependencyError({
            message: `Engagement execution failed: ${appError.message}`,
            userMessage: appError.userMessage,
            cause: error,
          });
    }
  }

  async #closePost(
    userId: string,
    id: string,
    state: "rejected" | "cancelled",
    from: readonly LinkedInPostState[],
    action: string,
  ): Promise<LinkedInPostRecord> {
    const existing = await this.#requirePost(userId, id);
    const updated = await this.#store.updatePost({
      userId,
      id,
      expectStates: from,
      patch: { state },
      now: this.#now(),
    });
    if (updated === undefined) throw postStateConflict(existing.state);
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, action, "post", id, {
      summary: `Post ${state}`,
      context: {},
    });
    return updated;
  }

  async #closeEngagement(
    userId: string,
    id: string,
    state: "rejected" | "cancelled",
    from: readonly LinkedInEngagementState[],
    action: string,
  ): Promise<LinkedInEngagementRecord> {
    const existing = await this.#requireEngagement(userId, id);
    const updated = await this.#store.updateEngagement({
      userId,
      id,
      expectStates: from,
      patch: { state },
      now: this.#now(),
    });
    if (updated === undefined) throw engagementStateConflict(existing.state);
    await this.#audit(userId, LINKEDIN_OWNER_ACTOR, action, "engagement", id, {
      summary: `${existing.kind} ${state}`,
      context: {},
    });
    return updated;
  }

  /** Queued autonomous engagements go back to the approval queue. */
  async #unqueue(userId: string, reason: string): Promise<void> {
    const queued = await this.#store.listEngagements(userId, { states: ["queued"], limit: 500 });
    for (const item of queued) {
      await this.#store.updateEngagement({
        userId,
        id: item.id,
        expectStates: ["queued"],
        patch: { state: "proposed", executeAfter: null, failureReason: `Held back: ${reason}.` },
        now: this.#now(),
      });
    }
  }

  async #settings(
    userId: string,
  ): Promise<{ settings: LinkedInContentSettings; consent: LinkedInAutomationConsent }> {
    const row: StoredLinkedInSettings | undefined = await this.#store.getSettings(userId);
    return {
      settings: row?.settings ?? DEFAULT_LINKEDIN_CONTENT_SETTINGS,
      consent: row?.consent ?? { acceptedAt: null, version: null },
    };
  }

  async #slotHolders(userId: string): Promise<LinkedInPostRecord[]> {
    return this.#store.listPosts(userId, { states: SLOT_HOLDING_STATES, limit: 200 });
  }

  async #nextFreeSlot(userId: string, settings: LinkedInContentSettings): Promise<Date | null> {
    const now = this.#now();
    const holding = await this.#slotHolders(userId);
    const slots = upcomingPostSlots(
      settings.posts.schedule,
      now,
      new Date(now.getTime() + 21 * 86_400_000),
    );
    for (const slot of slots) {
      if (holding.some((post) => post.scheduledAt?.getTime() === slot.getTime())) continue;
      if (
        withinWeeklyPostCap({
          maxPostsPerWeek: settings.posts.maxPostsPerWeek,
          at: slot,
          existing: capTimes(holding),
        })
      ) {
        return slot;
      }
    }
    return null;
  }

  async #nextTopic(userId: string, settings: LinkedInContentSettings): Promise<string | null> {
    const topics = settings.posts.topics;
    if (topics.length === 0) return null;
    const recent = await this.#store.listPosts(userId, { limit: topics.length });
    const used = new Set(recent.map((post) => post.topic));
    return (
      topics.find((topic) => !used.has(topic)) ?? topics[recent.length % topics.length] ?? null
    );
  }

  async #assertWeeklyCap(
    userId: string,
    settings: LinkedInContentSettings,
    at: Date,
    excludeId: string | null,
  ): Promise<void> {
    const holding = (
      await this.#store.listPosts(userId, {
        states: ["scheduled", "publishing", "published"],
        limit: 200,
      })
    ).filter((post) => post.id !== excludeId);
    if (
      !withinWeeklyPostCap({
        maxPostsPerWeek: settings.posts.maxPostsPerWeek,
        at,
        existing: capTimes(holding),
      })
    ) {
      await this.#audit(userId, LINKEDIN_OWNER_ACTOR, "post.schedule", "post", excludeId, {
        outcome: "blocked",
        summary: `Weekly cap of ${String(settings.posts.maxPostsPerWeek)} post(s) reached.`,
        context: { at: at.toISOString() },
      });
      throw new ConflictError({
        message: "Weekly LinkedIn post cap reached",
        userMessage: `Your limit of ${String(settings.posts.maxPostsPerWeek)} post(s) per week is reached around that date.`,
      });
    }
  }

  async #requirePost(userId: string, id: string): Promise<LinkedInPostRecord> {
    const post = await this.#store.getPost(userId, id);
    if (post === undefined) {
      throw new NotFoundError({
        message: `Unknown LinkedIn post ${id}`,
        userMessage: "The requested resource does not exist.",
      });
    }
    return post;
  }

  async #requireEngagement(userId: string, id: string): Promise<LinkedInEngagementRecord> {
    const record = await this.#store.getEngagement(userId, id);
    if (record === undefined) {
      throw new NotFoundError({
        message: `Unknown LinkedIn engagement ${id}`,
        userMessage: "The requested resource does not exist.",
      });
    }
    return record;
  }

  async #audit(
    userId: string,
    actor: string,
    action: string,
    subjectType: LinkedInAuditRecord["subjectType"],
    subjectId: string | null,
    input: {
      outcome?: LinkedInAuditRecord["outcome"];
      summary: string;
      context: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.#store.appendAudit({
      id: this.#newId(),
      userId,
      actor,
      action,
      subjectType,
      subjectId,
      outcome: input.outcome ?? "ok",
      summary: input.summary.slice(0, 400),
      // Redacted: secret-shaped values masked, strings bounded. No token or
      // credential is ever passed in here in the first place.
      context: redactForAudit(input.context),
      createdAt: this.#now(),
    });
  }
}

function effectiveModes(
  settings: LinkedInContentSettings,
  consent: LinkedInAutomationConsent,
): Record<LinkedInContentAction, LinkedInAutonomyMode> {
  return {
    publishPost: effectiveLinkedInMode(settings, "publishPost", consent),
    react: effectiveLinkedInMode(settings, "react", consent),
    comment: effectiveLinkedInMode(settings, "comment", consent),
  };
}

function isActive(settings: LinkedInContentSettings): boolean {
  return Object.values(settings.modes).some((mode) => mode !== "manual");
}

function capTimes(posts: readonly LinkedInPostRecord[]): Date[] {
  return posts
    .map((post) => post.publishedAt ?? post.scheduledAt)
    .filter((time): time is Date => time !== null);
}

function postStateConflict(state: LinkedInPostState): ConflictError {
  return new ConflictError({
    message: `LinkedIn post is ${state}`,
    userMessage: `This post is ${state.replace("_", " ")}; that action is no longer possible.`,
  });
}

function engagementStateConflict(state: LinkedInEngagementState): ConflictError {
  return new ConflictError({
    message: `LinkedIn engagement is ${state}`,
    userMessage: `This action is ${state}; it cannot be changed any more.`,
  });
}

function describeLinkedInError(error: unknown, sent: boolean): string {
  if (error instanceof LinkedInApiError) {
    if (error.status === 401)
      return "LinkedIn authorization expired or was revoked. Reconnect LinkedIn.";
    if (error.status === 403) {
      return "LinkedIn refused the request: the app lacks the w_member_social permission.";
    }
    if (error.status === 429) return "LinkedIn rate limit reached. Retry later.";
    if (error.status >= 500) return `LinkedIn is unavailable (HTTP ${String(error.status)}).`;
    return `LinkedIn rejected the request (HTTP ${String(error.status)}).`;
  }
  const message = toAppError(error).userMessage;
  if (!sent) {
    return /not connected|not configured|expired|Unauthenticated/i.test(
      error instanceof Error ? error.message : "",
    )
      ? `LinkedIn is not connected for this account: ${error instanceof Error ? error.message : message}`
      : `LinkedIn could not be reached: ${message}`;
  }
  return "LinkedIn did not confirm the publication (network error). Check your LinkedIn feed before retrying.";
}
