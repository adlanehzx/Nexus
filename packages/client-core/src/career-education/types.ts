/**
 * Typed client boundary and contracts for the NEXUS Career & Education capability.
 *
 * Designed for cross-platform clients (Dashboard, CLI, Desktop, Mobile) to interact
 * with the long-term career planning, PhD/CDI/freelance discovery, tailored application
 * preparation, and strictly confirmed external action workflows.
 */

export type OpportunityTrack = "phd" | "cdi" | "freelance";

export type LocationType = "remote" | "hybrid" | "onsite";

export type SeniorityLevel = "entry" | "mid" | "senior" | "staff" | "lead" | "principal";

export type Currency = "EUR" | "USD" | "GBP" | "CHF";

export type StalenessStatus = "fresh" | "aging" | "stale";

export type DuplicateReason = "canonical_url" | "content_hash" | "exact_title_match" | "none";

export type ApplicationStage =
  | "discovered"
  | "shortlisted"
  | "preparing"
  | "pending_approval"
  | "submitted"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn";

export type ConfirmationStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export type ConfirmationActionType =
  "browser_submit_application" | "gmail_send_draft" | "calendar_create_event" | "document_export";

export type FeedStatus = "active" | "degraded" | "rate_limited" | "offline";

export type FeedType = "rss" | "html_scraper" | "api";

export type OutcomeDecision = "accepted" | "declined" | "rejected" | "withdrawn";

export type DocumentType = "cv" | "cover_letter" | "research_statement" | "rate_card";

export type DeadlineCategory = "application_deadline" | "funding_call" | "interview" | "follow_up";

export type CalendarSyncStatus = "not_synced" | "drafted" | "confirmed";

// ============================================================================
// PROFILE & COMPLETENESS
// ============================================================================

export interface LanguageProficiency {
  language: string;
  proficiency: "native" | "fluent" | "intermediate" | "basic";
}

export interface EducationEntry {
  degree: string;
  institution: string;
  fieldOfStudy: string;
  graduationYear?: number | undefined;
  thesisTitle?: string | undefined;
  publications?: string[] | undefined;
}

export interface PhdPreferences {
  targetTopics: string[];
  preferredSupervisors: string[];
  targetInstitutionsOrLabs: string[];
  fundingModels: ("cifre" | "erc" | "anr" | "university" | "doctoral_school" | "industry")[];
  minMonthlyStipend?: number | undefined;
  currency: Currency;
  prerequisitesMet: string[];
}

export interface FreelancePreferences {
  targetDailyRateTjm: number;
  currency: Currency;
  availableDaysPerWeek: number;
  earliestStartDate: string;
  minDurationMonths: number;
  preferredIndustries: string[];
  vatRegistered: boolean;
}

export interface CdiPreferences {
  targetMinAnnualSalary: number;
  targetMaxAnnualSalary?: number | undefined;
  currency: Currency;
  desiredRoles: string[];
  seniority: SeniorityLevel[];
  noticePeriodMonths: number;
}

export interface CareerEducationProfile {
  id: string;
  updatedAt: string;
  fullName: string;
  email: string;
  headline: string;
  summary: string;
  preferredTracks: OpportunityTrack[];
  primaryDiscipline: string;
  skills: string[];
  targetLocations: string[];
  remotePreference: LocationType;
  languages: LanguageProficiency[];
  visaStatus: string;
  requiresVisaSponsorship: boolean;
  education: EducationEntry[];
  cdiPreferences: CdiPreferences;
  phdPreferences: PhdPreferences;
  freelancePreferences: FreelancePreferences;
  completeness: ProfileCompleteness;
}

export interface CompletenessBreakdownItem {
  id: string;
  label: string;
  completed: boolean;
  weight: number;
  hint: string;
}

export interface ProfileCompleteness {
  score: number; // 0 - 100%
  breakdown: CompletenessBreakdownItem[];
  missingCrucialFields: string[];
  actionableRecommendations: string[];
}

// ============================================================================
// SETTINGS
// ============================================================================

export interface QuietHoursSettings {
  enabled: boolean;
  start: string; // HH:MM
  end: string; // HH:MM
  timezone: string;
}

