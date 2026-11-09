import {
  AUTONOMOUS_ACTOR,
  DEFAULT_CAREER_AUTONOMY_SETTINGS,
  effectiveAutonomyMode,
  evaluateAutonomyGuardrails,
  mergeCareerAutonomySettings,
  startOfDayInTimezone,
  type Application,
  type ApplicationEvent,
  type AutonomyMode,
  type CareerAutonomyAction,
  type CareerAutonomySettings,
  type CareerAutonomySettingsPatch,
  type CareerProfile,
  type ConfirmationRecord,
  type DocumentVariantKind,
  type GuardrailVerdict,
  type Opportunity,
} from "@nexus/career";
import { ConflictError, ValidationError, toAppError } from "@nexus/shared";
import { ZodError } from "zod";
import { runAsCareerActor, type CareerService } from "./career-service.js";
import type { CareerStore } from "./store.js";
import type { CareerAutonomyStore } from "./autonomy-store.js";

/**
 * Drives the career pipeline according to the owner's autonomy settings.
 *
 * ## What this layer is allowed to do
 *
 * Nothing the owner could not do. Every step calls the same public
 * `CareerService` methods the routes call — shortlist, draft, request approval,
 * decide, submit — so the lifecycle table, the approval bound to a payload
 * hash and the derived idempotency key all still apply. Autonomy changes *who*
 * presses the button, never *which* checks run. A replayed submission is still
 * refused with 409 by `assertSubmittable`.
 *
 * ## Attribution
 *
 * Calls made in autonomous mode run inside `runAsCareerActor("nexus-autonomous")`
 * so every lifecycle event they cause carries that actor, and each decision —
 * taken or held back by a guardrail — is recorded as an `autonomy.*` event on
 * the application's immutable history.
 *
 * Preparation in `approval` mode (drafting documents, opening an approval
 * request) is attributed to `nexus-prepare`: Nexus did the work, the owner
 * still makes the decision.
 */

export const PREPARE_ACTOR = "nexus-prepare" as const;

export interface CareerAutonomyServiceOptions {
  career: CareerService;
  careerStore: CareerStore;
  store: CareerAutonomyStore;
  now?: () => Date;
  /** Upper bound of opportunities examined per run. */
  scanLimit?: number;
  /** Upper bound of autonomous shortlists per run, so one run cannot flood the pipeline. */
  maxShortlistsPerRun?: number;
}

export interface AutonomySettingsView {
  settings: CareerAutonomySettings;
  effectiveModes: Record<CareerAutonomyAction, AutonomyMode>;
  configured: boolean;
  updatedAt: string | null;
}

export interface AutonomyRunReport {
  ranAt: string;
  effectiveModes: Record<CareerAutonomyAction, AutonomyMode>;
  shortlisted: { opportunityId: string; applicationId: string; score: number | null }[];
  suggestions: ShortlistSuggestion[];
  documentsPrepared: { applicationId: string; actor: string; kinds: DocumentVariantKind[] }[];
  approvalsRequested: { applicationId: string; confirmationId: string; actor: string }[];
  submitted: { applicationId: string; attemptId: string }[];
  blocked: {
    action: CareerAutonomyAction;
    applicationId?: string;
    opportunityId?: string;
    reasons: GuardrailVerdict["blocked"];
  }[];
  errors: { action: CareerAutonomyAction; applicationId?: string; message: string }[];
}

export interface ShortlistSuggestion {
  opportunityId: string;
  title: string;
  organization: string;
  kind: Opportunity["kind"];
  score: number;
}

export interface AutonomyQueue {
  suggestions: ShortlistSuggestion[];
  documentsToValidate: {
    applicationId: string;
    opportunityId: string;
    title: string;
    organization: string;
    score: number | null;
    documents: { id: string; kind: DocumentVariantKind; revision: number }[];
  }[];
  approvalsPending: {
    confirmationId: string;
    applicationId: string;
    summary: string;
    expiresAt: string;
    title: string;
    organization: string;
    score: number | null;
  }[];
  readyToSubmit: { applicationId: string; title: string; organization: string }[];
}

