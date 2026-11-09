import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/index.js";
import {
  IconActivity,
  IconBolt,
  IconCheck,
  IconClose,
  IconDocument,
  IconPlay,
  IconPower,
  IconRefresh,
  IconSend,
  IconShield,
  IconTarget,
  IconWarning,
} from "../icons.js";
import type {
  AutonomyMode,
  AutonomyQueue,
  AutonomyRunReport,
  CareerAutonomyAction,
  CareerAutonomySettings,
  CareerAutonomySettingsView,
  CareerEventDto,
  Lab1Client,
  OpportunityKind,
} from "../../lib/lab1-client.js";
import {
  ChipListEditor,
  ErrorBanner,
  ModeSelector,
  actorBadge,
  errorMessage,
  formatDateTime,
} from "./Lab1Controls.js";

const KINDS: OpportunityKind[] = ["phd", "permanent_job", "freelance"];

/**
 * "Autonomie" — per-user autonomy of the career pipeline: a mode per action,
 * the guardrails autonomous actions must pass, the kill switch, the one-click
 * approval queue and the audit trail of everything Nexus did.
 */
export function AutonomyPanel({ client }: { client: Lab1Client | null }) {
  const { tr, locale } = useI18n();
  const [view, setView] = useState<CareerAutonomySettingsView | null>(null);
  const [draft, setDraft] = useState<CareerAutonomySettings | null>(null);
  const [queue, setQueue] = useState<AutonomyQueue | null>(null);
  const [events, setEvents] = useState<CareerEventDto[]>([]);
  const [onlyNexus, setOnlyNexus] = useState(true);
  const [report, setReport] = useState<AutonomyRunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (client === null) return;
    setError(null);
    try {
      const [settings, nextQueue, audit] = await Promise.all([
        client.autonomySettings(),
        client.autonomyQueue(),
        client.autonomyAudit(onlyNexus ? "nexus-autonomous" : undefined),
      ]);
      setView(settings);
      setDraft(settings.settings);
      setQueue(nextQueue);
      setEvents(audit.events);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client, onlyNexus]);

  useEffect(() => {
    void load();
  }, [load]);

  if (client === null) {
    return (
      <div className="lab1-panel">
        <ErrorBanner
          error={tr(
            "Autonomy settings need a signed-in session with the NEXUS API.",
            "Les réglages d'autonomie nécessitent une session connectée à l'API NEXUS.",
          )}
        />
      </div>
    );
  }

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = (patch: Parameters<Lab1Client["updateAutonomySettings"]>[0], message: string) =>
    act("save", () => client.updateAutonomySettings(patch), message);

  const actionLabels: Record<CareerAutonomyAction, { title: string; help: string }> = {
    shortlist: {
      title: tr("Shortlist", "Présélection"),
      help: tr(
        "Approval: Nexus suggests matching offers. Autonomous: Nexus shortlists them.",
        "Validation : Nexus suggère les offres pertinentes. Autonome : Nexus les présélectionne.",
      ),
    },
    documents: {
      title: tr("CV & cover letter", "CV & lettre de motivation"),
      help: tr(
        "Approval: Nexus drafts, you validate. Autonomous: drafts are validated if guardrails pass.",
        "Validation : Nexus rédige, vous validez. Autonome : validés si les garde-fous passent.",
      ),
    },
    submission: {
      title: tr("Application submission", "Envoi de candidature"),
      help: tr(
        "Approval: one click approves and submits. Autonomous: Nexus submits within the guardrails.",
        "Validation : un clic approuve et envoie. Autonome : Nexus envoie dans les garde-fous.",
      ),
    },
  };

  const settings = draft;

  return (
    <div className="lab1-panel" aria-label={tr("Career autonomy", "Autonomie carrière")}>
      <ErrorBanner error={error} onRetry={() => void load()} />
      {notice !== null && (
        <div className="lab1-alert ok" role="status">
          <IconCheck size={16} color="var(--nx-ok)" />
          <div>{notice}</div>
        </div>
      )}

      {view !== null && settings !== null && (
        <>
          <section
            className="lab1-card lab1-kill"
            data-on={settings.killSwitch}
            aria-label={tr("Kill switch", "Arrêt d'urgence")}
          >
            <div className="lab1-row spread">
              <h3>
                <IconPower size={16} color="var(--nx-danger)" />
                {tr("Global kill switch", "Arrêt d'urgence global")}
              </h3>
              <button
                type="button"
                className={`button ${settings.killSwitch ? "ok" : "danger"}`}
                disabled={busy !== null}
                onClick={() =>
                  void save(
                    { killSwitch: !settings.killSwitch },
                    settings.killSwitch
                      ? tr("Autonomous actions resumed.", "Actions autonomes reprises.")
                      : tr(
                          "All autonomous actions paused.",
                          "Toutes les actions autonomes en pause.",
                        ),
                  )
                }
              >
                {settings.killSwitch
                  ? tr("Resume autonomy", "Reprendre l'autonomie")
                  : tr("Pause all autonomous actions", "Suspendre toute action autonome")}
              </button>
            </div>
            <p className="lab1-muted">
              {settings.killSwitch
                ? tr(
                    "ON: every autonomous action falls back to approval. Nothing leaves without your click.",
                    "ACTIF : chaque action autonome repasse en validation. Rien ne part sans votre clic.",
                  )
                : tr(
                    "OFF: actions set to autonomous run inside the guardrails below.",
                    "INACTIF : les actions autonomes s'exécutent dans les garde-fous ci-dessous.",
                  )}
            </p>
          </section>

          <section className="lab1-card" aria-label={tr("Modes", "Modes")}>
            <h3>
              <IconBolt size={16} />
              {tr("Mode per action", "Mode par action")}
            </h3>
            {(Object.keys(actionLabels) as CareerAutonomyAction[]).map((action) => (
              <div className="lab1-mode-row" key={action}>
                <div>
                  <strong>{actionLabels[action].title}</strong>
                  <p className="lab1-muted">{actionLabels[action].help}</p>
                </div>
                <ModeSelector
                  label={actionLabels[action].title}
                  value={settings.modes[action]}
                  effective={view.effectiveModes[action]}
                  disabled={busy !== null}
                  onChange={(mode: AutonomyMode) =>
                    void save({ modes: { [action]: mode } }, tr("Mode saved.", "Mode enregistré."))
                  }
                />
              </div>
            ))}
          </section>

          <section className="lab1-card" aria-label={tr("Guardrails", "Garde-fous")}>
            <h3>
              <IconShield size={16} />
              {tr("Guardrails for autonomous actions", "Garde-fous des actions autonomes")}
            </h3>
            <div className="lab1-grid">
              <label className="lab1-field">
                {tr("Minimum match score (0-100)", "Score de correspondance minimum (0-100)")}
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={settings.guardrails.minMatchScore}
                  onChange={(event) =>
                    setDraft({
                      ...settings,
                      guardrails: {
                        ...settings.guardrails,
                        minMatchScore: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
              <label className="lab1-field">
                {tr("Max submissions per day", "Envois max par jour")}
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={settings.guardrails.maxSubmissionsPerDay}
                  onChange={(event) =>
                    setDraft({
                      ...settings,
                      guardrails: {
                        ...settings.guardrails,
                        maxSubmissionsPerDay: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
              <label className="lab1-field">
                {tr("Timezone (daily cap)", "Fuseau horaire (plafond journalier)")}
                <input
                  value={settings.timezone}
                  onChange={(event) => setDraft({ ...settings, timezone: event.target.value })}
                />
              </label>
            </div>
            <ChipListEditor
              label={tr("Excluded companies", "Entreprises exclues")}
              placeholder={tr("Company name", "Nom d'entreprise")}
              values={settings.guardrails.excludedCompanies}
              onChange={(values) =>
                setDraft({
                  ...settings,
                  guardrails: { ...settings.guardrails, excludedCompanies: values },
                })
              }
            />
            <ChipListEditor
              label={tr("Excluded keywords", "Mots-clés exclus")}
              placeholder={tr("e.g. unpaid", "ex. non rémunéré")}
              values={settings.guardrails.excludedKeywords}
              onChange={(values) =>
                setDraft({
                  ...settings,
                  guardrails: { ...settings.guardrails, excludedKeywords: values },
                })
              }
            />
            <div className="lab1-field">
              <span>{tr("Excluded contract types", "Types de contrat exclus")}</span>
              <div className="lab1-row">
                {KINDS.map((kind) => (
                  <label className="lab1-check" key={kind}>
                    <input
                      type="checkbox"
                      checked={settings.guardrails.excludedContractTypes.includes(kind)}
                      onChange={(event) =>
                        setDraft({
                          ...settings,
                          guardrails: {
                            ...settings.guardrails,
                            excludedContractTypes: event.target.checked
                              ? [...settings.guardrails.excludedContractTypes, kind]
                              : settings.guardrails.excludedContractTypes.filter((k) => k !== kind),
                          },
                        })
                      }
                    />
                    {kind === "phd"
                      ? tr("PhD", "Thèse")
                      : kind === "permanent_job"
                        ? "CDI"
                        : "Freelance"}
                  </label>
                ))}
              </div>
            </div>
            <div className="lab1-row">
              <button
                type="button"
                className="button primary"
                disabled={busy !== null}
                onClick={() =>
                  void save(
                    { guardrails: settings.guardrails, timezone: settings.timezone },
                    tr("Guardrails saved.", "Garde-fous enregistrés."),
                  )
                }
              >
                <IconCheck size={14} /> {tr("Save guardrails", "Enregistrer les garde-fous")}
              </button>
              <span className="lab1-muted">
                {view.configured
                  ? `${tr("Last saved", "Dernier enregistrement")}: ${formatDateTime(view.updatedAt, locale)}`
                  : tr(
                      "Defaults in use (every action requires approval).",
                      "Valeurs par défaut (chaque action requiert une validation).",
                    )}
              </span>
            </div>
          </section>
        </>
      )}

      <section className="lab1-card" aria-label={tr("Approval queue", "File de validation")}>
        <div className="lab1-row spread">
          <h3>
            <IconCheck size={16} />
            {tr("Approval queue", "File de validation")}
          </h3>
          <div className="lab1-row">
            <button
              type="button"
              className="button compact"
              disabled={busy !== null}
              onClick={() => void load()}
            >
              <IconRefresh size={12} /> {tr("Refresh", "Actualiser")}
            </button>
            <button
              type="button"
              className="button compact primary"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "run",
                  async () => setReport(await client.runAutonomy()),
                  tr("Pipeline run complete.", "Passage du pipeline terminé."),
                )
              }
            >
              <IconPlay size={12} /> {tr("Run pipeline now", "Lancer le pipeline")}
            </button>
          </div>
        </div>

        {report !== null && (
          <div className="lab1-alert" role="status">
            <IconActivity size={16} />
            <div>
              {tr("Shortlisted", "Présélectionnées")}: {report.shortlisted.length} ·{" "}
              {tr("Documents", "Documents")}: {report.documentsPrepared.length} ·{" "}
              {tr("Approvals requested", "Validations demandées")}:{" "}
              {report.approvalsRequested.length} · {tr("Submitted", "Envoyées")}:{" "}
              {report.submitted.length} · {tr("Held back", "Retenues")}: {report.blocked.length}
              {report.errors.length > 0 && (
                <ul className="lab1-muted">
                  {report.errors.map((item, index) => (
                    <li key={index}>
                      <IconWarning size={11} color="var(--nx-danger)" /> {item.action}:{" "}
                      {item.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {queue === null ? (
          <p className="lab1-muted">{tr("Loading...", "Chargement...")}</p>
        ) : (
          <>
            <h4>
              <IconTarget size={14} /> {tr("Suggested to shortlist", "Suggestions de présélection")}{" "}
              ({queue.suggestions.length})
            </h4>
            <ul className="lab1-list">
              {queue.suggestions.map((item) => (
                <li className="lab1-item" key={item.opportunityId}>
                  <div className="lab1-row spread">
                    <span>
                      <strong>{item.title}</strong> · {item.organization}{" "}
                      <span className="lab1-badge ok">{item.score}%</span>
                    </span>
                    <button
                      type="button"
                      className="button compact ok"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `s-${item.opportunityId}`,
                          () => client.shortlist(item.opportunityId),
                          tr("Shortlisted.", "Présélectionnée."),
                        )
                      }
                    >
                      <IconCheck size={12} /> {tr("Shortlist", "Présélectionner")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <h4>
              <IconDocument size={14} /> {tr("Documents to validate", "Documents à valider")} (
              {queue.documentsToValidate.length})
            </h4>
            <ul className="lab1-list">
              {queue.documentsToValidate.map((item) => (
                <li className="lab1-item" key={item.applicationId}>
                  <div className="lab1-row spread">
                    <span>
                      <strong>{item.title}</strong> · {item.organization}{" "}
                      {item.documents.map((doc) => (
                        <span className="lab1-badge" key={doc.id}>
                          {doc.kind} r{doc.revision}
                        </span>
                      ))}
                    </span>
                    <button
                      type="button"
                      className="button compact ok"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `d-${item.applicationId}`,
                          () => client.validateDocuments(item.applicationId),
                          tr(
                            "Documents validated; submission approval opened.",
                            "Documents validés ; validation d'envoi ouverte.",
                          ),
                        )
                      }
                    >
                      <IconCheck size={12} /> {tr("Validate documents", "Valider les documents")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <h4>
              <IconSend size={14} /> {tr("Submissions awaiting approval", "Envois en attente")} (
              {queue.approvalsPending.length})
            </h4>
            <ul className="lab1-list">
              {queue.approvalsPending.map((item) => (
                <li className="lab1-item" key={item.confirmationId}>
                  <p>{item.summary}</p>
                  <div className="lab1-row spread">
                    <span className="lab1-muted">
                      {tr("Expires", "Expire")}: {formatDateTime(item.expiresAt, locale)}
                      {item.score !== null && (
                        <>
                          {" "}
                          · {tr("score", "score")} {item.score}%
                        </>
                      )}
                    </span>
                    <div className="lab1-row">
                      <button
                        type="button"
                        className="button compact danger"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(
                            `r-${item.confirmationId}`,
                            () => client.rejectConfirmation(item.confirmationId),
                            tr("Declined.", "Refusée."),
                          )
                        }
                      >
                        <IconClose size={12} /> {tr("Decline", "Refuser")}
                      </button>
                      <button
                        type="button"
                        className="button compact ok"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(
                            `a-${item.confirmationId}`,
                            () => client.approveAndSubmit(item.confirmationId),
                            tr("Approved and submitted.", "Approuvée et envoyée."),
                          )
                        }
                      >
                        <IconSend size={12} /> {tr("Approve & submit", "Approuver & envoyer")}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="lab1-card" aria-label={tr("Audit trail", "Journal d'audit")}>
        <div className="lab1-row spread">
          <h3>
            <IconActivity size={16} />
            {tr("Audit trail", "Journal d'audit")}
          </h3>
          <label className="lab1-check">
            <input
              type="checkbox"
              checked={onlyNexus}
              onChange={(event) => setOnlyNexus(event.target.checked)}
            />
            {tr("Only autonomous actions", "Seulement les actions autonomes")}
          </label>
        </div>
        {events.length === 0 ? (
          <p className="lab1-muted">{tr("No events yet.", "Aucun événement pour l'instant.")}</p>
        ) : (
          <div className="lab1-scroll">
            <table className="lab1-table">
              <thead>
                <tr>
                  <th>{tr("When", "Quand")}</th>
                  <th>{tr("Actor", "Acteur")}</th>
                  <th>{tr("Event", "Événement")}</th>
                  <th>{tr("Details", "Détails")}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const badge = actorBadge(event.actor);
                  const reasons = event.context.reasons;
                  return (
                    <tr key={event.id}>
                      <td className="mono">{formatDateTime(event.createdAt, locale)}</td>
                      <td>
                        <span className={badge.className}>{badge.label}</span>
                      </td>
                      <td className="mono">{event.summary}</td>
                      <td>{typeof reasons === "string" ? reasons : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
