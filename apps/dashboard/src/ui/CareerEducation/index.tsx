import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/index.js";
import type {
  Application,
  CareerAnalytics,
  CareerEducationClient,
  CareerEducationProfile,
  CareerEducationSettings,
  ConfirmationRequest,
  Contact,
  CreateDeadlineInput,
  Deadline,
  DocumentVariant,
  GenerateDocumentInput,
  Interview,
  MonitoredSource,
  Opportunity,
  OpportunityComparisonMatrix,
  RecordOutcomeInput,
  SavedSearch,
} from "@nexus/client-core";

import { ProfileWizard } from "./ProfileWizard.js";
import { OpportunityInbox } from "./OpportunityInbox.js";
import { ShortlistComparison } from "./ShortlistComparison.js";
import { ApplicationKanban } from "./ApplicationKanban.js";
import { DocumentVariants } from "./DocumentVariants.js";
import { DeadlinesCalendar } from "./DeadlinesCalendar.js";
import { ContactsOutcomesAnalytics } from "./ContactsOutcomesAnalytics.js";
import { ApprovalCards } from "./ApprovalCards.js";
import { CareerSettings } from "./CareerSettings.js";

export type CareerEducationTabId =
  | "inbox"
  | "comparison"
  | "pipeline"
  | "documents"
  | "deadlines"
  | "analytics"
  | "approvals"
  | "profile"
  | "settings";

interface CareerEducationProps {
  client: CareerEducationClient;
  initialTab?: CareerEducationTabId;
}

