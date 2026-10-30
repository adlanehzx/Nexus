import { useState } from "react";
import type {
  Opportunity,
  OpportunityTrack,
  SavedSearch,
  MonitoredSource,
} from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";

interface OpportunityInboxProps {
  opportunities: Opportunity[];
  savedSearches: SavedSearch[];
  monitoredSources: MonitoredSource[];
  selectedForComparison: string[];
  onToggleComparison: (id: string) => void;
  onToggleShortlist: (id: string, shortlisted: boolean) => Promise<void>;
  onPrepareDraftApplication: (oppId: string) => Promise<void>;
  onPrepareDraftEmail: (oppId: string) => Promise<void>;
  onSelectSavedSearch: (search: SavedSearch) => void;
  onRefreshSource: (sourceId: string) => Promise<void>;
  loading?: boolean;
}

export function OpportunityInbox({
  opportunities,
  savedSearches,
  monitoredSources,
  selectedForComparison,
  onToggleComparison,
  onToggleShortlist,
  onPrepareDraftApplication,
  onPrepareDraftEmail,
  onSelectSavedSearch,
  onRefreshSource,
  loading = false,
}: OpportunityInboxProps) {
  const { tr } = useI18n();
  const [activeTrack, setActiveTrack] = useState<OpportunityTrack | "all">("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [onlyFresh, setOnlyFresh] = useState(false);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [expandedCitationId, setExpandedCitationId] = useState<string | null>(null);
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Filter opportunities
  const filtered = opportunities.filter((opp) => {
    if (activeTrack !== "all" && opp.track !== activeTrack) return false;
    if (onlyFresh && opp.staleness !== "fresh") return false;
    if (!includeDuplicates && opp.duplicate.isDuplicate) return false;
    if (searchTerm.trim().length > 0) {
      const termLower = searchTerm.toLowerCase();
      const inTitle = opp.title.toLowerCase().includes(termLower);
      const inOrg = opp.organization.toLowerCase().includes(termLower);
      const inDesc = opp.description.toLowerCase().includes(termLower);
      const inSkills = opp.match.strengths.some((s) => s.toLowerCase().includes(termLower));
      if (!inTitle && !inOrg && !inDesc && !inSkills) return false;
    }
    return true;
  });

  const handleAction = async (task: () => Promise<void>, successMessage: string) => {
    setActionNotice(null);
    try {
      await task();
      setActionNotice(successMessage);
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : tr("Action failed.", "Échec de l'action."),
      );
    }
  };

  const formatDuplicateReason = (reason: string) => {
    if (reason === "canonical_url") return tr("Canonical URL match", "URL canonique identique");
    if (reason === "content_hash")
      return tr("Content hash match", "Empreinte de contenu identique");
    if (reason === "exact_title_match")
      return tr("Exact title match", "Titre exactement identique");
    return reason;
  };

  const formatTrack = (track: string) => {
    if (track === "phd") return tr("PhD", "Doctorat");
    if (track === "cdi") return tr("CDI", "CDI");
    if (track === "freelance") return tr("Freelance", "Freelance");
    return track;
  };

  const formatStaleness = (staleness: string) => {
    if (staleness === "fresh") return tr("Fresh", "Récent");
    if (staleness === "stale") return tr("Stale", "Obsolète");
    if (staleness === "archived") return tr("Archived", "Archivé");
    return staleness;
  };

  const formatRemotePolicy = (policy: string) => {
    if (policy === "remote") return tr("Remote", "Télétravail");
    if (policy === "hybrid") return tr("Hybrid", "Hybride");
    if (policy === "onsite") return tr("On-site", "Sur site");
    return policy;
  };

  const formatSeniority = (seniority: string) => {
    if (seniority === "junior") return tr("Junior", "Junior");
    if (seniority === "mid") return tr("Mid-level", "Confirmé");
    if (seniority === "senior") return tr("Senior", "Senior");
    if (seniority === "lead" || seniority === "staff") return tr("Lead / Staff", "Lead / Staff");
    return seniority.toUpperCase();
  };

  const formatFunding = (funding: string) => {
    if (funding === "full") return tr("Full Funding", "Financement complet");
    if (funding === "partial") return tr("Partial Funding", "Financement partiel");
    if (funding === "cifre") return tr("CIFRE Industrial", "Contrat CIFRE");
    return funding;
  };

  return (
    <div className="career-tab-content" role="region" aria-label="Opportunity Inbox">
      {/* Monitored Sources Health Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          overflowX: "auto",
          padding: "0.5rem 0",
        }}
      >
        <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--muted-text)" }}>
          {tr("MONITORED FEEDS:", "FLUX SURVEILLÉS :")}
        </span>
        {monitoredSources.map((source) => (
          <div
            key={source.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.25rem 0.6rem",
              background: "var(--surface-2)",
              border: `1px solid ${source.status === "active" ? "var(--border)" : "var(--down)"}`,
              borderRadius: "4px",
              fontSize: "0.75rem",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: source.status === "active" ? "var(--ok)" : "var(--down)",
              }}
              aria-hidden="true"
            />
            <span>{source.name}</span>
            {source.status === "degraded" && (
              <span style={{ color: "var(--down)", fontWeight: 700 }}>
                [{tr("Degraded / 429", "Dégradé / 429")}]
              </span>
            )}
            <button
              type="button"
              className="button compact"
              style={{ padding: "0.1rem 0.35rem", fontSize: "0.68rem" }}
              title={tr("Refresh Source", "Actualiser la source")}
              onClick={() =>
                void handleAction(
                  () => onRefreshSource(source.id),
                  tr(
                    `Source "${source.name}" refresh requested.`,
                    `Actualisation de la source "${source.name}" demandée.`,
                  ),
                )
              }
            >
              ↻
            </button>
          </div>
        ))}
      </div>

      {/* Track Tabs & Search Filter Bar */}
      <div className="career-card" style={{ gap: "0.85rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "0.75rem",
          }}
        >
          {/* Track Filter Buttons */}
          <div
            style={{ display: "flex", gap: "0.5rem" }}
            role="group"
            aria-label={tr("Filter by track", "Filtrer par filière")}
          >
            <button
              type="button"
              className={`career-tab-btn ${activeTrack === "all" ? "active" : ""}`}
              aria-pressed={activeTrack === "all"}
              onClick={() => setActiveTrack("all")}
            >
              {tr("All Tracks", "Toutes les filières")} ({opportunities.length})
            </button>
            <button
              type="button"
              className={`career-tab-btn ${activeTrack === "phd" ? "active" : ""}`}
              aria-pressed={activeTrack === "phd"}
              onClick={() => setActiveTrack("phd")}
            >
              {tr("PhD Positions", "Thèses & Doctorats")} (
              {opportunities.filter((o) => o.track === "phd").length})
            </button>
            <button
              type="button"
              className={`career-tab-btn ${activeTrack === "cdi" ? "active" : ""}`}
              aria-pressed={activeTrack === "cdi"}
              onClick={() => setActiveTrack("cdi")}
            >
              {tr("Permanent Employment", "Postes CDI")} (
              {opportunities.filter((o) => o.track === "cdi").length})
            </button>
            <button
              type="button"
              className={`career-tab-btn ${activeTrack === "freelance" ? "active" : ""}`}
              aria-pressed={activeTrack === "freelance"}
              onClick={() => setActiveTrack("freelance")}
            >
              {tr("Independent Work", "Missions Freelance")} (
              {opportunities.filter((o) => o.track === "freelance").length})
            </button>
          </div>

          {/* Quick Filters */}
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", fontSize: "0.82rem" }}>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={onlyFresh}
                onChange={(e) => setOnlyFresh(e.target.checked)}
              />
              {tr("Only Fresh", "Uniquement récents")}
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={includeDuplicates}
                onChange={(e) => setIncludeDuplicates(e.target.checked)}
              />
              {tr("Include Duplicates", "Inclure les doublons")}
            </label>
          </div>
        </div>

        {/* Search Input & Saved Searches */}
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <input
            type="search"
            className="career-input"
            style={{ flex: 1 }}
            placeholder={tr(
              "Search roles, skills, disciplines, organizations, or institutions...",
              "Rechercher rôles, compétences, disciplines, entreprises ou labos...",
            )}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label={tr("Search opportunities", "Rechercher des opportunités")}
          />
        </div>

        {savedSearches.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
              {tr("Saved Searches:", "Recherches enregistrées :")}
            </span>
            {savedSearches.map((ss) => (
              <button
                key={ss.id}
                type="button"
                className="button compact"
                onClick={() => {
                  onSelectSavedSearch(ss);
                  if (ss.query.term) setSearchTerm(ss.query.term);
                  if (ss.track) setActiveTrack(ss.track);
                }}
              >
                🔍 {ss.name} {ss.newMatchesCount > 0 && `(+${ss.newMatchesCount})`}
              </button>
            ))}
          </div>
        )}
      </div>

      {actionNotice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "0.65rem 1rem",
            borderRadius: "var(--radius)",
            background: "var(--nx-ok-bg)",
            color: "var(--ok)",
            fontSize: "0.85rem",
          }}
        >
          {actionNotice}
        </div>
      )}

      {/* Selected for Comparison Floating Bar */}
      {selectedForComparison.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.75rem 1.25rem",
            background: "var(--surface-3)",
            border: "1px solid var(--accent)",
            borderRadius: "var(--radius)",
          }}
        >
          <span>
            <strong>
              {selectedForComparison.length} {tr("opportunities", "opportunités")}
            </strong>{" "}
            {tr(
              "selected for side-by-side comparison.",
              "sélectionnées pour comparaison côte-à-côte.",
            )}
          </span>
          <span style={{ color: "var(--muted-text)", fontSize: "0.82rem" }}>
            {tr(
              "Switch to the Comparison Matrix tab to inspect tradeoffs.",
              "Basculez sur l'onglet Matrice de comparaison pour inspecter les compromis.",
            )}
          </span>
        </div>
      )}

      {/* Opportunities List */}
      {loading ? (
        <div className="career-card" style={{ textAlign: "center", padding: "2rem" }}>
          {tr(
            "Scanning feeds and evaluating explainable match models...",
            "Analyse des flux et évaluation des modèles d'adéquation explicables...",
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
          <strong>
            {tr(
              "No opportunities match your current filters",
              "Aucune opportunité ne correspond à vos filtres actuels",
            )}
          </strong>
          <p style={{ color: "var(--muted-text)", marginTop: "0.5rem" }}>
            {tr(
              "Try clearing the search term, adjusting track filters, or updating your skills in the Profile Wizard.",
              "Essayez d'effacer la recherche, d'ajuster les filtres de filière ou de mettre à jour vos compétences dans l'Assistant Profil.",
            )}
          </p>
        </div>
      ) : (
        <div className="career-grid-2">
          {filtered.map((opp) => {
            const isShortlisted =
              opp.workflowStatus === "shortlisted" || opp.workflowStatus === "applied";
            const isCompared = selectedForComparison.includes(opp.id);

            return (
              <article
                key={opp.id}
                className={`career-card ${isShortlisted ? "highlighted" : ""}`}
                aria-labelledby={`opp-title-${opp.id}`}
              >
                {/* Duplicate Alert */}
                {opp.duplicate.isDuplicate && (
                  <div className="duplicate-alert-banner" role="alert">
                    <span aria-hidden="true">⚠️</span>
                    <span>
                      {tr(
                        `Duplicate marker detected (reason: ${opp.duplicate.reason}). Original post exists in inbox.`,
                        `Doublon détecté (raison : ${formatDuplicateReason(opp.duplicate.reason)}). L'annonce originale est dans la boîte de réception.`,
                      )}
                    </span>
                  </div>
                )}

                {/* Card Header */}
                <div className="career-card-header">
                  <div
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <span className={`career-track-pill ${opp.track}`}>
                      {formatTrack(opp.track)}
                    </span>
                    <span className={`staleness-pill ${opp.staleness}`}>
                      {formatStaleness(opp.staleness)}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                      via {opp.sourceFeedName}
                    </span>
                  </div>

                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.3rem",
                      fontSize: "0.75rem",
                      color: "var(--muted-text)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isCompared}
                      onChange={() => onToggleComparison(opp.id)}
                      aria-label={`${tr("Select", "Sélectionner")} ${opp.title} ${tr("for comparison", "pour comparaison")}`}
                    />
                    {tr("Compare", "Comparer")}
                  </label>
                </div>

                {/* Title & Organization */}
                <div>
                  <h3
                    id={`opp-title-${opp.id}`}
                    style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}
                  >
                    {opp.title}
                  </h3>
                  <div style={{ fontSize: "0.85rem", color: "var(--muted-text)" }}>
                    <strong>{opp.organization}</strong>
                    {opp.departmentOrLab && ` · ${opp.departmentOrLab}`} · {opp.location} (
                    {formatRemotePolicy(opp.remotePolicy)})
                  </div>
                </div>

                {/* Track Specific Highlight Details */}
                <div
                  style={{
                    fontSize: "0.85rem",
                    background: "var(--surface-2)",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "4px",
                  }}
                >
                  {opp.track === "phd" && opp.phdDetails && (
                    <div>
                      <strong>{tr("Grant / Funding:", "Financement / Bourse :")}</strong>{" "}
                      {formatFunding(opp.phdDetails.fundingType)} · €{opp.phdDetails.monthlyStipend}
                      /{tr("mo", "mois")}
                      <br />
                      <strong>{tr("Advisors:", "Directeurs :")}</strong>{" "}
                      {opp.phdDetails.supervisors.join(", ")}
                    </div>
                  )}
                  {opp.track === "cdi" && opp.cdiDetails && (
                    <div>
                      <strong>{tr("Compensation:", "Rémunération :")}</strong> €
                      {opp.cdiDetails.salaryMin?.toLocaleString()} - €
                      {opp.cdiDetails.salaryMax?.toLocaleString()} / {tr("year CDI", "an CDI")}
                      <br />
                      <strong>{tr("Seniority:", "Séniorité :")}</strong>{" "}
                      {formatSeniority(opp.cdiDetails.seniority)} · {tr("Benefits:", "Avantages :")}{" "}
                      {opp.cdiDetails.benefits.join(", ")}
                    </div>
                  )}
                  {opp.track === "freelance" && opp.freelanceDetails && (
                    <div>
                      <strong>{tr("Daily Rate:", "TJM :")}</strong> €
                      {opp.freelanceDetails.dailyRateMin} - €{opp.freelanceDetails.dailyRateMax}/
                      {tr("day", "jour")} {tr("TJM", "TJM")}
                      <br />
                      <strong>{tr("Workload:", "Charge :")}</strong>{" "}
                      {opp.freelanceDetails.daysPerWeek} {tr("days/week", "jours/semaine")} ·{" "}
                      {tr("Duration:", "Durée :")} {opp.freelanceDetails.durationMonths}{" "}
                      {tr("months", "mois")}
                    </div>
                  )}
                </div>

                <p
                  style={{ margin: 0, fontSize: "0.85rem", color: "var(--text)", lineHeight: 1.4 }}
                >
                  {opp.description}
                </p>

                {/* Explainable Match Box */}
                <div className="match-explain-box">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span className="match-score-badge high">
                      ★ {opp.match.score}% {tr("Match Score", "Score de compatibilité")}
                    </span>
                    <button
                      type="button"
                      className="button compact"
                      style={{ fontSize: "0.72rem" }}
                      aria-expanded={expandedMatchId === opp.id}
                      onClick={() => setExpandedMatchId(expandedMatchId === opp.id ? null : opp.id)}
                    >
                      {expandedMatchId === opp.id
                        ? tr("Hide Rationale", "Masquer l'analyse")
                        : tr("Why it matches", "Pourquoi ce match")}
                    </button>
                  </div>

                  <div style={{ fontSize: "0.78rem", color: "var(--muted-text)" }}>
                    {opp.match.rationale}
                  </div>

                  {expandedMatchId === opp.id && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.5rem",
                        marginTop: "0.5rem",
                      }}
                    >
                      <div className="match-breakdown-bars">
                        <div className="match-sub-bar">
                          <span>
                            {tr("Skills", "Compétences")} ({opp.match.breakdown.skills}%)
                          </span>
                          <div className="match-bar-track">
                            <div
                              className="match-bar-fill"
                              style={{ width: `${opp.match.breakdown.skills}%` }}
                            />
                          </div>
                        </div>
                        <div className="match-sub-bar">
                          <span>
                            {tr("Rates", "Rémunération")} ({opp.match.breakdown.compensation}%)
                          </span>
                          <div className="match-bar-track">
                            <div
                              className="match-bar-fill"
                              style={{ width: `${opp.match.breakdown.compensation}%` }}
                            />
                          </div>
                        </div>
                        <div className="match-sub-bar">
                          <span>
                            {tr("Location", "Localisation")} ({opp.match.breakdown.location}%)
                          </span>
                          <div className="match-bar-track">
                            <div
                              className="match-bar-fill"
                              style={{ width: `${opp.match.breakdown.location}%` }}
                            />
                          </div>
                        </div>
                        <div className="match-sub-bar">
                          <span>
                            {tr("Track", "Filière")} ({opp.match.breakdown.trackFit}%)
                          </span>
                          <div className="match-bar-track">
                            <div
                              className="match-bar-fill"
                              style={{ width: `${opp.match.breakdown.trackFit}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      {opp.match.strengths.length > 0 && (
                        <div style={{ color: "var(--ok)", fontSize: "0.75rem" }}>
                          <strong>{tr("Strengths:", "Forces :")}</strong>{" "}
                          {opp.match.strengths.join(" · ")}
                        </div>
                      )}
                      {opp.match.gaps.length > 0 && (
                        <div style={{ color: "var(--gradient)", fontSize: "0.75rem" }}>
                          <strong>{tr("Gaps:", "Écarts :")}</strong> {opp.match.gaps.join(" · ")}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Citations Expander */}
                {opp.citations.length > 0 && (
                  <div className="citations-expandable">
                    <button
                      type="button"
                      className="button compact"
                      style={{ fontSize: "0.75rem" }}
                      aria-expanded={expandedCitationId === opp.id}
                      onClick={() =>
                        setExpandedCitationId(expandedCitationId === opp.id ? null : opp.id)
                      }
                    >
                      {expandedCitationId === opp.id
                        ? tr("Hide Citations", "Masquer les citations")
                        : `${tr("Verified Citations", "Citations vérifiées")} (${opp.citations.length})`}
                    </button>

                    {expandedCitationId === opp.id && (
                      <div style={{ marginTop: "0.5rem" }}>
                        {opp.citations.map((cite) => (
                          <div key={cite.id} className="citation-item">
                            <div className="citation-quote">"{cite.quote}"</div>
                            <div className="citation-meta">
                              <span>
                                {tr("Source:", "Source :")} {cite.title}
                              </span>
                              <span title={`SHA-256: ${cite.documentSha256}`}>
                                SHA: {cite.documentSha256.slice(0, 10)}...
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Actions Bar */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: "auto",
                    paddingTop: "0.75rem",
                    borderTop: "1px solid var(--border)",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className={`button ${isShortlisted ? "primary" : ""}`}
                    onClick={() =>
                      void handleAction(
                        () => onToggleShortlist(opp.id, !isShortlisted),
                        isShortlisted
                          ? tr("Removed from shortlist.", "Retiré de la présélection.")
                          : tr(
                              "Added to shortlist & application pipeline.",
                              "Ajouté à la présélection et au pipeline.",
                            ),
                      )
                    }
                  >
                    {isShortlisted
                      ? tr("★ Shortlisted", "★ Présélectionné")
                      : tr("☆ Shortlist", "☆ Présélectionner")}
                  </button>

                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        void handleAction(
                          () => onPrepareDraftApplication(opp.id),
                          tr(
                            "Form draft created. Action paused at Confirmation Card.",
                            "Brouillon créé. Action suspendue à la carte de confirmation.",
                          ),
                        )
                      }
                      title={tr(
                        "Generates a draft form submission that requires human confirmation",
                        "Génère un brouillon de formulaire exigeant confirmation humaine",
                      )}
                    >
                      {tr("Draft Application", "Préparer candidature")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        void handleAction(
                          () => onPrepareDraftEmail(opp.id),
                          tr(
                            "Email draft created. Action paused at Confirmation Card.",
                            "Brouillon d'e-mail créé. Action suspendue à la carte de confirmation.",
                          ),
                        )
                      }
                      title={tr(
                        "Generates an outreach email draft in Gmail requiring confirmation",
                        "Génère un brouillon d'e-mail dans Gmail exigeant confirmation",
                      )}
                    >
                      {tr("Draft Outreach", "Préparer message")}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
