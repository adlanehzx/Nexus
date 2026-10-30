import { useState } from "react";
import type {
  CreateDeadlineInput,
  Deadline,
  DeadlineCategory,
  Opportunity,
} from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";
import { IconCalendar, IconClose } from "../icons.js";

interface DeadlinesCalendarProps {
  deadlines: Deadline[];
  opportunities: Opportunity[];
  onCreateDeadline: (input: CreateDeadlineInput) => Promise<Deadline>;
  onToggleCompleted: (id: string, completed: boolean) => Promise<void>;
  onSyncCalendar: (d: Deadline) => Promise<void>;
  loading?: boolean;
}

export function DeadlinesCalendar({
  deadlines,
  opportunities,
  onCreateDeadline,
  onToggleCompleted,
  onSyncCalendar,
  loading = false,
}: DeadlinesCalendarProps) {
  const { tr } = useI18n();
  const [showAddModal, setShowAddModal] = useState(false);
  const [title, setTitle] = useState("");
  const [targetOppId, setTargetOppId] = useState(opportunities[0]?.id ?? "");
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0] ?? "",
  );
  const [category, setCategory] = useState<DeadlineCategory>("application_deadline");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "critical">("high");
  const [notice, setNotice] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!title.trim() || !targetOppId) return;
    const opp = opportunities.find((o) => o.id === targetOppId);
    if (!opp) return;

    try {
      await onCreateDeadline({
        opportunityId: targetOppId,
        opportunityTitle: opp.title,
        organization: opp.organization,
        title: title.trim(),
        dueDate,
        category,
        priority,
      });
      setShowAddModal(false);
      setTitle("");
      setNotice(
        tr(`Deadline "${title}" added to schedule.`, `Échéance "${title}" ajoutée au calendrier.`),
      );
    } catch (err) {
      setNotice(
        err instanceof Error
          ? err.message
          : tr("Failed to create deadline.", "Échec de création de l'échéance."),
      );
    }
  };

  return (
    <div
      className="career-tab-content"
      role="region"
      aria-label="Deadlines and Calendar Schedule"
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
            {tr("Deadlines & Milestone Schedule", "Échéances & Calendrier des Jalons")}
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            {tr(
              "Application file closing dates, funding call deadlines, interview milestones, and calendar sync.",
              "Dates de clôture des dossiers, dates limites d'appels à financement, entretiens et synchronisation d'agenda.",
            )}
          </p>
        </div>

        <button type="button" className="button primary" onClick={() => setShowAddModal(true)}>
          {tr("+ Add Deadline", "+ Ajouter une échéance")}
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

      {/* Deadlines List */}
      {loading ? (
        <div className="career-card" style={{ textAlign: "center", padding: "2rem" }}>
          {tr("Loading deadlines schedule...", "Chargement du calendrier des échéances...")}
        </div>
      ) : deadlines.length === 0 ? (
        <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
          <strong>
            {tr("No upcoming deadlines recorded", "Aucune échéance à venir enregistrée")}
          </strong>
        </div>
      ) : (
        <div className="career-grid-2">
          {deadlines.map((d) => {
            const due = new Date(d.dueDate);
            const daysRemaining = Math.ceil((due.getTime() - Date.now()) / 86400000);

            return (
              <div
                key={d.id}
                className="career-card"
                style={{
                  borderLeft: `4px solid ${
                    d.priority === "critical"
                      ? "var(--down)"
                      : d.priority === "high"
                        ? "var(--gradient)"
                        : "var(--accent)"
                  }`,
                  opacity: d.completed ? 0.6 : 1,
                }}
              >
                <div className="career-card-header">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={d.completed}
                      onChange={(e) => void onToggleCompleted(d.id, e.target.checked)}
                      aria-label={`${tr("Mark", "Marquer")} ${d.title} ${tr("as completed", "comme terminée")}`}
                    />
                    <strong
                      style={{
                        fontSize: "0.95rem",
                        textDecoration: d.completed ? "line-through" : "none",
                      }}
                    >
                      {d.title}
                    </strong>
                  </div>

                  <span
                    style={{
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color:
                        d.priority === "critical"
                          ? "var(--down)"
                          : d.priority === "high"
                            ? "var(--gradient)"
                            : "var(--muted-text)",
                    }}
                  >
                    {d.priority} {tr("Priority", "Priorité")}
                  </span>
                </div>

                <div style={{ fontSize: "0.82rem", color: "var(--muted-text)" }}>
                  {tr("Target:", "Cible :")} <strong>{d.organization}</strong> ({d.opportunityTitle}
                  )
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "0.82rem",
                  }}
                >
                  <span>
                    {tr("Category:", "Catégorie :")} <strong>{d.category.replace("_", " ")}</strong>
                  </span>
                  <span
                    style={{
                      fontWeight: 600,
                      color: daysRemaining <= 3 ? "var(--down)" : "var(--text)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                    }}
                  >
                    <IconCalendar size={13} />
                    <span>
                      {due.toLocaleDateString()} (
                      {daysRemaining > 0
                        ? `${daysRemaining} ${tr("d remaining", "j restants")}`
                        : tr("Past due", "Dépassée")}
                      )
                    </span>
                  </span>
                </div>

                {/* Calendar Sync Action */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: "auto",
                    paddingTop: "0.5rem",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                    {tr("Calendar Sync:", "Synchro agenda :")}{" "}
                    <strong>{d.calendarSyncStatus}</strong>
                  </span>
                  {d.calendarSyncStatus !== "confirmed" && (
                    <button
                      type="button"
                      className="button compact"
                      onClick={() =>
                        void onSyncCalendar(d).then(() =>
                          setNotice(
                            tr(
                              "Sync drafted for Google Calendar. Action paused at Confirmation Card.",
                              "Synchronisation préparée pour Google Agenda. Action suspendue en attente de confirmation.",
                            ),
                          ),
                        )
                      }
                      title={tr(
                        "Syncs event to Google Calendar draft, requiring explicit confirmation",
                        "Synchronise l'événement en brouillon Google Agenda, exigeant une confirmation explicite",
                      )}
                    >
                      {tr("Sync to Calendar Draft", "Synchroniser en brouillon")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Deadline Modal */}
      {showAddModal && (
        <div
          className="career-modal-backdrop"
          onClick={() => setShowAddModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-deadline-title"
        >
          <div className="career-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="career-modal-header">
              <h3 id="add-deadline-title" className="career-modal-title">
                {tr("Add New Deadline or Milestone", "Ajouter une échéance ou un jalon")}
              </h3>
              <button
                type="button"
                className="button compact"
                onClick={() => setShowAddModal(false)}
                aria-label={tr("Close", "Fermer")}
              >
                <IconClose size={16} />
              </button>
            </div>

            <div className="career-form-group">
              <label htmlFor="dTitle">{tr("Deadline Title", "Titre de l'échéance")}</label>
              <input
                id="dTitle"
                className="career-input"
                type="text"
                placeholder={tr("e.g. CIFRE Thesis File Submission", "ex. Dépôt du dossier CIFRE")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="career-form-group">
              <label htmlFor="dOpp">{tr("Associated Opportunity", "Opportunité associée")}</label>
              <select
                id="dOpp"
                className="career-select"
                value={targetOppId}
                onChange={(e) => setTargetOppId(e.target.value)}
              >
                {opportunities.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title} ({o.organization})
                  </option>
                ))}
              </select>
            </div>

            <div className="career-grid-2">
              <div className="career-form-group">
                <label htmlFor="dDate">{tr("Due Date", "Date limite")}</label>
                <input
                  id="dDate"
                  className="career-input"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>

              <div className="career-form-group">
                <label htmlFor="dCat">{tr("Category", "Catégorie")}</label>
                <select
                  id="dCat"
                  className="career-select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as DeadlineCategory)}
                >
                  <option value="application_deadline">
                    {tr("Application Deadline", "Date limite de candidature")}
                  </option>
                  <option value="funding_call">
                    {tr("Funding Call Cutoff", "Clôture d'appel à financement")}
                  </option>
                  <option value="interview">{tr("Interview Slot", "Créneau d'entretien")}</option>
                  <option value="follow_up">
                    {tr("Outreach Follow-up", "Relance de contact")}
                  </option>
                </select>
              </div>
            </div>

            <div className="career-form-group">
              <label htmlFor="dPriority">{tr("Priority Level", "Niveau de priorité")}</label>
              <select
                id="dPriority"
                className="career-select"
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as "low" | "medium" | "high" | "critical")
                }
              >
                <option value="critical">
                  {tr(
                    "Critical (Immediate Action Required)",
                    "Critique (Action immédiate requise)",
                  )}
                </option>
                <option value="high">{tr("High", "Élevée")}</option>
                <option value="medium">{tr("Medium", "Moyenne")}</option>
                <option value="low">{tr("Low", "Basse")}</option>
              </select>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" className="button" onClick={() => setShowAddModal(false)}>
                {tr("Cancel", "Annuler")}
              </button>
              <button type="button" className="button primary" onClick={() => void handleCreate()}>
                {tr("Add Deadline", "Ajouter l'échéance")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