export interface CareerEducationSettings {
  preferredLocations: string[];
  remotePolicy: LocationType;
  disciplinesAndKeywords: string[];
  seniorityLevels: SeniorityLevel[];
  targetTracks: OpportunityTrack[];
  minAnnualSalaryCdi?: number | undefined;
  minDailyRateTjmFreelance?: number | undefined;
  minMonthlyStipendPhd?: number | undefined;
  currency: Currency;
  languages: string[];
  visaRequirement: string;
  phdTopics: string[];
  phdSupervisors: string[];
  phdFundingTypes: string[];
  freelanceAvailableStartDate?: string | undefined;
  freelanceDaysPerWeek: number;
  excludedSources: string[];
  excludedOrganizations: string[];
  quietHours: QuietHoursSettings;
  retentionDays: number;
  offlineSimulation: boolean;
  degradedFeedSimulation: boolean;
}

// ============================================================================
// OPPORTUNITY & SEARCH
// ============================================================================

export interface VerificationEvidence {
  exactQuote: boolean;
  claimTokenCoverage: number | null;
}

export interface OpportunityCitation {
  id: string;
  quote: string;
  url: string;
  title: string;
  documentSha256: string;
  verified: boolean;
  verification?: VerificationEvidence | undefined;
  claim?: string | undefined;
}

export interface DuplicateMarker {
  isDuplicate: boolean;
  originalOpportunityId?: string | undefined;
  reason: DuplicateReason;
}

export interface ExplainableMatch {
  score: number; // 0 - 100
  rationale: string;
  strengths: string[];
  gaps: string[];
  breakdown: {
    skills: number;
    compensation: number;
    location: number;
    trackFit: number;
  };
}

export interface PhdSpecifics {
  topic: string;
  supervisors: string[];
  lab: string;
  doctoralSchool: string;
  fundingType: string;
  monthlyStipend?: number | undefined;
  currency: Currency;
  durationYears: number;
  prerequisites: string[];
}

export interface CdiSpecifics {
  seniority: SeniorityLevel;
  salaryMin?: number | undefined;
  salaryMax?: number | undefined;
  currency: Currency;
  benefits: string[];
  trialPeriodMonths?: number | undefined;
  responsibilities: string[];
}

export interface FreelanceSpecifics {
  dailyRateMin?: number | undefined;
  dailyRateMax?: number | undefined;
  currency: Currency;
  estimatedDaysTotal?: number | undefined;
  daysPerWeek: number;
  durationMonths: number;
  startDate?: string | undefined;
  clientIndustry: string;
}

export interface Opportunity {
  id: string;
  track: OpportunityTrack;
  title: string;
  organization: string;
  departmentOrLab?: string | undefined;
  location: string;
  remotePolicy: LocationType;
  description: string;
  publishedAt: string;
  discoveredAt: string;
  sourceUrl: string;
  sourceFeedName: string;
  staleness: StalenessStatus;
  duplicate: DuplicateMarker;
  citations: OpportunityCitation[];
  match: ExplainableMatch;
  phdDetails?: PhdSpecifics | undefined;
  cdiDetails?: CdiSpecifics | undefined;
  freelanceDetails?: FreelanceSpecifics | undefined;
  workflowStatus: "inbox" | "shortlisted" | "applied" | "dismissed";
}

export interface OpportunitySearchQuery {
  term?: string | undefined;
  track?: OpportunityTrack | "all" | undefined;
  locationType?: LocationType | "all" | undefined;
  minScore?: number | undefined;
  onlyFresh?: boolean | undefined;
  includeDuplicates?: boolean | undefined;
}

export interface OpportunitySearchResult {
  items: Opportunity[];
  total: number;
  duplicateCount: number;
  stalenessBreakdown: Record<StalenessStatus, number>;
  trackBreakdown: Record<OpportunityTrack, number>;
}

// ============================================================================
// SAVED SEARCHES & MONITORED SOURCES
// ============================================================================

export interface SavedSearch {
  id: string;
  name: string;
  track: OpportunityTrack | "all";
  query: OpportunitySearchQuery;
  cadence: "hourly" | "daily" | "weekly";
  lastRunAt: string;
  newMatchesCount: number;
  active: boolean;
}

export interface MonitoredSource {
  id: string;
  name: string;
  feedUrl: string;
  feedType: FeedType;
  track: OpportunityTrack | "all";
  refreshIntervalHours: number;
  status: FeedStatus;
  lastFetchAt: string;
  lastError?: string | undefined;
  citationTrustLevel: "high" | "standard" | "unverified";
  itemsDiscoveredCount: number;
}

// ============================================================================
// SHORTLIST & COMPARISON
// ============================================================================

export interface ComparisonMetric {
  key: string;
  label: string;
  valuesByOpportunityId: Record<string, string | number | boolean | null>;
  winnerOpportunityId?: string | undefined;
}

