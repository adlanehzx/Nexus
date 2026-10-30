import { useState } from "react";
import type {
  CareerAnalytics,
  Contact,
  Interview,
  Opportunity,
  OutcomeDecision,
  RecordOutcomeInput,
} from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";

interface ContactsOutcomesAnalyticsProps {
  contacts: Contact[];
  interviews: Interview[];
  analytics: CareerAnalytics;
  opportunities: Opportunity[];
  onRecordOutcome: (input: RecordOutcomeInput) => Promise<void>;
  loading?: boolean;
}

export function ContactsOutcomesAnalytics({
  contacts,
  interviews,
  analytics,
  opportunities,
  onRecordOutcome,
  loading = false,
}: ContactsOutcomesAnalyticsProps) {
  const { tr } = useI18n();
  const [showOutcomeModal, setShowOutcomeModal] = useState(false);
  const [targetOppId, setTargetOppId] = useState(opportunities[0]?.id ?? "");
  const [decision, setDecision] = useState<OutcomeDecision>("accepted");
  const [compensation, setCompensation] = useState("€115,000 / year + equity");
  const [feedback, setFeedback] = useState(
    "Strong consensus design knowledge and formal verification skills.",
  );
  const [retrospectiveNotes, setRetrospectiveNotes] = useState(
    "Negotiation succeeded; remote flexibility confirmed.",
  );
  const [notice, setNotice] = useState<string | null>(null);

  const handleOutcomeSubmit = async () => {
    if (!targetOppId) return;
    try {
      await onRecordOutcome({
        applicationId: `app_${targetOppId}`,
        opportunityId: targetOppId,
        decision,
        finalOfferDetails: { compensation },
        feedbackReceived: feedback,
        retrospectiveNotes,
      });
      setShowOutcomeModal(false);
      setNotice(
        tr(
          `Outcome recorded: ${decision.toUpperCase()}. Pipeline metrics updated.`,
          `Résultat consigné : ${decision.toUpperCase()}. Métriques du pipeline mises à jour.`,
        ),
      );
    } catch (err) {
      setNotice(
        err instanceof Error
          ? err.message
          : tr("Failed to record outcome.", "Échec de l'enregistrement du résultat."),
      );
    }
  };

  return (
    <div
      className="career-tab-content"
      role="region"
      aria-label="Contacts, Outcomes and Analytics"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
            {tr(
              "Contacts, Interviews, Outcomes & Analytics",
              "Contacts, Entretiens, Résultats & Statistiques",
            )}
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            {tr(
              "Network connections, interview question briefs, final decision retrospectives, and conversion funnels.",
              "Réseau professionnel, fiches de préparation aux entretiens, rétrospectives de décisions et entonnoirs de conversion.",
            )}
          </p>
        </div>

        <button type="button" className="button primary" onClick={() => setShowOutcomeModal(true)}>
          {tr("+ Record Final Outcome", "+ Enregistrer le résultat final")}
        </button>
      </div>

      {notice && (
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
          {notice}
        </div>
      )}

      {loading ? (
        <div className="career-card" style={{ textAlign: "center", padding: "2rem" }}>
          {tr(
            "Loading network contacts and interview analytics...",
            "Chargement des contacts et des analyses d'entretiens...",
          )}
        </div>
      ) : (
        <>
          {/* Analytics Overview Cards */}
          <div className="career-grid-3">
            <div className="career-card" style={{ gap: "0.35rem" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--muted-text)", fontWeight: 700 }}>
                {tr("DISCOVERED OPPORTUNITIES", "OPPORTUNITÉS DÉCOUVERTES")}
              </span>
              <span style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--text)" }}>
                {analytics.totalOpportunitiesDiscovered}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                {tr(
                  "Across Inria, European Tech, & Freelance Feeds",
                  "Sur les flux Inria, Tech Européenne & Freelance",
                )}
              </span>
            </div>

            <div className="career-card" style={{ gap: "0.35rem" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--muted-text)", fontWeight: 700 }}>
                {tr("APPLICATIONS SUBMITTED", "CANDIDATURES SOUMISES")}
              </span>
              <span style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--accent)" }}>
                {analytics.totalApplicationsSubmitted}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                {tr(
                  "100% Confirmed with Durable Human Approval",
                  "100% Confirmées avec approbation humaine",
                )}
              </span>
            </div>

            <div className="career-card" style={{ gap: "0.35rem" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--muted-text)", fontWeight: 700 }}>
                {tr("OFFERS RECEIVED", "OFFRES REÇUES")}
              </span>
              <span style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--ok)" }}>
                {analytics.totalOffersReceived}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--ok)" }}>
                {tr("Avg Response Time:", "Délai moyen de réponse :")}{" "}
                {analytics.averageResponseTimeDays} {tr("days", "jours")}
              </span>
            </div>
          </div>

          {/* Conversion Funnel Box */}
          <div className="career-card">
            <strong style={{ fontSize: "0.95rem" }}>
              {tr("Application Conversion Funnel", "Entonnoir de Conversion des Candidatures")}
            </strong>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${analytics.funnel.length}, 1fr)`,
                gap: "0.5rem",
                marginTop: "0.75rem",
              }}
            >
              {analytics.funnel.map((f) => (
                <div
                  key={f.stage}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    background: "var(--surface-2)",
                    padding: "0.75rem 0.5rem",
                    borderRadius: "var(--radius)",
                    textAlign: "center",
                  }}
                >
                  <span style={{ fontSize: "1.1rem", fontWeight: 800 }}>{f.count}</span>
                  <span
                    style={{
                      fontSize: "0.72rem",
                      color: "var(--muted-text)",
                      textTransform: "capitalize",
                    }}
                  >
                    {f.stage.replace("_", " ")}
                  </span>
                  <span style={{ fontSize: "0.68rem", color: "var(--ok)", marginTop: "0.25rem" }}>
                    {f.conversionRateFromPrevious}% {tr("rate", "taux")}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Contacts & Interviews Sections */}
          <div className="career-grid-2">
            {/* Contacts Directory */}
            <div className="career-card" style={{ gap: "0.75rem" }}>
              <strong style={{ fontSize: "0.95rem" }}>
                {tr("Key Contacts Directory", "Répertoire des contacts clés")} ({contacts.length})
              </strong>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {contacts.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.2rem",
                      padding: "0.5rem 0.75rem",
                      background: "var(--surface-2)",
                      borderRadius: "var(--radius)",
                      fontSize: "0.82rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <strong>{c.name}</strong>
                      <a
                        href={`mailto:${c.email}`}
                        style={{
                          color: "var(--bright-accent)",
                          fontSize: "0.75rem",
                          textDecoration: "none",
                        }}
                      >
                        {c.email}
                      </a>
                    </div>
                    <span style={{ color: "var(--muted-text)" }}>
                      {c.role} — <em>{c.organization}</em>
                    </span>
                    {c.notes && (
                      <span
                        style={{ fontSize: "0.75rem", color: "var(--text)", marginTop: "0.2rem" }}
                      >
                        📝 {c.notes}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Interviews & Prep Questions */}
            <div className="career-card" style={{ gap: "0.75rem" }}>
              <strong style={{ fontSize: "0.95rem" }}>
                {tr("Interview Rounds & Preparation", "Sessions d'entretien & Préparation")}
              </strong>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {interviews.map((int) => (
                  <div
                    key={int.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.4rem",
                      padding: "0.75rem",
                      background: "var(--surface-2)",
                      borderRadius: "var(--radius)",
                      fontSize: "0.82rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <strong>
                        {tr("Round", "Tour")} {int.round}: {int.title}
                      </strong>
                      <span style={{ color: "var(--gradient)", fontSize: "0.75rem" }}>
                        {new Date(int.scheduledAt).toLocaleDateString()} ({int.durationMinutes} min)
                      </span>
                    </div>
                    <div style={{ color: "var(--muted-text)" }}>
                      {tr("Interviewers:", "Interlocuteurs :")}{" "}
                      <strong>{int.interviewerNames.join(", ")}</strong> (
                      {int.format.replace("_", " ")})
                    </div>

                    <div style={{ marginTop: "0.25rem" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text)" }}>
                        {tr("Prepped Technical Questions:", "Questions techniques préparées :")}
                      </span>
                      <ul
                        style={{
                          margin: "0.2rem 0 0",
                          paddingLeft: "1.2rem",
                          fontSize: "0.75rem",
                          lineHeight: 1.4,
                        }}
                      >
                        {int.questionsPrepped.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Record Outcome Modal */}
      {showOutcomeModal && (
        <div
          className="career-modal-backdrop"
          onClick={() => setShowOutcomeModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rec-outcome-title"
        >
          <div className="career-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="career-modal-header">
              <h3 id="rec-outcome-title" className="career-modal-title">
                {tr(
                  "Record Final Application Outcome",
                  "Consigner le résultat final de la candidature",
                )}
              </h3>
              <button
                type="button"
                className="button compact"
                onClick={() => setShowOutcomeModal(false)}
                aria-label={tr("Close", "Fermer")}
              >
                ✕
              </button>
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeOpp">{tr("Target Opportunity", "Opportunité ciblée")}</label>
              <select
                id="outcomeOpp"
                className="career-select"
                value={targetOppId}
                onChange={(e) => setTargetOppId(e.target.value)}
              >
                {opportunities.map((o) => (
                  <option key={o.id} value={o.id}>
                    [{o.track.toUpperCase()}] {o.title} — {o.organization}
                  </option>
                ))}
              </select>
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeDec">{tr("Decision", "Décision")}</label>
              <select
                id="outcomeDec"
                className="career-select"
                value={decision}
                onChange={(e) => setDecision(e.target.value as OutcomeDecision)}
              >
                <option value="accepted">{tr("Offer Accepted", "Offre acceptée")}</option>
                <option value="declined">
                  {tr("Offer Declined (Applicant Choice)", "Offre déclinée (Choix du candidat)")}
                </option>
                <option value="rejected">
                  {tr("Rejected by Organization", "Refusé par l'organisation")}
                </option>
                <option value="withdrawn">
                  {tr("Candidacy Withdrawn", "Candidature retirée")}
                </option>
              </select>
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeComp">
                {tr("Final Compensation / Terms", "Rémunération finale / Modalités")}
              </label>
              <input
                id="outcomeComp"
                className="career-input"
                type="text"
                value={compensation}
                onChange={(e) => setCompensation(e.target.value)}
              />
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeFeedback">
                {tr("Feedback Received", "Commentaires reçus")}
              </label>
              <textarea
                id="outcomeFeedback"
                className="career-textarea"
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeRetro">
                {tr(
                  "Retrospective Notes for NEXUS Memory",
                  "Notes rétrospectives pour la mémoire NEXUS",
                )}
              </label>
              <textarea
                id="outcomeRetro"
                className="career-textarea"
                rows={2}
                value={retrospectiveNotes}
                onChange={(e) => setRetrospectiveNotes(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" className="button" onClick={() => setShowOutcomeModal(false)}>
                {tr("Cancel", "Annuler")}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void handleOutcomeSubmit()}
              >
                {tr("Save Outcome", "Enregistrer le résultat")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
