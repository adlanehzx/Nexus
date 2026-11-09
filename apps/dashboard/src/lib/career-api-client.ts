import {
  FakeCareerEducationClient,
  HttpCareerEducationClient,
  type SessionManager,
  type Opportunity,
  type OpportunitySearchQuery,
  type OpportunitySearchResult,
  type Application,
  type ApplicationStage,
  type CareerEducationProfile,
  type DocumentVariant,
  type GenerateDocumentInput,
  type ConfirmationRequest,
  type ConfirmationStatus,
  type CreateConfirmationInput,
  type Deadline,
  type CreateDeadlineInput,
  type Contact,
} from "@nexus/client-core";
import type {
  opportunityView,
  profileView,
  applicationView,
  documentView,
  documentSummaryView,
  confirmationView,
  deadlineView,
  contactView,
  CareerProfileInput,
  CompletenessReport,
  MatchExplanation,
} from "@nexus/career";
import { DashboardApi } from "./api.js";

export type CareerOpportunityDto = ReturnType<typeof opportunityView> & {
  matchExplanation?: MatchExplanation;
  applicationState?: string | null;
};
export type CareerDocumentDto = ReturnType<typeof documentView>;
export type CareerDocumentSummaryDto = ReturnType<typeof documentSummaryView>;
export type CareerApplicationDto = ReturnType<typeof applicationView>;
export type CareerConfirmationDto = ReturnType<typeof confirmationView>;
export type CareerDeadlineDto = ReturnType<typeof deadlineView>;
export type CareerContactDto = ReturnType<typeof contactView>;
export interface CareerProfileDto {
  profile: ReturnType<typeof profileView> | null;
  completeness: CompletenessReport | null;
}

export function careerOpportunity(dto: CareerOpportunityDto): Opportunity {
  const explanation = dto.matchExplanation;
  const factors = explanation?.factors ?? [];
  const factor = (name: string) =>
    Math.round((factors.find((f) => f.factor === name)?.score ?? 0) * 100);
  const age = Date.now() - Date.parse(dto.postedAt ?? dto.createdAt);
  return {
    id: dto.id,
    title: dto.title,
    organization: dto.organization,
    track: dto.kind === "permanent_job" ? "cdi" : dto.kind,
    location: dto.location,
    remotePolicy: dto.remote ? "remote" : "onsite",
    description: dto.description,
    publishedAt: dto.postedAt ?? dto.createdAt,
    discoveredAt: dto.createdAt,
    sourceUrl: dto.canonicalUrl ?? "",
    sourceFeedName: dto.provenance[0]?.kind ?? "unverified",
    staleness: age < 7 * 86400000 ? "fresh" : age < 30 * 86400000 ? "aging" : "stale",
    duplicate: { isDuplicate: false, reason: "none" },
    // Provenance evidence is not a verified quotation or a document hash.
    citations: [],
    match: {
      score: explanation?.score ?? 0,
      rationale: explanation
        ? factors.map((f) => f.evidence).join(" ")
        : "Complete your profile to receive a match score.",
      strengths: factors.filter((f) => f.score >= 0.7).map((f) => f.evidence),
      gaps: factors.filter((f) => f.score < 0.7).map((f) => f.evidence),
      breakdown: {
        skills: factor("profile_skills"),
        compensation: factor("compensation"),
        location: factor("location"),
        trackFit: factor("kind"),
      },
    },
    workflowStatus:
      !dto.applicationState || dto.applicationState === "discovered"
        ? "inbox"
        : dto.applicationState === "shortlisted" || dto.applicationState === "drafting"
          ? "shortlisted"
          : dto.applicationState === "withdrawn" ||
              dto.applicationState === "rejected" ||
              dto.applicationState === "expired"
            ? "dismissed"
            : "applied",
  };
}

export function careerConfirmation(dto: CareerConfirmationDto): ConfirmationRequest {
  const isApproved = dto.state === "approved" || dto.state === "consumed";
  return {
    id: dto.id,
    actionType:
      dto.purpose === "submit_application" ? "browser_submit_application" : "document_export",
    title: `Approval: ${dto.summary}`,
    summary: dto.summary,
    destination: "Direct Career Channel",
    targetOpportunityId: dto.applicationId,
    payload: { applicationId: dto.applicationId, payloadHash: dto.payloadHash },
    attachedDocuments: [],
    risks: ["Irreversible external transmission of tailored application dossier"],
    consequences: ["Transmits data to external organization"],
    requiresHumanApproval: true,
    status: isApproved ? "approved" : (dto.state as ConfirmationStatus),
    createdAt: dto.requestedAt,
    expiresAt: dto.expiresAt,
    decidedAt: dto.decidedAt ?? undefined,
    resolvedBy: dto.decidedAt ? "human_operator" : undefined,
  };
}