export class CareerAutonomyService {
  readonly #career: CareerService;
  readonly #careerStore: CareerStore;
  readonly #store: CareerAutonomyStore;
  readonly #now: () => Date;
  readonly #scanLimit: number;
  readonly #maxShortlistsPerRun: number;
  /** One run per owner at a time: overlapping ticks would race each other. */
  readonly #running = new Set<string>();

  constructor(options: CareerAutonomyServiceOptions) {
    this.#career = options.career;
    this.#careerStore = options.careerStore;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#scanLimit = options.scanLimit ?? 100;
    this.#maxShortlistsPerRun = options.maxShortlistsPerRun ?? 10;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async settings(userId: string): Promise<CareerAutonomySettings> {
    return (await this.#store.get(userId))?.settings ?? DEFAULT_CAREER_AUTONOMY_SETTINGS;
  }

  async settingsView(userId: string): Promise<AutonomySettingsView> {
    const row = await this.#store.get(userId);
    const settings = row?.settings ?? DEFAULT_CAREER_AUTONOMY_SETTINGS;
    return {
      settings,
      effectiveModes: effectiveModes(settings),
      configured: row !== undefined,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async updateSettings(
    userId: string,
    patch: CareerAutonomySettingsPatch,
  ): Promise<AutonomySettingsView> {
    let next: CareerAutonomySettings;
    try {
      next = mergeCareerAutonomySettings(await this.settings(userId), patch);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError({
          message: `Invalid autonomy settings: ${error.issues.map((i) => i.message).join("; ")}`,
          userMessage: error.issues.map((issue) => issue.message).join(" "),
        });
      }
      throw error;
    }
    const active = !next.killSwitch && Object.values(next.modes).some((mode) => mode !== "manual");
    await this.#store.save({ userId, settings: next, active, now: this.#now() });
    return this.settingsView(userId);
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  /** Career events, newest first; `actor` narrows to Nexus' own actions. */
  audit(userId: string, filter: { actor?: string; limit: number }): Promise<ApplicationEvent[]> {
    return this.#career.recentEvents(userId, filter);
  }

  // ── The approval queue ────────────────────────────────────────────────────

  async queue(userId: string): Promise<AutonomyQueue> {
    const settings = await this.settings(userId);
    const profile = (await this.#career.profile(userId)).profile;
    const suggestions =
      profile === null || effectiveAutonomyMode(settings, "shortlist") === "manual"
        ? []
        : (await this.#candidates(userId, settings)).suggestions;

    const documentsToValidate: AutonomyQueue["documentsToValidate"] = [];
    const approvalsPending: AutonomyQueue["approvalsPending"] = [];
    const readyToSubmit: AutonomyQueue["readyToSubmit"] = [];

    for (const state of ["drafting", "awaiting_confirmation", "approved"] as const) {
      const applications = await this.#career.listApplications(userId, { state, limit: 200 });
      for (const application of applications) {
        const opportunity = await this.#careerStore.getOpportunity(
          userId,
          application.opportunityId,
        );
        const title = opportunity?.title ?? "";
        const organization = opportunity?.organization ?? "";
        if (state === "drafting") {
          const documents = await this.#careerStore.latestDocumentVariants(userId, application.id);
          if (documents.length === 0) continue;
          documentsToValidate.push({
            applicationId: application.id,
            opportunityId: application.opportunityId,
            title,
            organization,
            score: application.matchScore,
            documents: documents.map((doc) => ({
              id: doc.id,
              kind: doc.kind,
              revision: doc.revision,
            })),
          });
        } else if (state === "awaiting_confirmation") {
          const live = await this.#liveConfirmation(userId, application.id);
          if (live?.state !== "pending") continue;
          approvalsPending.push({
            confirmationId: live.id,
            applicationId: application.id,
            summary: live.summary,
            expiresAt: live.expiresAt.toISOString(),
            title,
            organization,
            score: application.matchScore,
          });
        } else {
          readyToSubmit.push({ applicationId: application.id, title, organization });
        }
      }
    }
    return { suggestions, documentsToValidate, approvalsPending, readyToSubmit };
  }

  /** One click: the owner validates the drafted documents; Nexus opens the approval. */
  async validateDocuments(
    userId: string,
    applicationId: string,
  ): Promise<{ confirmation: ConfirmationRecord; application: Application }> {
    return this.#career.requestApproval(userId, applicationId);
  }

  /**
   * One click: the owner approves the exact payload and it is submitted.
   *
   * Both halves are the ordinary owner paths, so a second click finds the
   * confirmation already decided and is refused with 409.
   */
  async approveAndSubmit(
    userId: string,
    confirmationId: string,
  ): Promise<{ applicationId: string; attemptId: string; replayed: boolean }> {
    const decided = await this.#career.decideConfirmation(userId, confirmationId, "approved");
    const result = await this.#career.submit(userId, decided.application.id);
    return {
      applicationId: decided.application.id,
      attemptId: result.attempt.id,
      replayed: result.replayed,
    };
  }

  // ── The run ───────────────────────────────────────────────────────────────

  /** Owners the scheduler visits: configured, non-manual, kill switch off. */
  async runDue(limit = 100): Promise<AutonomyRunReport[]> {
    const reports: AutonomyRunReport[] = [];
    for (const userId of await this.#store.listActiveOwners(limit)) {
      try {
        reports.push(await this.run(userId));
      } catch {
        // One owner's failure (no profile, a store hiccup) must not stop the others.
      }
    }
    return reports;
  }

  async run(userId: string): Promise<AutonomyRunReport> {
    if (this.#running.has(userId)) {
      throw new ConflictError({
        message: "An autonomy run is already in progress for this owner",
        userMessage: "Nexus is already working on your pipeline. Try again in a moment.",
      });
    }
    this.#running.add(userId);
    try {
      return await this.#run(userId);
    } finally {
      this.#running.delete(userId);
    }
  }

  async #run(userId: string): Promise<AutonomyRunReport> {
    const settings = await this.settings(userId);
    const modes = effectiveModes(settings);
    const report: AutonomyRunReport = {
      ranAt: this.#now().toISOString(),
      effectiveModes: modes,
      shortlisted: [],
      suggestions: [],
      documentsPrepared: [],
      approvalsRequested: [],
      submitted: [],
      blocked: [],
      errors: [],
    };

    const profile = (await this.#career.profile(userId)).profile;
    if (profile === null) {
      throw new ConflictError({
        message: "Autonomy run refused: no career profile",
        userMessage: "Create a career profile before letting Nexus work on your pipeline.",
      });
    }

    await this.#shortlistStep(userId, settings, modes.shortlist, report);
    await this.#documentsStep(userId, settings, profile, modes, report);
    await this.#submissionStep(userId, settings, modes.submission, report);
    return report;
  }

  async #shortlistStep(
    userId: string,
    settings: CareerAutonomySettings,
    mode: AutonomyMode,
    report: AutonomyRunReport,
  ): Promise<void> {
    if (mode === "manual") return;
    const { suggestions, eligible } = await this.#candidates(userId, settings);
    if (mode === "approval") {
      report.suggestions = suggestions;
      return;
    }
    for (const opportunity of eligible) {
      if (report.shortlisted.length >= this.#maxShortlistsPerRun) {
        report.suggestions.push(opportunity);
        continue;
      }
      try {
        const application = await runAsCareerActor(AUTONOMOUS_ACTOR, async () => {
          const created = await this.#career.shortlist(userId, opportunity.opportunityId);
          await this.#career.recordAutonomyEvent(
            userId,
            created.id,
            "autonomy.shortlist.executed",
            {
              mode: "autonomous",
              score: opportunity.score,
              minMatchScore: settings.guardrails.minMatchScore,
            },
          );
          return created;
        });
        report.shortlisted.push({
          opportunityId: opportunity.opportunityId,
          applicationId: application.id,
          score: application.matchScore,
        });
      } catch (error) {
        report.errors.push({ action: "shortlist", message: toAppError(error).userMessage });
      }
    }
  }

  async #documentsStep(
    userId: string,
    settings: CareerAutonomySettings,
    profile: CareerProfile,
    modes: Record<CareerAutonomyAction, AutonomyMode>,
    report: AutonomyRunReport,
  ): Promise<void> {
    if (modes.documents === "manual") return;
    const shortlisted = await this.#career.listApplications(userId, {
      state: "shortlisted",
      limit: 200,
    });
    for (const application of shortlisted) {
      const opportunity = await this.#careerStore.getOpportunity(userId, application.opportunityId);
      if (opportunity === undefined) continue;
      const verdict = this.#verdict(settings, "documents", opportunity, application, 0);
      const autonomous = modes.documents === "autonomous" && verdict.allowed;
      const actor = autonomous ? AUTONOMOUS_ACTOR : PREPARE_ACTOR;
      if (modes.documents === "autonomous" && !verdict.allowed) {
        report.blocked.push({
          action: "documents",
          applicationId: application.id,
          reasons: verdict.blocked,
        });
      }
      try {
        const kinds = await runAsCareerActor(actor, async () => {
          await this.#career.startDrafting(userId, application.id);
          const drafted: DocumentVariantKind[] = [];
          for (const kind of documentKindsFor(opportunity.kind)) {
            await this.#career.draftDocument(userId, application.id, {
              kind,
              body: generateCareerDocument(kind, profile, opportunity),
              parentVariantId: null,
            });
            drafted.push(kind);
          }
          await this.#career.recordAutonomyEvent(
            userId,
            application.id,
            autonomous ? "autonomy.documents.executed" : "autonomy.documents.awaiting_validation",
            {
              mode: modes.documents,
              kinds: drafted,
              ...(verdict.allowed ? {} : { heldBackBy: verdict.blocked.map((b) => b.code) }),
            },
          );
          return drafted;
        });
        report.documentsPrepared.push({ applicationId: application.id, actor, kinds });
      } catch (error) {
        report.errors.push({
          action: "documents",
          applicationId: application.id,
          message: toAppError(error).userMessage,
        });
        continue;
      }

      // Documents validated by autonomy: move on to the submission gate,
      // unless the owner wants to drive submissions entirely by hand.
      if (autonomous && modes.submission !== "manual") {
        const submissionActor =
          modes.submission === "autonomous" ? AUTONOMOUS_ACTOR : PREPARE_ACTOR;
        try {
          const requested = await runAsCareerActor(submissionActor, () =>
            this.#career.requestApproval(userId, application.id),
          );
          report.approvalsRequested.push({
            applicationId: application.id,
            confirmationId: requested.confirmation.id,
            actor: submissionActor,
          });
        } catch (error) {
          report.errors.push({
            action: "submission",
            applicationId: application.id,
            message: toAppError(error).userMessage,
          });
        }
      }
    }
  }

  async #submissionStep(
    userId: string,
    settings: CareerAutonomySettings,
    mode: AutonomyMode,
    report: AutonomyRunReport,
  ): Promise<void> {
    // Configured (not effective) mode: with the kill switch on, the verdict
    // below records `kill_switch` as the reason the submission was held back.
    if (mode === "manual" || settings.modes.submission !== "autonomous") return;
    const waiting = await this.#career.listApplications(userId, {
      state: "awaiting_confirmation",
      limit: 200,
    });
    const since = startOfDayInTimezone(this.#now(), settings.timezone);

    for (const application of waiting) {
      const live = await this.#liveConfirmation(userId, application.id);
      if (live?.state !== "pending") continue;
      const opportunity = await this.#careerStore.getOpportunity(userId, application.opportunityId);
      if (opportunity === undefined) continue;

      const submissionsToday = await this.#careerStore.countEvents(userId, {
        actor: AUTONOMOUS_ACTOR,
        kind: "application.submitted",
        since,
      });
      const verdict = this.#verdict(
        settings,
        "submission",
        opportunity,
        application,
        submissionsToday,
      );
      if (!verdict.allowed) {
        // Falls back to approval: the confirmation stays pending for the owner.
        report.blocked.push({
          action: "submission",
          applicationId: application.id,
          reasons: verdict.blocked,
        });
        await this.#recordBlockedOnce(userId, application.id, "submission", verdict);
        continue;
      }

      try {
        const result = await runAsCareerActor(AUTONOMOUS_ACTOR, async () => {
          // A request that expired while held back (cap, kill switch) is
          // renewed rather than answered late: `requestApproval` supersedes it
          // with a fresh one bound to the current payload hash.
          const confirmation =
            live.expiresAt > this.#now()
              ? live
              : (await this.#career.requestApproval(userId, application.id)).confirmation;
          await this.#career.recordAutonomyEvent(
            userId,
            application.id,
            "autonomy.submission.approved",
            {
              mode: "autonomous",
              confirmationId: confirmation.id,
              score: application.matchScore,
              submissionsToday,
              maxSubmissionsPerDay: settings.guardrails.maxSubmissionsPerDay,
            },
          );
          await this.#career.decideConfirmation(
            userId,
            confirmation.id,
            "approved",
            "Approved autonomously: every guardrail passed.",
          );
          return this.#career.submit(userId, application.id);
        });
        report.submitted.push({ applicationId: application.id, attemptId: result.attempt.id });
      } catch (error) {
        report.errors.push({
          action: "submission",
          applicationId: application.id,
          message: toAppError(error).userMessage,
        });
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  async #candidates(
    userId: string,
    settings: CareerAutonomySettings,
  ): Promise<{ suggestions: ShortlistSuggestion[]; eligible: ShortlistSuggestion[] }> {
    const ranked = await this.#career.search(userId, {
      limit: this.#scanLimit,
      includeExcluded: false,
    });
    const suggestions: ShortlistSuggestion[] = [];
    const eligible: ShortlistSuggestion[] = [];
    for (const item of ranked) {
      if (item.applicationState !== null && item.applicationState !== "discovered") continue;
      const verdict = evaluateAutonomyGuardrails({
        settings,
        action: "shortlist",
        candidate: candidateOf(item.opportunity, item.explanation.score),
        submissionsToday: 0,
      });
      const suggestion: ShortlistSuggestion = {
        opportunityId: item.opportunity.id,
        title: item.opportunity.title,
        organization: item.opportunity.organization,
        kind: item.opportunity.kind,
        score: item.explanation.score,
      };
      // Quality guardrails (score, exclusions) filter suggestions too; only
      // the mode and the kill switch separate "suggest" from "do".
      const qualityBlock = verdict.blocked.filter(
        (b) => b.code !== "kill_switch" && b.code !== "mode_not_autonomous",
      );
      if (qualityBlock.length > 0) continue;
      if (verdict.allowed) eligible.push(suggestion);
      else suggestions.push(suggestion);
    }
    return { suggestions, eligible };
  }

  #verdict(
    settings: CareerAutonomySettings,
    action: CareerAutonomyAction,
    opportunity: Opportunity,
    application: Application,
    submissionsToday: number,
  ): GuardrailVerdict {
    return evaluateAutonomyGuardrails({
      settings,
      action,
      candidate: candidateOf(opportunity, application.matchScore),
      submissionsToday,
    });
  }

  async #liveConfirmation(
    userId: string,
    applicationId: string,
  ): Promise<ConfirmationRecord | undefined> {
    const all = await this.#career.listConfirmations(userId, applicationId);
    return all.find((item) => item.state === "pending" || item.state === "approved");
  }

  /**
   * Records a guardrail refusal, once per distinct set of reasons: the
   * scheduler revisits the same application every tick, and an audit trail
   * repeating the same refusal every five minutes hides the entries that matter.
   */
  async #recordBlockedOnce(
    userId: string,
    applicationId: string,
    action: CareerAutonomyAction,
    verdict: GuardrailVerdict,
  ): Promise<void> {
    const kind = `autonomy.${action}.blocked`;
    const codes = verdict.blocked.map((b) => b.code).sort();
    const history = await this.#career.history(userId, applicationId);
    const last = history.at(-1);
    if (last?.kind === kind && sameCodes(last.context.codes, codes)) return;
    await runAsCareerActor(AUTONOMOUS_ACTOR, () =>
      this.#career.recordAutonomyEvent(userId, applicationId, kind, {
        codes,
        reasons: verdict.blocked.map((b) => b.detail).join(" "),
        fallback: "approval",
      }),
    );
  }
}