export interface OpportunityComparisonMatrix {
  opportunityIds: string[];
  opportunities: Opportunity[];
  metrics: ComparisonMetric[];
  tradeoffsSummary: string[];
}

// ============================================================================
// APPLICATION KANBAN & TIMELINE
// ============================================================================

export interface StageHistoryEntry {
  stage: ApplicationStage;
  transitionedAt: string;
  note?: string | undefined;
}

export interface Application {
  id: string;
  opportunityId: string;
  opportunity: Opportunity;
  stage: ApplicationStage;
  stageHistory: StageHistoryEntry[];
  tailoredDocumentIds: string[];
  notes: string;
  nextDeadlineAt?: string | undefined;
  assignedContactIds: string[];
  updatedAt: string;
}

// ============================================================================
// TAILORED DOCUMENTS
// ============================================================================

export interface DocumentVariant {
  id: string;
  applicationId?: string | undefined;
  opportunityId: string;
  type: DocumentType;
  title: string;
  targetRole: string;
  targetOrganization: string;
  markdownContent: string;
  tailoredHighlights: string[];
  diffSummary: {
    sectionsTailored: string[];
    skillsEmphasized: string[];
    customClausesAdded: string[];
  };
  baseDocumentRef?: string | undefined;
  generatedAt: string;
  digestSha256: string;
}

// ============================================================================
// DEADLINES & CALENDAR
// ============================================================================

export interface Deadline {
  id: string;
  opportunityId: string;
  opportunityTitle: string;
  organization: string;
  title: string;
  dueDate: string;
  category: DeadlineCategory;
  priority: "low" | "medium" | "high" | "critical";
  completed: boolean;
  calendarSyncStatus: CalendarSyncStatus;
  externalCalendarEventId?: string | undefined;
}

// ============================================================================
// CONTACTS, INTERVIEWS, OUTCOMES & ANALYTICS
// ============================================================================

export interface Contact {
  id: string;
  opportunityId: string;
  name: string;
  role: string;
  organization: string;
  email: string;
  phone?: string | undefined;
  notes?: string | undefined;
}

export interface Interview {
  id: string;
  applicationId: string;
  round: number;
  title: string;
  scheduledAt: string;
  durationMinutes: number;
  interviewerNames: string[];
  format: "remote_video" | "onsite" | "phone";
  questionsPrepped: string[];
  notes?: string | undefined;
  feedback?: string | undefined;
}

export interface Outcome {
  id: string;
  applicationId: string;
  opportunityId: string;
  decision: OutcomeDecision;
  decidedAt: string;
  finalOfferDetails?:
    | {
        compensation?: string | undefined;
        startDate?: string | undefined;
        equityOrStipend?: string | undefined;
      }
    | undefined;
  feedbackReceived?: string | undefined;
  retrospectiveNotes: string;
}

export interface FunnelStageMetric {
  stage: ApplicationStage;
  count: number;
  conversionRateFromPrevious: number; // 0 - 100%
}

export interface CareerAnalytics {
  totalOpportunitiesDiscovered: number;
  totalShortlisted: number;
  totalApplicationsSubmitted: number;
  totalInterviewsConducted: number;
  totalOffersReceived: number;
  averageResponseTimeDays: number;
  funnel: FunnelStageMetric[];
  trackBreakdown: Record<OpportunityTrack, { count: number; successRate: number }>;
  salaryDistributionBenchmark: {
    minObserved: number;
    medianObserved: number;
    maxObserved: number;
    userTarget: number;
  };
}

// ============================================================================
// STRICT CONFIRMATION CARDS & HUMAN-IN-THE-LOOP
// ============================================================================

export interface ConfirmationAttachedDocument {
  documentId: string;
  title: string;
  type: string;
  digest: string;
}

export interface ConfirmationRequest {
  id: string;
  actionType: ConfirmationActionType;
  title: string;
  summary: string;
  destination: string;
  targetOpportunityId?: string | undefined;
  payload: Record<string, unknown>;
  attachedDocuments: ConfirmationAttachedDocument[];
  risks: string[];
  consequences: string[];
  requiresHumanApproval: true;
  status: ConfirmationStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string | undefined;
  resolvedBy?: string | undefined;
  decisionRationale?: string | undefined;
}

// ============================================================================
// AUDIT
// ============================================================================

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  targetResource: string;
  details: Record<string, unknown>;
  outcome: "success" | "denied" | "expired" | "cancelled" | "error";
  riskLevel: "low" | "medium" | "high" | "critical";
}

// ============================================================================
// SAFE RESEARCH PLANE & ADAPTER REQUESTS
// ============================================================================