export function careerDeadline(dto: CareerDeadlineDto): Deadline {
  return {
    id: dto.id,
    opportunityId: dto.applicationId,
    opportunityTitle: dto.label ?? "Application Deadline",
    organization: "Target Organization",
    title: dto.label ?? dto.kind,
    dueDate: dto.dueAt,
    category:
      dto.kind === "interview"
        ? "interview"
        : dto.kind === "funding_call"
          ? "funding_call"
          : dto.kind === "follow_up"
            ? "follow_up"
            : "application_deadline",
    priority: "high",
    completed: dto.state === "met",
    calendarSyncStatus: "confirmed",
  };
}

export function careerContact(dto: CareerContactDto): Contact {
  return {
    id: dto.id,
    opportunityId: dto.opportunityId ?? dto.applicationId ?? "",
    name: dto.displayName,
    role: dto.role ?? "Contact",
    organization: dto.organization ?? "",
    email: dto.email ?? "",
    phone: undefined,
    notes: dto.notes ?? undefined,
  };
}

const stages: Record<string, ApplicationStage> = {
  discovered: "discovered",
  shortlisted: "shortlisted",
  drafting: "preparing",
  awaiting_confirmation: "pending_approval",
  approved: "pending_approval",
  submitted: "submitted",
  interview: "interviewing",
  offer: "offer",
  rejected: "rejected",
  withdrawn: "withdrawn",
  expired: "withdrawn",
};

/** Server-backed reads and writes for the ready career discovery/profile/pipeline routes. */
export class DashboardCareerClient extends HttpCareerEducationClient {
  readonly #api: DashboardApi;
  readonly #defaults = new FakeCareerEducationClient({ seedDemoData: false });
  constructor(session: SessionManager) {
    super(session, { seedDemoData: false });
    this.#api = new DashboardApi(session);
  }

  override async getProfile(): Promise<CareerEducationProfile> {
    const { profile, completeness } = await this.#api.careerProfile();
    const empty = await this.#defaults.getProfile();
    if (!profile) return empty;
    return {
      ...empty,
      id: profile.id,
      updatedAt: profile.updatedAt,
      headline: profile.headline,
      summary: profile.summary,
      skills: profile.skills,
      preferredTracks: profile.preferences.kinds.map((k) => (k === "permanent_job" ? "cdi" : k)),
      primaryDiscipline: profile.preferences.researchAreas[0] ?? "",
      targetLocations: profile.preferences.locations,
      remotePreference:
        profile.preferences.remote === "required" || profile.preferences.remote === "preferred"
          ? "remote"
          : "onsite",
      languages: profile.languages.map((l) => ({
        language: l.code,
        proficiency: l.level === "professional" ? "intermediate" : l.level,
      })),
      education:
        profile.highestDegree === "none"
          ? []
          : [{ degree: profile.highestDegree, institution: "", fieldOfStudy: "" }],
      completeness: {
        score: completeness?.score ?? 0,
        breakdown: [],
        missingCrucialFields: completeness?.gaps.map((g) => g.field) ?? [],
        actionableRecommendations: completeness?.gaps.map((g) => g.reason) ?? [],
      },
    };
  }

  override async updateProfile(
    update: Partial<CareerEducationProfile>,
  ): Promise<CareerEducationProfile> {
    const [{ profile }, current] = await Promise.all([
      this.#api.careerProfile(),
      this.getProfile(),
    ]);
    const merged = { ...current, ...update };
    const degree = merged.education[0]?.degree;
    const payload: CareerProfileInput = {
      headline: merged.headline,
      summary: merged.summary,
      yearsExperience: profile?.yearsExperience ?? 0,
      highestDegree:
        degree === "bachelor" || degree === "master" || degree === "phd" ? degree : "none",
      skills: merged.skills,
      languages: merged.languages.map((l) => ({
        code: l.language.toLowerCase().slice(0, 2),
        level: l.proficiency === "intermediate" ? "professional" : l.proficiency,
      })),
      publications: profile?.publications ?? 0,
      preferences: {
        languages: [],
        mustHaveSkills: [],
        niceToHaveSkills: [],
        minCompensation: null,
        excludedOrganizations: [],
        noticePeriodDays: 0,
        ...profile?.preferences,
        kinds: merged.preferredTracks.map((k) => (k === "cdi" ? "permanent_job" : k)),
        locations: merged.targetLocations,
        remote: merged.remotePreference === "remote" ? "preferred" : "onsite_only",
        researchAreas: merged.primaryDiscipline ? [merged.primaryDiscipline] : [],
      },
    };
    await this.#api.saveCareerProfile(payload);
    return this.getProfile();
  }