function effectiveModes(
  settings: CareerAutonomySettings,
): Record<CareerAutonomyAction, AutonomyMode> {
  return {
    shortlist: effectiveAutonomyMode(settings, "shortlist"),
    documents: effectiveAutonomyMode(settings, "documents"),
    submission: effectiveAutonomyMode(settings, "submission"),
  };
}

function candidateOf(opportunity: Opportunity, score: number | null) {
  return {
    organization: opportunity.organization,
    kind: opportunity.kind,
    title: opportunity.title,
    description: opportunity.description,
    requirements: opportunity.requirements,
    matchScore: score,
  };
}

function sameCodes(stored: unknown, codes: string[]): boolean {
  return (
    Array.isArray(stored) &&
    stored.length === codes.length &&
    stored.every((value, index) => value === codes[index])
  );
}

/** The documents each kind of application carries. */
export function documentKindsFor(kind: Opportunity["kind"]): DocumentVariantKind[] {
  if (kind === "phd") return ["cv", "cover_letter", "research_statement"];
  if (kind === "freelance") return ["cv", "portfolio_note"];
  return ["cv", "cover_letter"];
}

/**
 * Deterministic first draft built from the profile and the listing.
 *
 * Only facts the owner entered and facts the listing states — nothing
 * invented. The owner (or the approval gate) sees exactly this text before
 * anything leaves.
 */
