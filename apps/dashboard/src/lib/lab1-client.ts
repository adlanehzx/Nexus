import type { SessionManager } from "@nexus/client-core";

/**
 * Lab 1 dashboard client: career autonomy and LinkedIn content management.
 *
 * Kept separate from the generic `DashboardApi` so the career lab owns its
 * contract. Every method throws `Lab1RequestError` on a non-2xx answer with
 * the server's user-facing message and status, so panels can show a real
 * error state (503 = LinkedIn / browser worker unavailable) instead of a
 * silent no-op.
 */

export type AutonomyMode = "manual" | "approval" | "autonomous";
export type CareerAutonomyAction = "shortlist" | "documents" | "submission";
export type OpportunityKind = "phd" | "permanent_job" | "freelance";

export interface CareerAutonomySettings {
  modes: Record<CareerAutonomyAction, AutonomyMode>;
  guardrails: {
    minMatchScore: number;
    maxSubmissionsPerDay: number;
    excludedCompanies: string[];
    excludedKeywords: string[];
    excludedContractTypes: OpportunityKind[];
  };
  killSwitch: boolean;
  timezone: string;
}

export interface CareerAutonomySettingsView {
  settings: CareerAutonomySettings;
  effectiveModes: Record<CareerAutonomyAction, AutonomyMode>;
  configured: boolean;
  updatedAt: string | null;
}

export interface ShortlistSuggestion {
  opportunityId: string;
  title: string;
  organization: string;
  kind: OpportunityKind;
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
    documents: { id: string; kind: string; revision: number }[];
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

export interface AutonomyRunReport {
  ranAt: string;
  shortlisted: unknown[];
  suggestions: ShortlistSuggestion[];
  documentsPrepared: unknown[];
  approvalsRequested: unknown[];
  submitted: unknown[];
  blocked: { action: string; reasons: { code: string; detail: string }[] }[];
  errors: { action: string; message: string }[];
}

export interface CareerEventDto {
  id: string;
  applicationId: string;
  sequence: number;
  kind: string;
  fromState: string | null;
  toState: string | null;
  summary: string;
  context: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

export type LinkedInAction = "publishPost" | "react" | "comment";
export type LinkedInReaction =
  "LIKE" | "PRAISE" | "EMPATHY" | "INTEREST" | "APPRECIATION" | "ENTERTAINMENT";

export interface LinkedInContentSettings {
  modes: Record<LinkedInAction, AutonomyMode>;
  posts: {
    topics: string[];
    tone: string;
    language: string;
    visibility: "PUBLIC" | "CONNECTIONS";
    schedule: { daysOfWeek: number[]; times: string[]; timezone: string };
    hashtags: {
      policy: "none" | "fixed" | "generated" | "fixed_and_generated";
      fixed: string[];
      maxPerPost: number;
    };
    maxPostsPerWeek: number;
    draftLeadHours: number;
  };
  engagement: {
    maxActionsPerHour: number;
    maxActionsPerDay: number;
    minDelaySeconds: number;
    maxDelaySeconds: number;
    activeHours: { start: string; end: string; timezone: string };
    defaultReaction: LinkedInReaction;
    topics: string[];
  };
  killSwitch: boolean;
}

export interface LinkedInSettingsView {
  settings: LinkedInContentSettings;
  effectiveModes: Record<LinkedInAction, AutonomyMode>;
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

export type LinkedInPostState =
  | "draft"
  | "awaiting_approval"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "rejected"
  | "cancelled";

export interface LinkedInPostDto {
  id: string;
  state: LinkedInPostState;
  text: string;
  topic: string | null;
  visibility: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalId: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedInEngagementDto {
  id: string;
  kind: "reaction" | "comment";
  target: string;
  reaction: LinkedInReaction | null;
  text: string | null;
  rationale: string | null;
  state: "proposed" | "queued" | "executing" | "executed" | "failed" | "rejected" | "cancelled";
  executeAfter: string | null;
  executedAt: string | null;
  executor: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: string;
}

export interface LinkedInAuditDto {
  id: string;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  outcome: "ok" | "blocked" | "failed";
  summary: string;
  createdAt: string;
}

export class Lab1RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "Lab1RequestError";
    this.status = status;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class Lab1Client {
  readonly #session: SessionManager;

  constructor(session: SessionManager) {
    this.#session = session;
  }

  // ── Career autonomy ───────────────────────────────────────────────────────

  autonomySettings(): Promise<CareerAutonomySettingsView> {
    return this.#request("GET", "/api/v1/career/autonomy/settings");
  }

  updateAutonomySettings(
    patch: Partial<{
      modes: Partial<CareerAutonomySettings["modes"]>;
      guardrails: Partial<CareerAutonomySettings["guardrails"]>;
      killSwitch: boolean;
      timezone: string;
    }>,
  ): Promise<CareerAutonomySettingsView> {
    return this.#request("PUT", "/api/v1/career/autonomy/settings", patch);
  }

  runAutonomy(): Promise<AutonomyRunReport> {
    return this.#request("POST", "/api/v1/career/autonomy/run", {});
  }

  autonomyQueue(): Promise<AutonomyQueue> {
    return this.#request("GET", "/api/v1/career/autonomy/queue");
  }

  shortlist(opportunityId: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/career/opportunities/${encodeURIComponent(opportunityId)}/shortlist`,
      {},
    );
  }

  validateDocuments(applicationId: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/career/autonomy/applications/${encodeURIComponent(applicationId)}/validate-documents`,
      {},
    );
  }