  override async searchOpportunities(
    query: OpportunitySearchQuery,
  ): Promise<OpportunitySearchResult> {
    const result = await this.#api.careerOpportunities(query.track);
    const items = result.opportunities
      .map(careerOpportunity)
      .filter(
        (opp) =>
          (!query.term ||
            `${opp.title} ${opp.organization} ${opp.description} ${opp.match.strengths.join(" ")}`
              .toLowerCase()
              .includes(query.term.toLowerCase())) &&
          (!query.onlyFresh || opp.staleness === "fresh") &&
          (!query.minScore || opp.match.score >= query.minScore) &&
          (!query.locationType ||
            query.locationType === "all" ||
            opp.remotePolicy === query.locationType),
      );
    return {
      items,
      total: items.length,
      duplicateCount: 0,
      stalenessBreakdown: {
        fresh: items.filter((i) => i.staleness === "fresh").length,
        aging: items.filter((i) => i.staleness === "aging").length,
        stale: items.filter((i) => i.staleness === "stale").length,
      },
      trackBreakdown: {
        phd: items.filter((i) => i.track === "phd").length,
        cdi: items.filter((i) => i.track === "cdi").length,
        freelance: items.filter((i) => i.track === "freelance").length,
      },
    };
  }

  override async getOpportunity(id: string): Promise<Opportunity> {
    return careerOpportunity(await this.#api.careerOpportunity(id));
  }
  async #application(dto: CareerApplicationDto): Promise<Application> {
    return {
      id: dto.id,
      opportunityId: dto.opportunityId,
      opportunity: await this.getOpportunity(dto.opportunityId),
      stage: stages[dto.state] ?? "discovered",
      stageHistory: [
        { stage: stages[dto.state] ?? "discovered", transitionedAt: dto.stateChangedAt },
      ],
      tailoredDocumentIds: [],
      assignedContactIds: [],
      notes: dto.notes,
      updatedAt: dto.updatedAt,
    };
  }
  override async getApplications(): Promise<Application[]> {
    return Promise.all(
      (await this.#api.careerApplications()).applications.map((a) => this.#application(a)),
    );
  }
  override async createApplication(opportunityId: string): Promise<Application> {
    return this.#application(await this.#api.createCareerApplication(opportunityId));
  }
  override async updateApplicationStage(
    id: string,
    stage: ApplicationStage,
    note?: string,
  ): Promise<Application> {
    return this.#application(await this.#api.updateCareerApplicationStage(id, stage, note));
  }
  override async toggleShortlist(id: string, shortlisted: boolean): Promise<Opportunity> {
    if (!shortlisted)
      throw new Error(
        "Removing a shortlist entry is unavailable. Update its status in Application Kanban.",
      );
    await this.#api.shortlistCareerOpportunity(id);
    return { ...(await this.getOpportunity(id)), workflowStatus: "shortlisted" };
  }
  async #document(dto: CareerDocumentDto): Promise<DocumentVariant> {
    const apps = (await this.#api.careerApplications()).applications;
    const app = apps.find((a) => a.id === dto.applicationId);
    if (!app) throw new Error("Document application no longer exists.");
    const opportunity = await this.getOpportunity(app.opportunityId);
    return {
      id: dto.id,
      applicationId: dto.applicationId,
      opportunityId: app.opportunityId,
      type: dto.kind === "cv" || dto.kind === "research_statement" ? dto.kind : "cover_letter",
      title: `${dto.kind} · ${opportunity.title}`,
      targetRole: opportunity.title,
      targetOrganization: opportunity.organization,
      markdownContent: dto.body,
      tailoredHighlights: [],
      diffSummary: { sectionsTailored: [], skillsEmphasized: [], customClausesAdded: [] },
      generatedAt: dto.createdAt,
      digestSha256: dto.contentHash,
    };
  }
  override async getDocuments(applicationId?: string): Promise<DocumentVariant[]> {
    const ids = applicationId
      ? [applicationId]
      : (await this.#api.careerApplications()).applications.map((a) => a.id);
    const lists = await Promise.all(ids.map((id) => this.#api.careerDocuments(id)));
    return Promise.all(
      lists
        .flatMap((list) => list.documents)
        .map(async (d) => this.#document(await this.#api.careerDocument(d.id))),
    );
  }
  override async generateDocumentVariant(input: GenerateDocumentInput): Promise<DocumentVariant> {
    return this.#document(await this.#api.tailorCareerDocument(input));
  }
  override async compareOpportunities(ids: string[]) {
    const data = await this.#api.compareCareerOpportunities(ids);
    const opportunities = data.items.map(careerOpportunity);
    return {
      opportunityIds: opportunities.map((o) => o.id),
      opportunities,
      metrics: ["location", "remotePolicy"].map((key) => ({
        key,
        label: key,
        valuesByOpportunityId: Object.fromEntries(
          opportunities.map((o) => [o.id, key === "location" ? o.location : o.remotePolicy]),
        ),
      })),
      tradeoffsSummary: [],
    };
  }

  override async getConfirmations(status?: ConfirmationStatus): Promise<ConfirmationRequest[]> {
    const res = await this.#api.careerConfirmations(undefined, status);
    return res.confirmations.map(careerConfirmation);
  }

  override async requestConfirmation(input: CreateConfirmationInput): Promise<ConfirmationRequest> {
    const apps = (await this.#api.careerApplications()).applications;
    let targetApp = input.targetOpportunityId
      ? apps.find(
          (a) =>
            a.id === input.targetOpportunityId || a.opportunityId === input.targetOpportunityId,
        )
      : undefined;

    if (!targetApp && input.targetOpportunityId) {
      targetApp = await this.#api.createCareerApplication(input.targetOpportunityId);
    }

    if (!targetApp) {
      targetApp = apps[0];
    }
    if (!targetApp) {
      throw new Error("No application found to request approval for.");
    }

    if (targetApp.state === "shortlisted" || targetApp.state === "discovered") {
      targetApp = await this.#api.updateCareerApplicationStage(targetApp.id, "drafting");
    }

    const docs = await this.#api.careerDocuments(targetApp.id);
    if (docs.documents.length === 0) {
      await this.#api.tailorCareerDocument({
        opportunityId: targetApp.opportunityId,
        applicationId: targetApp.id,
        type: "cover_letter",
      });
    }

    const res = await this.#api.requestCareerApproval(targetApp.id);
    return careerConfirmation(res.confirmation);
  }

  override async resolveConfirmation(
    id: string,
    decision: "approve" | "reject" | "cancel",
    reason?: string,
  ): Promise<ConfirmationRequest> {
    const res = await this.#api.resolveCareerConfirmation(id, decision, reason);
    return careerConfirmation(res.confirmation);
  }

  override async getDeadlines(): Promise<Deadline[]> {
    const res = await this.#api.careerDeadlines();
    return res.deadlines.map(careerDeadline);
  }

  override async createDeadline(input: CreateDeadlineInput): Promise<Deadline> {
    const apps = (await this.#api.careerApplications()).applications;
    const app =
      apps.find((a) => a.id === input.opportunityId || a.opportunityId === input.opportunityId) ??
      apps[0];
    if (!app) throw new Error("No application found for deadline.");
    const res = await this.#api.createCareerDeadline(app.id, {
      kind: input.category,
      dueAt: input.dueDate,
      label: input.title,
    });
    return careerDeadline(res);
  }

  override async toggleDeadlineCompleted(id: string, completed: boolean): Promise<Deadline> {
    const res = await this.#api.updateCareerDeadline(id, { completed });
    return careerDeadline(res);
  }

  override async getContacts(opportunityId?: string): Promise<Contact[]> {
    const res = await this.#api.careerContacts(opportunityId);
    return res.contacts.map(careerContact);
  }

  override async prepareDraftApplication(
    opportunityId: string,
    _formValues: Record<string, string>,
  ): Promise<ConfirmationRequest> {
    return this.requestConfirmation({
      actionType: "browser_submit_application",
      title: `Submit Application for ${opportunityId}`,
      summary: `Automated dossier submission for opportunity ${opportunityId}`,
      destination: "Company Portal",
      targetOpportunityId: opportunityId,
      payload: { opportunityId },
      risks: ["Irreversible application submission"],
      consequences: ["Candidate dossier is transmitted to employer"],
    });
  }
}