export function generateCareerDocument(
  kind: DocumentVariantKind,
  profile: CareerProfile,
  opportunity: Opportunity,
): string {
  const wanted = new Set(opportunity.requirements.map((item) => item.toLowerCase()));
  const matching = profile.skills.filter((skill) => wanted.has(skill.toLowerCase()));
  const skills = (matching.length > 0 ? matching : profile.skills).slice(0, 8);
  const languages = profile.languages.map((l) => `${l.code} (${l.level})`).join(", ");
  const target = `${opportunity.title} at ${opportunity.organization}`;

  switch (kind) {
    case "cv":
      return [
        profile.headline,
        "",
        profile.summary,
        "",
        `Experience: ${String(profile.yearsExperience)} year(s). Highest degree: ${profile.highestDegree}.`,
        `Key skills for ${target}: ${skills.join(", ") || "see profile"}.`,
        languages.length > 0 ? `Languages: ${languages}.` : "",
        profile.publications > 0 ? `Publications: ${String(profile.publications)}.` : "",
      ]
        .filter((line, index, all) => line !== "" || all[index - 1] !== "")
        .join("\n")
        .trim();
    case "cover_letter":
      return [
        `Application for ${target}`,
        "",
        `I am applying for the ${opportunity.title} position at ${opportunity.organization}.`,
        `${profile.headline}, with ${String(profile.yearsExperience)} year(s) of experience.`,
        skills.length > 0
          ? `The role asks for ${opportunity.requirements.slice(0, 5).join(", ") || "skills I hold"}; I bring ${skills.join(", ")}.`
          : "",
        profile.summary,
        "",
        "I would welcome the opportunity to discuss how I can contribute.",
      ]
        .join("\n")
        .trim();
    case "research_statement":
      return [
        `Research statement — ${target}`,
        "",
        `Research interests: ${profile.preferences.researchAreas.join(", ") || "see profile"}.`,
        `Publications to date: ${String(profile.publications)}.`,
        profile.summary,
      ]
        .join("\n")
        .trim();
    case "portfolio_note":
      return [
        `Engagement proposal — ${target}`,
        "",
        profile.summary,
        `Relevant skills: ${skills.join(", ") || "see profile"}.`,
      ]
        .join("\n")
        .trim();
    case "reference_list":
      return "References available on request.";
  }
}