export interface SafeSearchResponse {
  query: string;
  executedAt: string;
  results: Opportunity[];
  blockedPrivateDestinationsCount: number;
  rateLimitRemaining: number;
}

export interface CreateSavedSearchInput {
  name: string;
  track: OpportunityTrack | "all";
  query: OpportunitySearchQuery;
  cadence: "hourly" | "daily" | "weekly";
}

export interface CreateDeadlineInput {
  opportunityId: string;
  opportunityTitle: string;
  organization: string;
  title: string;
  dueDate: string;
  category: DeadlineCategory;
  priority: "low" | "medium" | "high" | "critical";
}

export interface GenerateDocumentInput {
  opportunityId: string;
  applicationId?: string | undefined;
  type: DocumentType;
  customInstructions?: string | undefined;
}

export interface RecordOutcomeInput {
  applicationId: string;
  opportunityId: string;
  decision: OutcomeDecision;
  finalOfferDetails?:
    | {
        compensation?: string | undefined;
        startDate?: string | undefined;
        equityOrStipend?: string | undefined;
      }
    | undefined;
  feedbackReceived?: string | undefined;
  retrospectiveNotes: string;
}

export interface CreateConfirmationInput {
  actionType: ConfirmationActionType;
  title: string;
  summary: string;
  destination: string;
  targetOpportunityId?: string | undefined;
  payload: Record<string, unknown>;
  attachedDocuments?: ConfirmationAttachedDocument[] | undefined;
  risks: string[];
  consequences: string[];
  ttlSeconds?: number | undefined;
}

// ============================================================================
// CLIENT CONTRACT INTERFACE
// ============================================================================

export interface CareerEducationClient {
  getProfile(): Promise<CareerEducationProfile>;
  updateProfile(profile: Partial<CareerEducationProfile>): Promise<CareerEducationProfile>;

  getSettings(): Promise<CareerEducationSettings>;
  updateSettings(settings: Partial<CareerEducationSettings>): Promise<CareerEducationSettings>;

  searchOpportunities(query: OpportunitySearchQuery): Promise<OpportunitySearchResult>;
  getOpportunity(id: string): Promise<Opportunity>;
  toggleShortlist(id: string, shortlisted: boolean): Promise<Opportunity>;
  compareOpportunities(ids: string[]): Promise<OpportunityComparisonMatrix>;

  getSavedSearches(): Promise<SavedSearch[]>;
  createSavedSearch(input: CreateSavedSearchInput): Promise<SavedSearch>;
  deleteSavedSearch(id: string): Promise<void>;

  getMonitoredSources(): Promise<MonitoredSource[]>;
  refreshSource(id: string): Promise<MonitoredSource>;

  getApplications(): Promise<Application[]>;
  updateApplicationStage(id: string, stage: ApplicationStage, note?: string): Promise<Application>;
  createApplication(opportunityId: string): Promise<Application>;

  getDocuments(applicationId?: string): Promise<DocumentVariant[]>;
  generateDocumentVariant(input: GenerateDocumentInput): Promise<DocumentVariant>;

  getDeadlines(): Promise<Deadline[]>;
  createDeadline(input: CreateDeadlineInput): Promise<Deadline>;
  toggleDeadlineCompleted(id: string, completed: boolean): Promise<Deadline>;

  getAnalytics(): Promise<CareerAnalytics>;
  getContacts(opportunityId?: string): Promise<Contact[]>;
  getInterviews(applicationId?: string): Promise<Interview[]>;
  recordOutcome(input: RecordOutcomeInput): Promise<Outcome>;

  getConfirmations(status?: ConfirmationStatus): Promise<ConfirmationRequest[]>;
  requestConfirmation(input: CreateConfirmationInput): Promise<ConfirmationRequest>;
  resolveConfirmation(
    id: string,
    decision: "approve" | "reject" | "cancel",
    reason?: string,
  ): Promise<ConfirmationRequest>;

  getAuditEvents(limit?: number): Promise<AuditEvent[]>;

  // Safe research plane operations
  executeSafeSearch(query: string, track?: OpportunityTrack | "all"): Promise<SafeSearchResponse>;
  prepareDraftApplication(
    opportunityId: string,
    formValues: Record<string, string>,
  ): Promise<ConfirmationRequest>;
  prepareDraftEmail(
    opportunityId: string,
    to: string,
    subject: string,
    body: string,
  ): Promise<ConfirmationRequest>;
  prepareDraftCalendarEvent(
    opportunityId: string,
    title: string,
    start: string,
    end: string,
  ): Promise<ConfirmationRequest>;
}