  approveAndSubmit(confirmationId: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/career/autonomy/confirmations/${encodeURIComponent(confirmationId)}/approve-and-submit`,
      {},
    );
  }

  rejectConfirmation(confirmationId: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/career/confirmations/${encodeURIComponent(confirmationId)}/decide`,
      { decision: "rejected" },
    );
  }

  autonomyAudit(actor?: string): Promise<{ events: CareerEventDto[] }> {
    const query = actor === undefined ? "" : `&actor=${encodeURIComponent(actor)}`;
    return this.#request("GET", `/api/v1/career/autonomy/audit?limit=100${query}`);
  }

  // ── LinkedIn content ──────────────────────────────────────────────────────

  linkedInSettings(): Promise<LinkedInSettingsView> {
    return this.#request("GET", "/api/v1/linkedin/content/settings");
  }

  updateLinkedInSettings(patch: unknown): Promise<LinkedInSettingsView> {
    return this.#request("PUT", "/api/v1/linkedin/content/settings", patch);
  }

  acceptLinkedInRisk(version: number): Promise<LinkedInSettingsView> {
    return this.#request("POST", "/api/v1/linkedin/content/consent", { accepted: true, version });
  }

  revokeLinkedInRisk(): Promise<LinkedInSettingsView> {
    return this.#request("DELETE", "/api/v1/linkedin/content/consent");
  }

  linkedInPosts(): Promise<{ posts: LinkedInPostDto[] }> {
    return this.#request("GET", "/api/v1/linkedin/content/posts?limit=100");
  }

  createLinkedInPost(input: {
    text: string;
    scheduledAt?: string | null;
  }): Promise<LinkedInPostDto> {
    return this.#request("POST", "/api/v1/linkedin/content/posts", input);
  }

  generateLinkedInPost(topic?: string): Promise<LinkedInPostDto> {
    return this.#request(
      "POST",
      "/api/v1/linkedin/content/posts/generate",
      topic === undefined || topic.trim() === "" ? {} : { topic },
    );
  }

  updateLinkedInPost(
    id: string,
    patch: { text?: string; scheduledAt?: string | null },
  ): Promise<LinkedInPostDto> {
    return this.#request(
      "PATCH",
      `/api/v1/linkedin/content/posts/${encodeURIComponent(id)}`,
      patch,
    );
  }

  linkedInPostAction(
    id: string,
    action: "approve" | "reject" | "cancel" | "publish",
  ): Promise<LinkedInPostDto> {
    return this.#request(
      "POST",
      `/api/v1/linkedin/content/posts/${encodeURIComponent(id)}/${action}`,
      {},
    );
  }

  linkedInEngagements(): Promise<{ engagements: LinkedInEngagementDto[] }> {
    return this.#request("GET", "/api/v1/linkedin/content/engagements?limit=100");
  }

  proposeLinkedInEngagement(
    input:
      | { kind: "reaction"; target: string; reaction?: LinkedInReaction }
      | { kind: "comment"; target: string; text?: string },
  ): Promise<LinkedInEngagementDto> {
    return this.#request("POST", "/api/v1/linkedin/content/engagements", input);
  }

  discoverLinkedInEngagements(limit = 5): Promise<{
    created: LinkedInEngagementDto[];
    skipped: number;
    errors: string[];
  }> {
    return this.#request("POST", "/api/v1/linkedin/content/engagements/discover", { limit });
  }

  linkedInEngagementAction(
    id: string,
    action: "approve" | "reject" | "cancel" | "done",
  ): Promise<LinkedInEngagementDto> {
    return this.#request(
      "POST",
      `/api/v1/linkedin/content/engagements/${encodeURIComponent(id)}/${action}`,
      {},
    );
  }

  linkedInAudit(): Promise<{ events: LinkedInAuditDto[] }> {
    return this.#request("GET", "/api/v1/linkedin/content/audit?limit=100");
  }

  async #request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const response = await this.#session.authorizedRequest({
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Lab1RequestError(response.status, messageOf(response.body, response.status));
    }
    const payload = response.body as { data?: T } | null;
    return (payload?.data ?? payload) as T;
  }
}

function messageOf(body: unknown, status: number): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error !== undefined && typeof error.message === "string") return error.message;
  }
  return `Request failed (HTTP ${String(status)}).`;
}
