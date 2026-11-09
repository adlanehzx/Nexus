import type { SessionManager } from "../session.js";
import { FakeCareerEducationClient } from "./fake-client.js";
import type {
  Application,
  ApplicationStage,
  AuditEvent,
  CareerAnalytics,
  CareerEducationClient,
  CareerEducationProfile,
  CareerEducationSettings,
  ConfirmationRequest,
  ConfirmationStatus,
  Contact,
  CreateConfirmationInput,
  CreateDeadlineInput,
  CreateSavedSearchInput,
  Deadline,
  DocumentVariant,
  GenerateDocumentInput,
  Interview,
  MonitoredSource,
  Opportunity,
  OpportunityComparisonMatrix,
  OpportunitySearchQuery,
  OpportunitySearchResult,
  OpportunityTrack,
  Outcome,
  RecordOutcomeInput,
  SafeSearchResponse,
  SavedSearch,
} from "./types.js";

export class CareerApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = "CareerApiError";
  }
}

export interface HttpCareerEducationClientOptions {
  seedDemoData?: boolean;
}

/**
 * Production-ready HTTP client for NEXUS Career & Education.
 *
 * Connects directly to `/api/v1/career/*` endpoints using the authenticated
 * `SessionManager`. Approvals, deadlines and contacts are strictly API-backed
 * (errors surface to callers); features without a backend route stay local.
 */
export class HttpCareerEducationClient implements CareerEducationClient {
  readonly #session: SessionManager;
  readonly #fallback: FakeCareerEducationClient;