export function CareerEducation({ client, initialTab = "inbox" }: CareerEducationProps) {
  const { locale } = useI18n();
  const [activeTab, setActiveTab] = useState<CareerEducationTabId>(initialTab);
  const [loading, setLoading] = useState(true);
  const [offlineError, setOfflineError] = useState<string | null>(null);

  // Data states
  const [profile, setProfile] = useState<CareerEducationProfile | null>(null);
  const [settings, setSettings] = useState<CareerEducationSettings | null>(null);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [monitoredSources, setMonitoredSources] = useState<MonitoredSource[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [documents, setDocuments] = useState<DocumentVariant[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [analytics, setAnalytics] = useState<CareerAnalytics | null>(null);
  const [confirmations, setConfirmations] = useState<ConfirmationRequest[]>([]);

  // Selection states
  const [selectedForComparison, setSelectedForComparison] = useState<string[]>([]);
  const [comparisonMatrix, setComparisonMatrix] = useState<OpportunityComparisonMatrix | null>(
    null,
  );

  const reloadAll = useCallback(async () => {
    setLoading(true);
    setOfflineError(null);
    try {
      const [p, s, oppRes, ss, ms, apps, docs, dls, cnts, ints, anl, confs] = await Promise.all([
        client.getProfile(),
        client.getSettings(),
        client.searchOpportunities({ track: "all", includeDuplicates: true }),
        client.getSavedSearches(),
        client.getMonitoredSources(),
        client.getApplications(),
        client.getDocuments(),
        client.getDeadlines(),
        client.getContacts(),
        client.getInterviews(),
        client.getAnalytics(),
        client.getConfirmations(),
      ]);

      setProfile(p);
      setSettings(s);
      setOpportunities(oppRes.items);
      setSavedSearches(ss);
      setMonitoredSources(ms);
      setApplications(apps);
      setDocuments(docs);
      setDeadlines(dls);
      setContacts(cnts);
      setInterviews(ints);
      setAnalytics(anl);
      setConfirmations(confs);

      // Pre-select 2 opportunities for comparison if empty
      if (selectedForComparison.length >= 2) {
        const matrix = await client.compareOpportunities(selectedForComparison);
        setComparisonMatrix(matrix);
      } else if (oppRes.items.length >= 2) {
        const defaultPair = [oppRes.items[0]!.id, oppRes.items[1]!.id];
        setSelectedForComparison(defaultPair);
        const matrix = await client.compareOpportunities(defaultPair);
        setComparisonMatrix(matrix);
      }
    } catch (err) {
      setOfflineError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }, [client, selectedForComparison]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  // Handle comparison toggles
  const handleToggleComparison = async (oppId: string) => {
    const next = selectedForComparison.includes(oppId)
      ? selectedForComparison.filter((id) => id !== oppId)
      : [...selectedForComparison, oppId];

    setSelectedForComparison(next);

    if (next.length >= 2) {
      try {
        const matrix = await client.compareOpportunities(next);
        setComparisonMatrix(matrix);
      } catch {
        setComparisonMatrix(null);
      }
    } else {
      setComparisonMatrix(null);
    }
  };

  // Handle shortlist toggle
  const handleToggleShortlist = async (id: string, shortlisted: boolean) => {
    await client.toggleShortlist(id, shortlisted);
    await reloadAll();
  };

  // Safe research plane draft preparation
  const handlePrepareDraftApplication = async (oppId: string) => {
    await client.prepareDraftApplication(oppId, {
      applicantName: profile?.fullName ?? "Applicant",
      applicantEmail: profile?.email ?? "applicant@nexus.local",
    });
    await reloadAll();
    setActiveTab("approvals");
  };

  const handlePrepareDraftEmail = async (oppId: string) => {
    const opp = opportunities.find((o) => o.id === oppId);
    await client.prepareDraftEmail(
      oppId,
      "recruiter@example.com",
      `Application Inquiry: ${opp?.title ?? "Position"}`,
      `Dear Hiring Team, I am expressing interest in ${opp?.title ?? "this position"}.`,
    );
    await reloadAll();
    setActiveTab("approvals");
  };

  const handlePrepareCalendarSync = async (d: Deadline) => {
    await client.prepareDraftCalendarEvent(
      d.opportunityId,
      d.title,
      d.dueDate,
      new Date(new Date(d.dueDate).getTime() + 3600000).toISOString(),
    );
    await reloadAll();
    setActiveTab("approvals");
  };

  const pendingApprovalsCount = confirmations.filter((c) => c.status === "pending").length;

  return (
    <div className="career-edu-container" role="main" aria-label="NEXUS Career & Education Area">
      {/* Offline / Degraded Notice Banner */}
      {offlineError && (
        <div className="career-offline-banner" role="alert">
          <div>
            <strong>
              {locale === "fr"
                ? "⚠️ Flux inaccessibles / Hors ligne :"
                : "⚠️ Feeds Unreachable / Offline:"}
            </strong>{" "}
            {offlineError}
          </div>
          <button type="button" className="button compact danger" onClick={() => void reloadAll()}>
            {locale === "fr" ? "Réessayer la connexion" : "Retry Connection"}
          </button>
        </div>
      )}

      {/* Main Tabs Navigation */}
      <nav className="career-tabs-bar" role="tablist" aria-label="Career & Education section views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "inbox"}
          className="career-tab-btn"
          onClick={() => setActiveTab("inbox")}
        >
          <span>📥</span> {locale === "fr" ? "Découverte & Flux" : "Discovery & Inbox"}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "comparison"}
          className="career-tab-btn"
          onClick={() => setActiveTab("comparison")}
        >
          <span>⚖️</span> {locale === "fr" ? "Matrice de comparaison" : "Comparison Matrix"}
          {selectedForComparison.length > 0 && (
            <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
              ({selectedForComparison.length})
            </span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "pipeline"}
          className="career-tab-btn"
          onClick={() => setActiveTab("pipeline")}
        >
          <span>📊</span> {locale === "fr" ? "Kanban Candidatures" : "Application Kanban"} (
          {applications.length})
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "documents"}
          className="career-tab-btn"
          onClick={() => setActiveTab("documents")}
        >
          <span>📄</span> {locale === "fr" ? "Documents sur mesure" : "Tailored Documents"} (
          {documents.length})
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "deadlines"}
          className="career-tab-btn"
          onClick={() => setActiveTab("deadlines")}
        >
          <span>📅</span> {locale === "fr" ? "Échéances & Planning" : "Deadlines & Schedule"} (
          {deadlines.filter((d) => !d.completed).length})
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "analytics"}
          className="career-tab-btn"
          onClick={() => setActiveTab("analytics")}
        >
          <span>📈</span> {locale === "fr" ? "Contacts & Statistiques" : "Contacts & Analytics"}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "approvals"}
          className="career-tab-btn"
          onClick={() => setActiveTab("approvals")}
        >
          <span>🛡️</span> {locale === "fr" ? "Approbations & Sécurité" : "Approvals & Safety"}
          {pendingApprovalsCount > 0 && (
            <span className="badge-counter">{pendingApprovalsCount}</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "profile"}
          className="career-tab-btn"
          onClick={() => setActiveTab("profile")}
        >
          <span>🎯</span> {locale === "fr" ? "Objectifs & Profil" : "Goals & Profile Wizard"}
          {profile && (
            <span style={{ fontSize: "0.72rem", color: "var(--ok)", fontWeight: 700 }}>
              {profile.completeness.score}%
            </span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "settings"}
          className="career-tab-btn"
          onClick={() => setActiveTab("settings")}
        >
          <span>⚙️</span> {locale === "fr" ? "Paramètres & Sources" : "Settings & Feeds"}
        </button>
      </nav>

      {/* View Panels */}
      <div role="tabpanel" aria-label={`View ${activeTab}`}>
        {activeTab === "inbox" && (
          <OpportunityInbox
            opportunities={opportunities}
            savedSearches={savedSearches}
            monitoredSources={monitoredSources}
            selectedForComparison={selectedForComparison}
            onToggleComparison={(id) => void handleToggleComparison(id)}
            onToggleShortlist={handleToggleShortlist}
            onPrepareDraftApplication={handlePrepareDraftApplication}
            onPrepareDraftEmail={handlePrepareDraftEmail}
            onSelectSavedSearch={(ss) => {
              void client.searchOpportunities(ss.query).then((res) => setOpportunities(res.items));
            }}
            onRefreshSource={async (sourceId) => {
              await client.refreshSource(sourceId);
              await reloadAll();
            }}
            loading={loading}
          />
        )}

        {activeTab === "comparison" && (
          <ShortlistComparison
            matrix={comparisonMatrix}
            onClearComparison={() => {
              setSelectedForComparison([]);
              setComparisonMatrix(null);
            }}
            onSelectApplication={(oppId) => {
              void client.createApplication(oppId).then(() => {
                void reloadAll();
                setActiveTab("pipeline");
              });
            }}
          />
        )}

        {activeTab === "pipeline" && (
          <ApplicationKanban
            applications={applications}
            onUpdateStage={async (appId, stage, note) => {
              await client.updateApplicationStage(appId, stage, note);
              await reloadAll();
            }}
            onOpenDocuments={() => setActiveTab("documents")}
            onOpenApprovals={() => setActiveTab("approvals")}
          />
        )}

        {activeTab === "documents" && (
          <DocumentVariants
            documents={documents}
            opportunities={opportunities}
            onGenerateDocument={async (input: GenerateDocumentInput) => {
              const doc = await client.generateDocumentVariant(input);
              await reloadAll();
              return doc;
            }}
            onExportConfirmation={async (doc) => {
              await client.requestConfirmation({
                actionType: "document_export",
                title: `Export ${doc.title}`,
                summary: `Prepares external transmission or download of ${doc.type} for ${doc.targetOrganization}.`,
                destination: "External Document Export Dispatcher",
                payload: { documentId: doc.id, digestSha256: doc.digestSha256 },
                risks: ["Shares tailored document content externally."],
                consequences: ["Document is transmitted to external recipient."],
              });
              await reloadAll();
              setActiveTab("approvals");
            }}
            loading={loading}
          />
        )}

        {activeTab === "deadlines" && (
          <DeadlinesCalendar
            deadlines={deadlines}
            opportunities={opportunities}
            onCreateDeadline={async (input: CreateDeadlineInput) => {
              const res = await client.createDeadline(input);
              await reloadAll();
              return res;
            }}
            onToggleCompleted={async (id, completed) => {
              await client.toggleDeadlineCompleted(id, completed);
              await reloadAll();
            }}
            onSyncCalendar={handlePrepareCalendarSync}
            loading={loading}
          />
        )}

        {activeTab === "analytics" && analytics && (
          <ContactsOutcomesAnalytics
            contacts={contacts}
            interviews={interviews}
            analytics={analytics}
            opportunities={opportunities}
            onRecordOutcome={async (input: RecordOutcomeInput) => {
              await client.recordOutcome(input);
              await reloadAll();
            }}
            loading={loading}
          />
        )}

        {activeTab === "approvals" && (
          <ApprovalCards
            confirmations={confirmations}
            onResolveConfirmation={async (id, decision, reason) => {
              const res = await client.resolveConfirmation(id, decision, reason);
              await reloadAll();
              return res;
            }}
            loading={loading}
          />
        )}

        {activeTab === "profile" && profile && (
          <ProfileWizard
            profile={profile}
            onUpdate={async (updated) => {
              await client.updateProfile(updated);
              await reloadAll();
            }}
            loading={loading}
          />
        )}

        {activeTab === "settings" && settings && (
          <CareerSettings
            settings={settings}
            onUpdateSettings={async (updated) => {
              await client.updateSettings(updated);
              await reloadAll();
            }}
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}
