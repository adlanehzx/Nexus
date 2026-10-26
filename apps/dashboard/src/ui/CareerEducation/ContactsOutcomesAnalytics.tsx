import { useState } from "react";
import type {
  CareerAnalytics,
  Contact,
  Interview,
  Opportunity,
  OutcomeDecision,
  RecordOutcomeInput,
} from "@nexus/client-core";

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
      setNotice(`Outcome recorded: ${decision.toUpperCase()}. Pipeline metrics updated.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to record outcome.");
    }
  };

  return (
    <div
      className="career-edu-container"
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
            Contacts, Interviews, Outcomes & Analytics
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            Network connections, interview question briefs, final decision retrospectives, and
            conversion funnels.
          </p>
        </div>

        <button type="button" className="button primary" onClick={() => setShowOutcomeModal(true)}>
          + Record Final Outcome
        </button>
      </div>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "0.65rem 1rem",
            borderRadius: "var(--radius)",
            background: "rgb(95 211 154 / 12%)",
            color: "var(--ok)",
            fontSize: "0.85rem",
          }}
        >
          {notice}
        </div>
      )}

      {loading ? (
        <div className="career-card" style={{ textAlign: "center", padding: "2rem" }}>
          Loading network contacts and interview analytics...
        </div>
      ) : (
        <>
          {/* Analytics Overview Cards */}
          <div className="career-grid-3">
            <div className="career-card" style={{ gap: "0.35rem" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--muted-text)", fontWeight: 700 }}>
                DISCOVERED OPPORTUNITIES
              </span>
              <span style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--text)" }}>
                {analytics.totalOpportunitiesDiscovered}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                Across Inria, European Tech, & Freelance Feeds
              </span>
            </div>

            <div className="career-card" style={{ gap: "0.35rem" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--muted-text)", fontWeight: 700 }}>
                APPLICATIONS SUBMITTED
              </span>
              <span style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--accent)" }}>
                {analytics.totalApplicationsSubmitted}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                100% Confirmed with Durable Human Approval
              </span>
            </div>

            <div className="career-card" style={{ gap: "0.35rem" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--muted-text)", fontWeight: 700 }}>
                OFFERS RECEIVED
              </span>
              <span style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--ok)" }}>
                {analytics.totalOffersReceived}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--ok)" }}>
                Avg Response Time: {analytics.averageResponseTimeDays} days
              </span>
            </div>
          </div>

          {/* Conversion Funnel Box */}
          <div className="career-card">
            <strong style={{ fontSize: "0.95rem" }}>Application Conversion Funnel</strong>
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
                    {f.conversionRateFromPrevious}% rate
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
                Key Contacts Directory ({contacts.length})
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
              <strong style={{ fontSize: "0.95rem" }}>Interview Rounds & Preparation</strong>
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
                        Round {int.round}: {int.title}
                      </strong>
                      <span style={{ color: "var(--gradient)", fontSize: "0.75rem" }}>
                        {new Date(int.scheduledAt).toLocaleDateString()} ({int.durationMinutes} min)
                      </span>
                    </div>
                    <div style={{ color: "var(--muted-text)" }}>
                      Interviewers: <strong>{int.interviewerNames.join(", ")}</strong> (
                      {int.format.replace("_", " ")})
                    </div>

                    <div style={{ marginTop: "0.25rem" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text)" }}>
                        Prepped Technical Questions:
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
                Record Final Application Outcome
              </h3>
              <button
                type="button"
                className="button compact"
                onClick={() => setShowOutcomeModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeOpp">Target Opportunity</label>
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
              <label htmlFor="outcomeDec">Decision</label>
              <select
                id="outcomeDec"
                className="career-select"
                value={decision}
                onChange={(e) => setDecision(e.target.value as OutcomeDecision)}
              >
                <option value="accepted">Offer Accepted</option>
                <option value="declined">Offer Declined (Applicant Choice)</option>
                <option value="rejected">Rejected by Organization</option>
                <option value="withdrawn">Candidacy Withdrawn</option>
              </select>
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeComp">Final Compensation / Terms</label>
              <input
                id="outcomeComp"
                className="career-input"
                type="text"
                value={compensation}
                onChange={(e) => setCompensation(e.target.value)}
              />
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeFeedback">Feedback Received</label>
              <textarea
                id="outcomeFeedback"
                className="career-textarea"
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>

            <div className="career-form-group">
              <label htmlFor="outcomeRetro">Retrospective Notes for NEXUS Memory</label>
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
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void handleOutcomeSubmit()}
              >
                Save Outcome
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