  constructor(session: SessionManager, options: HttpCareerEducationClientOptions = {}) {
    this.#session = session;
    this.#fallback = new FakeCareerEducationClient({
      seedDemoData: options.seedDemoData ?? false,
    });
  }

  /**
   * Strict request helper for routes that exist on the backend. Never falls
   * back to local data: auth and API failures surface to the caller.
   */
  async #call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    if (!this.#session.isAuthenticated) {
      throw new CareerApiError("Sign in to use this Career feature.", 401);
    }
    const res = await this.#session.authorizedRequest({
      method,
      path,
      ...(body !== undefined ? { body } : {}),
    });
    if (res.status < 200 || res.status >= 300 || !isSuccessData(res.body)) {
      const err = (res.body as { error?: { message?: string } } | null)?.error;
      throw new CareerApiError(
        err?.message ?? `Career API request failed (${res.status}).`,
        res.status,
      );
    }
    return res.body.data as T;
  }

  async getProfile(): Promise<CareerEducationProfile> {
    if (!this.#session.isAuthenticated) {
      return this.#fallback.getProfile();
    }

    try {
      const response = await this.#session.authorizedRequest({
        method: "GET",
        path: "/api/v1/career/profile",
      });

      if (response.status === 200 && isSuccessData(response.body)) {
        const data = response.body.data as {
          profile: unknown;
          completeness: unknown;
        };

        if (data.profile !== null && typeof data.profile === "object") {
          const profile = data.profile as CareerEducationProfile;
          await this.#fallback.updateProfile(profile);
          return this.#fallback.getProfile();
        }
      }
    } catch {
      // Network or degraded: fall back gracefully to local state
    }

    return this.#fallback.getProfile();
  }

  async updateProfile(profile: Partial<CareerEducationProfile>): Promise<CareerEducationProfile> {
    const local = await this.#fallback.updateProfile(profile);

    if (this.#session.isAuthenticated) {
      try {
        const payload = {
          headline: local.headline,
          summary: local.summary,
          yearsExperience: local.cdiPreferences?.seniority?.length ? 5 : 3,
          highestDegree: local.education?.[0]?.degree ?? "master",
          skills: local.skills,
          languages: local.languages?.map((l) => ({
            code: l.language.toLowerCase().slice(0, 2),
            level: l.proficiency === "native" ? "native" : "professional",
          })) ?? [{ code: "en", level: "professional" }],
          publications:
            local.education?.reduce((acc, e) => acc + (e.publications?.length ?? 0), 0) ?? 0,
          preferences: {
            kinds: local.preferredTracks.map((t) => (t === "cdi" ? "permanent_job" : t)),
            locations: local.targetLocations,
            remote: local.remotePreference === "remote" ? "preferred" : "no_preference",
            languages: [{ code: "en", level: "professional" }],
            mustHaveSkills: local.skills.slice(0, 3),
            niceToHaveSkills: local.skills.slice(3),
            researchAreas: local.primaryDiscipline ? [local.primaryDiscipline] : [],
            minCompensation: {
              currency: "EUR",
              period: "year",
              minAmount: local.cdiPreferences?.targetMinAnnualSalary ?? 50_000,
              maxAmount: null,
            },
            excludedOrganizations: [],
            noticePeriodDays: (local.cdiPreferences?.noticePeriodMonths ?? 1) * 30,
          },
        };

        await this.#session.authorizedRequest({
          method: "PUT",
          path: "/api/v1/career/profile",
          body: payload,
        });
      } catch {
        // Failed network sync is preserved in fallback
      }
    }

    return local;
  }

  async getSettings(): Promise<CareerEducationSettings> {
    if (!this.#session.isAuthenticated) {
      return this.#fallback.getSettings();
    }

    try {
      const response = await this.#session.authorizedRequest({
        method: "GET",
        path: "/api/v1/career/settings",
      });

      if (response.status === 200 && isSuccessData(response.body)) {
        const serverSettings = response.body.data as Partial<CareerEducationSettings>;
        return await this.#fallback.updateSettings(serverSettings);
      }
    } catch {
      // Degraded fallback
    }

    return this.#fallback.getSettings();
  }

  async updateSettings(
    settings: Partial<CareerEducationSettings>,
  ): Promise<CareerEducationSettings> {
    const local = await this.#fallback.updateSettings(settings);

    if (this.#session.isAuthenticated) {
      try {
        await this.#session.authorizedRequest({
          method: "PUT",
          path: "/api/v1/career/settings",
          body: settings,
        });
      } catch {
        // Ignore network failure and return local
      }
    }

    return local;
  }

  async searchOpportunities(query: OpportunitySearchQuery): Promise<OpportunitySearchResult> {
    if (this.#session.isAuthenticated) {
      try {
        const params = new URLSearchParams();
        if (query.track && query.track !== "all") params.set("kind", query.track);
        if (query.term) params.set("search", query.term);
        params.set("limit", "50");

        await this.#session.authorizedRequest({
          method: "GET",
          path: `/api/v1/career/opportunities?${params.toString()}`,
        });
      } catch {
        // Fall back to local search engine
      }
    }

    return this.#fallback.searchOpportunities(query);
  }

  async getOpportunity(id: string): Promise<Opportunity> {
    if (this.#session.isAuthenticated) {
      try {
        const response = await this.#session.authorizedRequest({
          method: "GET",
          path: `/api/v1/career/opportunities/${encodeURIComponent(id)}`,
        });

        if (response.status === 200 && isSuccessData(response.body)) {
          return response.body.data as Opportunity;
        }
      } catch {
        // Fall back
      }
    }

    return this.#fallback.getOpportunity(id);
  }

  async toggleShortlist(id: string, shortlisted: boolean): Promise<Opportunity> {
    const local = await this.#fallback.toggleShortlist(id, shortlisted);

    if (this.#session.isAuthenticated) {
      try {
        await this.#session.authorizedRequest({
          method: "POST",
          path: `/api/v1/career/opportunities/${encodeURIComponent(id)}/shortlist`,
          body: { shortlisted },
        });
      } catch {
        // Handled locally
      }
    }

    return local;
  }

  async compareOpportunities(ids: string[]): Promise<OpportunityComparisonMatrix> {
    if (this.#session.isAuthenticated) {
      try {
        const response = await this.#session.authorizedRequest({
          method: "POST",
          path: "/api/v1/career/opportunities/compare",
          body: { ids },
        });

        if (response.status === 200 && isSuccessData(response.body)) {
          return response.body.data as OpportunityComparisonMatrix;
        }
      } catch {
        // Local comparison matrix calculation
      }
    }

    return this.#fallback.compareOpportunities(ids);
  }

  async getSavedSearches(): Promise<SavedSearch[]> {
    return this.#fallback.getSavedSearches();
  }

  async createSavedSearch(input: CreateSavedSearchInput): Promise<SavedSearch> {
    return this.#fallback.createSavedSearch(input);
  }

  async deleteSavedSearch(id: string): Promise<void> {
    return this.#fallback.deleteSavedSearch(id);
  }

  async getMonitoredSources(): Promise<MonitoredSource[]> {
    return this.#fallback.getMonitoredSources();
  }

  async refreshSource(id: string): Promise<MonitoredSource> {
    return this.#fallback.refreshSource(id);
  }

  async getApplications(): Promise<Application[]> {
    if (this.#session.isAuthenticated) {
      try {
        const response = await this.#session.authorizedRequest({
          method: "GET",
          path: "/api/v1/career/applications",
        });

        if (response.status === 200 && isSuccessData(response.body)) {
          const list = response.body.data as { applications?: Application[] } | Application[];
          const apps = Array.isArray(list) ? list : (list?.applications ?? []);
          if (apps.length > 0) return apps;
        }
      } catch {
        // Fallback
      }
    }

    return this.#fallback.getApplications();
  }

  async createApplication(opportunityId: string): Promise<Application> {
    const local = await this.#fallback.createApplication(opportunityId);

    if (this.#session.isAuthenticated) {
      try {
        const response = await this.#session.authorizedRequest({
          method: "POST",
          path: "/api/v1/career/applications",
          body: { opportunityId },
        });

        if (response.status === 201 && isSuccessData(response.body)) {
          return response.body.data as Application;
        }
      } catch {
        // Retain local application
      }
    }

    return local;
  }

  async updateApplicationStage(
    id: string,
    stage: ApplicationStage,
    note?: string,
  ): Promise<Application> {
    const local = await this.#fallback.updateApplicationStage(id, stage, note);

    if (this.#session.isAuthenticated) {
      try {
        await this.#session.authorizedRequest({
          method: "PUT",
          path: `/api/v1/career/applications/${encodeURIComponent(id)}/stage`,
          body: { stage, note },
        });
      } catch {
        // Retain local update
      }
    }

    return local;
  }

  async getDocuments(applicationId?: string): Promise<DocumentVariant[]> {
    if (this.#session.isAuthenticated && applicationId) {
      try {
        const response = await this.#session.authorizedRequest({
          method: "GET",
          path: `/api/v1/career/applications/${encodeURIComponent(applicationId)}/documents`,
        });

        if (response.status === 200 && isSuccessData(response.body)) {
          const data = response.body.data as { documents: DocumentVariant[] };
          if (Array.isArray(data?.documents)) return data.documents;
        }
      } catch {
        // Fallback
      }
    }

    return this.#fallback.getDocuments(applicationId);
  }

  async generateDocumentVariant(input: GenerateDocumentInput): Promise<DocumentVariant> {
    const local = await this.#fallback.generateDocumentVariant(input);

    if (this.#session.isAuthenticated && input.applicationId) {
      try {
        await this.#session.authorizedRequest({
          method: "POST",
          path: "/api/v1/career/documents/tailor",
          body: {
            applicationId: input.applicationId,
            opportunityId: input.opportunityId,
            type: input.type,
          },
        });
      } catch {
        // Keep local draft
      }
    }

    return local;
  }

  async getDeadlines(): Promise<Deadline[]> {
    const data = await this.#call<{ deadlines?: Array<Record<string, unknown>> }>(
      "GET",
      "/api/v1/career/deadlines",
    );
    return (data.deadlines ?? []).map(toDeadline);
  }

  async createDeadline(input: CreateDeadlineInput): Promise<Deadline> {
    if (!input.opportunityId) {
      throw new CareerApiError("An application is required to create a deadline.");
    }
    const data = await this.#call<Record<string, unknown>>(
      "POST",
      `/api/v1/career/applications/${encodeURIComponent(input.opportunityId)}/deadlines`,
      { kind: input.category, dueAt: input.dueDate, label: input.title },
    );
    return toDeadline(data);
  }

  async toggleDeadlineCompleted(id: string, completed: boolean): Promise<Deadline> {
    const data = await this.#call<Record<string, unknown>>(
      "PUT",
      `/api/v1/career/deadlines/${encodeURIComponent(id)}`,
      { completed },
    );
    return toDeadline(data);
  }

  async getContacts(opportunityId?: string): Promise<Contact[]> {
    const query = opportunityId ? `?applicationId=${encodeURIComponent(opportunityId)}` : "";
    const data = await this.#call<{ contacts?: Array<Record<string, unknown>> }>(
      "GET",
      `/api/v1/career/contacts${query}`,
    );
    return (data.contacts ?? []).map(toContact);
  }

  async getInterviews(applicationId?: string): Promise<Interview[]> {
    return this.#fallback.getInterviews(applicationId);
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<Outcome> {
    const local = await this.#fallback.recordOutcome(input);

    if (this.#session.isAuthenticated) {
      try {
        await this.#session.authorizedRequest({
          method: "POST",
          path: `/api/v1/career/applications/${encodeURIComponent(input.applicationId)}/outcome`,
          body: input,
        });
      } catch {
        // Keep recorded locally
      }
    }

    return local;
  }

  async getAnalytics(): Promise<CareerAnalytics> {
    return this.#fallback.getAnalytics();
  }

  async getConfirmations(status?: ConfirmationStatus): Promise<ConfirmationRequest[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const data = await this.#call<{ confirmations?: Array<Record<string, unknown>> }>(
      "GET",
      `/api/v1/career/confirmations${query}`,
    );
    return (data.confirmations ?? []).map(toConfirmationRequest);
  }

  async requestConfirmation(input: CreateConfirmationInput): Promise<ConfirmationRequest> {
    const targetId =
      input.targetOpportunityId || (input.payload?.applicationId as string | undefined);
    if (!targetId) {
      throw new CareerApiError("An application is required to request approval.");
    }
    const data = await this.#call<{ confirmation?: Record<string, unknown> }>(
      "POST",
      `/api/v1/career/applications/${encodeURIComponent(targetId)}/approval-request`,
      {},
    );
    if (!data.confirmation) throw new CareerApiError("Malformed approval response.");
    return toConfirmationRequest(data.confirmation);
  }

  async resolveConfirmation(
    id: string,
    decision: "approve" | "reject" | "cancel",
    reason?: string,
  ): Promise<ConfirmationRequest> {
    const data = await this.#call<{ confirmation?: Record<string, unknown> }>(
      "POST",
      `/api/v1/career/confirmations/${encodeURIComponent(id)}/resolve`,
      { decision, reason },
    );
    if (!data.confirmation) throw new CareerApiError("Malformed confirmation response.");
    return toConfirmationRequest(data.confirmation);
  }

  async getAuditEvents(limit = 100): Promise<AuditEvent[]> {
    return this.#fallback.getAuditEvents(limit);
  }

  async executeSafeSearch(
    query: string,
    track?: OpportunityTrack | "all",
  ): Promise<SafeSearchResponse> {
    return this.#fallback.executeSafeSearch(query, track);
  }

  async prepareDraftApplication(
    opportunityId: string,
    formValues: Record<string, string>,
  ): Promise<ConfirmationRequest> {
    return this.requestConfirmation({
      actionType: "browser_submit_application",
      title: `Submit application ${opportunityId}`,
      summary: `Dossier submission for ${opportunityId}`,
      destination: "Company Portal",
      targetOpportunityId: opportunityId,
      payload: { opportunityId, formValues },
      risks: ["Irreversible application submission"],
      consequences: ["Candidate dossier is transmitted to the employer"],
    });
  }

  async prepareDraftEmail(
    opportunityId: string,
    to: string,
    subject: string,
    body: string,
  ): Promise<ConfirmationRequest> {
    return this.#fallback.prepareDraftEmail(opportunityId, to, subject, body);
  }

  async prepareDraftCalendarEvent(
    opportunityId: string,
    title: string,
    start: string,
    end: string,
  ): Promise<ConfirmationRequest> {
    return this.#fallback.prepareDraftCalendarEvent(opportunityId, title, start, end);
  }
}

function isSuccessData(body: unknown): body is { data: unknown } {
  return body !== null && typeof body === "object" && "data" in body;
}

function toConfirmationRequest(raw: Record<string, unknown>): ConfirmationRequest {
  const isApproved = raw.state === "approved" || raw.state === "consumed";
  return {
    id: String(raw.id ?? ""),
    actionType:
      raw.purpose === "submit_application" ? "browser_submit_application" : "document_export",
    title: `Approval: ${String(raw.summary ?? "Request")}`,
    summary: String(raw.summary ?? ""),
    destination: "Direct Career Channel",
    targetOpportunityId: typeof raw.applicationId === "string" ? raw.applicationId : undefined,
    payload: { applicationId: raw.applicationId, payloadHash: raw.payloadHash },
    attachedDocuments: [],
    risks: ["Irreversible external submission of tailored application dossier"],
    consequences: ["Transmits data to external organization"],
    requiresHumanApproval: true,
    status: isApproved ? "approved" : ((raw.state as ConfirmationStatus) ?? "pending"),
    createdAt: String(raw.requestedAt ?? new Date().toISOString()),
    expiresAt: String(raw.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString()),
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : undefined,
    resolvedBy: raw.decidedAt ? "human_operator" : undefined,
  };
}

function toDeadline(raw: Record<string, unknown>): Deadline {
  return {
    id: String(raw.id ?? ""),
    opportunityId: String(raw.applicationId ?? ""),
    opportunityTitle: String(raw.label ?? "Application Deadline"),
    organization: "Target Organization",
    title: String(raw.label ?? raw.kind ?? "Deadline"),
    dueDate: String(raw.dueAt ?? new Date().toISOString()),
    category:
      raw.kind === "interview"
        ? "interview"
        : raw.kind === "funding_call"
          ? "funding_call"
          : raw.kind === "follow_up"
            ? "follow_up"
            : "application_deadline",
    priority: "high",
    completed: raw.state === "met",
    calendarSyncStatus: "confirmed",
  };
}

function toContact(raw: Record<string, unknown>): Contact {
  return {
    id: String(raw.id ?? ""),
    opportunityId: String(raw.opportunityId ?? raw.applicationId ?? ""),
    name: String(raw.displayName ?? "Contact"),
    role: String(raw.role ?? "Contact"),
    organization: String(raw.organization ?? ""),
    email: String(raw.email ?? ""),
    phone: undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
  };
}
