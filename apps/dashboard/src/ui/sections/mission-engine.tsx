import { useState } from "react";
import type { DashboardApi, MissionCollaborationDto, ScheduleRun } from "../../lib/api.js";
import { formatAge, formatCount, formatDuration } from "../../lib/format.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import { Runs } from "./runs.js";
import { IconBarChart } from "../icons.js";

// ─────────────────────────────────────────────────────────────────────────────
// NEXUS Mission Engine
// ─────────────────────────────────────────────────────────────────────────────

export function MissionControl({ api }: { api: DashboardApi }) {
  return <MissionEngineView api={api} view="missions" />;
}

export function TradingLab({ api }: { api: DashboardApi }) {
  return <MissionEngineView api={api} view="trading" />;
}

function MissionEngineView({ api, view }: { api: DashboardApi; view: "missions" | "trading" }) {
  const { tr } = useI18n();
  const state = useSection(() => api.missionControl());
  const isTrading = view === "trading";
  const [accountName, setAccountName] = useState("NEXUS Portfolio");
  const [bankroll, setBankroll] = useState("50.00");
  const [marketQuestion, setMarketQuestion] = useState("");
  const [marketClose, setMarketClose] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleInstruction, setScheduleInstruction] = useState("");
  const [scheduleProfile, setScheduleProfile] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"one_shot" | "cron">("cron");
  const [scheduleRunAt, setScheduleRunAt] = useState("");
  const [scheduleCron, setScheduleCron] = useState("0 8 * * 1-5");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [scheduleCatchUp, setScheduleCatchUp] = useState<"skip" | "latest" | "all">("latest");
  const [scheduleHistory, setScheduleHistory] = useState<Record<string, ScheduleRun[]>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (operation: () => Promise<unknown>): void => {
    setActionError(null);
    void operation()
      .then(() => state.reload())
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(data) => {
          const cash = data.accounts.reduce(
            (total, account) => total + account.cash_balance_cents,
            0,
          );
          const exposure = data.accounts.reduce(
            (total, account) => total + account.open_exposure_cents,
            0,
          );
          const activeRuns = data.recent_runs.filter(
            (run) => run.state === "running" || run.state === "waiting_market_data",
          ).length;

          return (
            <>
              {isTrading ? (
                <div className="paper-trading-banner">
                  <div>
                    <strong>
                      {tr(
                        "Simulation & Research — No Real Money",
                        "Simulation & Recherche — Aucun fonds réel",
                      )}
                    </strong>
                    <p className="muted" style={{ margin: "4px 0 0" }}>
                      {tr(
                        "Creation of missions and paper portfolios uses the NEXUS administrator API. No live trading paths are exposed.",
                        "La création de missions et de portefeuilles de recherche utilise l'API administrateur NEXUS. Aucune route d'exécution financière réelle n'est exposée.",
                      )}
                    </p>
                  </div>
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "1rem" }}>
                <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: data.configured ? "var(--color-success, #00e676)" : "var(--color-muted, #757575)" }} />
                  <div>
                    <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                      {tr("Engine Config", "Config Moteur")}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                      {data.configured ? tr("Configured", "Configuré") : tr("Not configured", "Non configuré")}
                    </div>
                  </div>
                </div>

                <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: data.reachable ? "var(--color-success, #00e676)" : "var(--color-error, #ff5252)" }} />
                  <div>
                    <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                      {tr("ACP Engine Status", "État Moteur ACP")}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                      {data.reachable ? tr("Online & Connected", "En ligne & Connecté") : tr("Unreachable", "Inaccessible")}
                    </div>
                  </div>
                </div>

                {isTrading ? (
                  <>
                    <div className="card" style={{ padding: "12px 16px" }}>
                      <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                        {tr("paper cash", "liquidités papier")}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                        {(cash / 100).toFixed(2)} €
                      </div>
                    </div>
                    <div className="card" style={{ padding: "12px 16px" }}>
                      <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                        {tr("paper exposure", "exposition papier")}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                        {(exposure / 100).toFixed(2)} €
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="card" style={{ padding: "12px 16px" }}>
                      <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                        {tr("Workers", "Agents")}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: "1rem", marginTop: "4px", color: data.health?.worker_enabled ? "var(--color-success, #00e676)" : "var(--color-muted, #888)" }}>
                        {data.health?.worker_enabled ? tr("Active", "Actif") : tr("Inactive", "Inactif")}
                      </div>
                    </div>
                    <div className="card" style={{ padding: "12px 16px" }}>
                      <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                        {tr("Concurrency", "Concurrence")}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                        {data.health?.worker_concurrency ?? 0}
                      </div>
                    </div>
                    <div className="card" style={{ padding: "12px 16px" }}>
                      <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                        {tr("Audit Chain", "Chaîne d'audit")}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: "1rem", marginTop: "4px", color: data.audit?.valid ? "var(--color-success, #00e676)" : "var(--color-warning, #ffb300)" }}>
                        {data.audit?.valid ? tr("Valid", "Valide") : tr("Checking", "En cours")}
                      </div>
                    </div>
                  </>
                )}
                <div className="card" style={{ padding: "12px 16px" }}>
                  <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                    {tr("Active Missions", "Missions actives")}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px", color: activeRuns > 0 ? "var(--color-accent, #00e5ff)" : "inherit" }}>
                    {formatCount(activeRuns)}
                  </div>
                </div>
              </div>

              <p className="muted">{data.detail}</p>

              {isTrading ? null : (
                <>
                  <h3>{tr("NEXUS · ACP profiles", "NEXUS · Profils ACP")}</h3>
                  <p className="mono muted">
                    {data.health === null || data.health.profiles.length === 0
                      ? tr("none", "aucun")
                      : data.health.profiles.join(", ")}
                  </p>

                  <h3>{tr("Autonomous Schedules", "Planifications Autonomes")}</h3>
                  <div className="admin-form-card schedule-form-card">
                    <div className="inline-admin-form schedule-form">
                      <input
                        className="field"
                        value={scheduleName}
                        onChange={(event) => setScheduleName(event.target.value)}
                        placeholder={tr("Schedule name", "Nom de la planification")}
                      />
                      <select
                        className="field"
                        value={scheduleKind}
                        onChange={(event) =>
                          setScheduleKind(event.target.value as "one_shot" | "cron")
                        }
                      >
                        <option value="cron">{tr("Recurring · cron", "Récurrent · cron")}</option>
                        <option value="one_shot">{tr("One-shot", "Ponctuel")}</option>
                      </select>
                      <select
                        className="field"
                        value={scheduleProfile}
                        onChange={(event) => setScheduleProfile(event.target.value)}
                      >
                        <option value="">
                          {tr(
                            "Automatically select first profile",
                            "Sélectionner automatiquement le premier profil",
                          )}
                        </option>
                        {(data.health?.profiles ?? []).map((profile) => (
                          <option value={profile} key={profile}>
                            {profile}
                          </option>
                        ))}
                      </select>
                      <input
                        className="field"
                        value={scheduleTimezone}
                        onChange={(event) => setScheduleTimezone(event.target.value)}
                        placeholder="Europe/Paris"
                      />
                      {scheduleKind === "cron" ? (
                        <input
                          className="field mono"
                          value={scheduleCron}
                          onChange={(event) => setScheduleCron(event.target.value)}
                          placeholder="0 8 * * 1-5"
                        />
                      ) : (
                        <input
                          className="field"
                          type="datetime-local"
                          value={scheduleRunAt}
                          onChange={(event) => setScheduleRunAt(event.target.value)}
                        />
                      )}
                      <select
                        className="field"
                        value={scheduleCatchUp}
                        onChange={(event) =>
                          setScheduleCatchUp(event.target.value as "skip" | "latest" | "all")
                        }
                      >
                        <option value="skip">
                          {tr("Skip missed occurrences", "Ignorer occurrences manquées")}
                        </option>
                        <option value="latest">
                          {tr(
                            "Catch up latest occurrence only",
                            "Rattraper la dernière occurrence uniquement",
                          )}
                        </option>
                        <option value="all">
                          {tr(
                            "Catch up all missed occurrences",
                            "Rattraper toutes les occurrences manquées",
                          )}
                        </option>
                      </select>
                    </div>
                    <textarea
                      className="field schedule-instruction"
                      value={scheduleInstruction}
                      onChange={(event) => setScheduleInstruction(event.target.value)}
                      placeholder={tr(
                        "Mission to execute automatically",
                        "Mission à exécuter automatiquement",
                      )}
                      rows={3}
                    />
                    <button
                      className="button"
                      type="button"
                      disabled={
                        data.health?.scheduler_enabled !== true ||
                        scheduleName.trim().length === 0 ||
                        scheduleInstruction.trim().length === 0 ||
                        (data.health?.profiles.length ?? 0) === 0 ||
                        (scheduleKind === "cron"
                          ? scheduleCron.trim().length === 0
                          : scheduleRunAt.length === 0)
                      }
                      onClick={() => {
                        const profile = scheduleProfile || data.health?.profiles[0];
                        if (profile === undefined) return;
                        act(() =>
                          api.createSchedule({
                            name: scheduleName.trim(),
                            mission: {
                              external_key: "dashboard-owned-server-side",
                              title: scheduleName.trim(),
                              workspace: "/tmp/nexus-scheduled",
                              tasks: [
                                {
                                  key: "scheduled_task",
                                  profile,
                                  instruction: scheduleInstruction.trim(),
                                  depends_on: [],
                                },
                              ],
                            },
                            timezone: scheduleTimezone.trim(),
                            ...(scheduleKind === "cron"
                              ? { cron_expression: scheduleCron.trim() }
                              : { run_at: new Date(scheduleRunAt).toISOString() }),
                            catch_up_policy: scheduleCatchUp,
                            max_catch_up: 10,
                            max_concurrency: 1,
                            misfire_grace_seconds: 300,
                          }),
                        );
                      }}
                    >
                      {tr("Create schedule", "Créer la planification")}
                    </button>
                    {data.health?.scheduler_enabled === true ? null : (
                      <p className="muted">
                        {tr(
                          "Schedule dispatcher is disabled.",
                          "Le répartiteur de planification est désactivé.",
                        )}
                      </p>
                    )}
                  </div>

                  {data.schedules.length === 0 ? (
                    <Empty>
                      {tr("No schedules for this account.", "Aucune planification pour ce compte.")}
                    </Empty>
                  ) : (
                    <div className="stack">
                      {data.schedules.map((schedule) => (
                        <details className="card" key={schedule.id}>
                          <summary>
                            <State
                              tone={
                                schedule.state === "active"
                                  ? "ok"
                                  : schedule.state === "paused"
                                    ? "degraded"
                                    : "info"
                              }
                              label={schedule.state}
                            />{" "}
                            {schedule.name} ·{" "}
                            {schedule.schedule_kind === "cron"
                              ? schedule.cron_expression
                              : "one-shot"}
                          </summary>
                          <div className="schedule-details">
                            <p className="muted">
                              {tr("Timezone:", "Fuseau horaire :")} {schedule.timezone} ·{" "}
                              {tr("Next run:", "Prochaine exécution :")}{" "}
                              {schedule.next_run_at === null
                                ? tr("none", "aucune")
                                : new Date(schedule.next_run_at).toLocaleString()}
                            </p>
                            <p>
                              {schedule.mission.tasks[0]?.instruction ?? schedule.mission.title}
                            </p>
                            <div className="actions-row">
                              {schedule.state === "active" ? (
                                <button
                                  className="button secondaire compact"
                                  type="button"
                                  onClick={() => act(() => api.pauseSchedule(schedule.id))}
                                >
                                  {tr("Pause", "Suspendre")}
                                </button>
                              ) : schedule.state === "paused" ? (
                                <button
                                  className="button compact"
                                  type="button"
                                  onClick={() => act(() => api.resumeSchedule(schedule.id))}
                                >
                                  {tr("Resume", "Reprendre")}
                                </button>
                              ) : null}
                              <button
                                className="button secondaire compact"
                                type="button"
                                onClick={() => {
                                  setActionError(null);
                                  void api
                                    .scheduleRuns(schedule.id)
                                    .then(({ runs }) =>
                                      setScheduleHistory((current) => ({
                                        ...current,
                                        [schedule.id]: runs,
                                      })),
                                    )
                                    .catch((cause: unknown) =>
                                      setActionError(
                                        cause instanceof Error
                                          ? cause.message
                                          : tr("History unavailable.", "Historique indisponible."),
                                      ),
                                    );
                                }}
                              >
                                {tr("Load history", "Charger l'historique")}
                              </button>
                            </div>
                            {scheduleHistory[schedule.id] === undefined ? null : scheduleHistory[
                                schedule.id
                              ]?.length === 0 ? (
                              <p className="muted">
                                {tr("No occurrences executed.", "Aucune occurrence exécutée.")}
                              </p>
                            ) : (
                              <Table
                                head={[
                                  tr("Scheduled", "Planifié"),
                                  tr("State", "État"),
                                  tr("Mission", "Mission"),
                                  tr("Error", "Erreur"),
                                ]}
                              >
                                {scheduleHistory[schedule.id]?.map((run) => (
                                  <tr key={run.id}>
                                    <td>{new Date(run.scheduled_for).toLocaleString()}</td>
                                    <td>
                                      <State
                                        tone={
                                          run.state === "succeeded"
                                            ? "ok"
                                            : run.state === "failed"
                                              ? "down"
                                              : run.state === "skipped"
                                                ? "degraded"
                                                : "info"
                                        }
                                        label={run.state}
                                      />
                                    </td>
                                    <td className="mono muted">
                                      {run.mission_id?.slice(0, 8) ?? "—"}
                                    </td>
                                    <td className="muted">{run.error_code ?? "—"}</td>
                                  </tr>
                                ))}
                              </Table>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}

                  <h3>{tr("Unified Mission Timeline", "Chronologie Unifiée des Missions")}</h3>
                  {data.missions.length === 0 ? (
                    <Empty>
                      {tr(
                        "No NEXUS ACP missions for this account.",
                        "Aucune mission ACP NEXUS pour ce compte.",
                      )}
                    </Empty>
                  ) : (
                    <div className="stack">
                      {data.missions.map((mission) => (
                        <details className="card" key={mission.id}>
                          <summary>
                            <State
                              tone={
                                mission.state === "succeeded"
                                  ? "ok"
                                  : mission.state === "failed"
                                    ? "down"
                                    : "info"
                              }
                              label={mission.state}
                            />{" "}
                            {mission.title} · {mission.tasks.length} {tr("step(s)", "étape(s)")} ·{" "}
                            {formatAge(mission.created_at)}
                          </summary>
                          <Table
                            head={[
                              tr("Step", "Étape"),
                              tr("Agent", "Agent"),
                              tr("State", "État"),
                              tr("Dependencies", "Dépendances"),
                              tr("Attempts", "Tentatives"),
                              tr("Duration", "Durée"),
                            ]}
                          >
                            {mission.tasks.map((task) => {
                              const first = task.attempts[0];
                              const last = task.attempts.at(-1);
                              return (
                                <tr key={task.id}>
                                  <td className="mono">{task.task_key}</td>
                                  <td>{task.profile_key}</td>
                                  <td>
                                    <State
                                      tone={
                                        task.state === "succeeded"
                                          ? "ok"
                                          : task.state === "failed"
                                            ? "down"
                                            : task.state === "retry_wait"
                                              ? "degraded"
                                              : "info"
                                      }
                                      label={task.state}
                                    />
                                  </td>
                                  <td className="muted">
                                    {task.depends_on.length === 0
                                      ? "—"
                                      : task.depends_on.join(", ")}
                                  </td>
                                  <td>{task.attempts.length}</td>
                                  <td className="muted">
                                    {first === undefined
                                      ? "—"
                                      : formatDuration(
                                          new Date(
                                            last?.finished_at ??
                                              last?.updated_at ??
                                              first.started_at,
                                          ).getTime() - new Date(first.started_at).getTime(),
                                        )}
                                  </td>
                                </tr>
                              );
                            })}
                          </Table>
                          <MissionCollaborationPanel api={api} missionId={mission.id} />
                        </details>
                      ))}
                    </div>
                  )}

                  <details className="card" style={{ marginTop: "1.5rem" }}>
                    <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "1rem", userSelect: "none", padding: "4px 0", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <IconBarChart size={18} color="var(--nx-accent-line, #38bdf8)" /> {tr("Agent Execution Traces & Tool Audit", "Historique & Traçabilité des exécutions d'agents")}
                    </summary>
                    <Runs api={api} embedded />
                  </details>
                </>
              )}

              {isTrading ? (
                <>
                  <h3>{tr("Paper Portfolios", "Portefeuilles de recherche papier")}</h3>
                  <div className="inline-admin-form">
                    <input
                      className="field"
                      value={accountName}
                      onChange={(event) => setAccountName(event.target.value)}
                      placeholder={tr("Portfolio name", "Nom du portefeuille")}
                    />
                    <input
                      className="field"
                      value={bankroll}
                      onChange={(event) => setBankroll(event.target.value)}
                      inputMode="decimal"
                      placeholder="Capital EUR"
                    />
                    <button
                      className="button"
                      type="button"
                      onClick={() =>
                        act(() =>
                          api.createPaperAccount({
                            name: accountName.trim(),
                            bankroll_eur: bankroll,
                          }),
                        )
                      }
                    >
                      {tr("Create", "Créer")}
                    </button>
                  </div>
                  {data.accounts.length === 0 ? (
                    <Empty>
                      {tr("No research portfolios.", "Aucun portefeuille de recherche.")}
                    </Empty>
                  ) : (
                    <Table
                      head={[
                        tr("Name", "Nom"),
                        tr("Cash", "Liquidités"),
                        tr("Exposure", "Exposition"),
                        tr("Realized P&L", "P&L Réalisé"),
                        tr("Mode", "Mode"),
                      ]}
                    >
                      {data.accounts.map((account) => (
                        <tr key={account.id}>
                          <td>{account.name}</td>
                          <td>{(account.cash_balance_cents / 100).toFixed(2)} €</td>
                          <td>{(account.open_exposure_cents / 100).toFixed(2)} €</td>
                          <td
                            className={
                              account.realized_pnl_cents > 0
                                ? "pnl-positive"
                                : account.realized_pnl_cents < 0
                                  ? "pnl-negative"
                                  : ""
                            }
                          >
                            {(account.realized_pnl_cents / 100).toFixed(2)} €
                          </td>
                          <td>
                            <State tone="ok" label={tr("paper-only", "simulation-seule")} />
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}

                  <h3>{tr("Recent Missions", "Missions récentes")}</h3>
                  {data.recent_runs.length === 0 ? (
                    <Empty>{tr("No ACP missions executed.", "Aucune mission ACP exécutée.")}</Empty>
                  ) : (
                    <Table
                      head={[
                        tr("Created", "Créé"),
                        tr("State", "État"),
                        tr("Mission", "Mission"),
                        tr("Error", "Erreur"),
                      ]}
                    >
                      {data.recent_runs.map((run) => (
                        <tr key={run.id}>
                          <td className="muted">{formatAge(run.created_at)}</td>
                          <td>
                            <State
                              tone={
                                run.state === "executed"
                                  ? "ok"
                                  : run.state === "failed"
                                    ? "down"
                                    : run.state === "abstained"
                                      ? "degraded"
                                      : "info"
                              }
                              label={run.state}
                            />
                          </td>
                          <td className="mono muted">{run.mission_id.slice(0, 8)}</td>
                          <td className="muted">{run.error_code ?? "—"}</td>
                        </tr>
                      ))}
                    </Table>
                  )}

                  <h3>{tr("Paper Research Market", "Marché de recherche papier")}</h3>
                  <div className="inline-admin-form market-form">
                    <input
                      className="field"
                      value={marketQuestion}
                      onChange={(event) => setMarketQuestion(event.target.value)}
                      placeholder={tr("Market question", "Question du marché")}
                    />
                    <input
                      className="field"
                      type="datetime-local"
                      value={marketClose}
                      onChange={(event) => setMarketClose(event.target.value)}
                    />
                    <button
                      className="button"
                      type="button"
                      disabled={marketQuestion.trim().length === 0 || marketClose.length === 0}
                      onClick={() => {
                        act(() =>
                          api.createPaperMarket({
                            question: marketQuestion.trim(),
                            close_at: new Date(marketClose).toISOString(),
                          }),
                        );
                        setMarketQuestion("");
                      }}
                    >
                      {tr("Create", "Créer")}
                    </button>
                  </div>

                  <p className="muted">
                    {tr(
                      "Creation of missions and paper portfolios uses the NEXUS administrator API. No live trading paths are exposed.",
                      "La création de missions et de portefeuilles de recherche utilise l'API administrateur NEXUS. Aucune route d'exécution financière réelle n'est exposée.",
                    )}
                  </p>
                </>
              ) : null}
            </>
          );
        }}
      </Section>
    </div>
  );
}

function MissionCollaborationPanel({ api, missionId }: { api: DashboardApi; missionId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [collab, setCollab] = useState<MissionCollaborationDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    if (!open && collab === null) {
      setLoading(true);
      setError(null);
      try {
        const res = await api.missionCollaboration(missionId);
        setCollab(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Loading error");
      } finally {
        setLoading(false);
      }
    }
    setOpen(!open);
  };

  return (
    <div style={{ marginTop: "12px", borderTop: "1px dashed var(--nx-line)", paddingTop: "8px" }}>
      <button
        type="button"
        className="button"
        style={{ fontSize: "0.85rem", padding: "4px 10px" }}
        onClick={() => void toggle()}
      >
        {open ? "Hide artifacts and collaboration" : "Shared Artifacts & Cross-Agent Collaboration"}
      </button>

      {loading ? (
        <p className="muted" style={{ marginTop: "6px" }}>
          Loading collaboration workspace…
        </p>
      ) : null}
      {error ? <p style={{ color: "var(--nx-danger)", marginTop: "6px" }}>{error}</p> : null}

      {open && collab ? (
        <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* Artifacts */}
          <div>
            <h4 style={{ margin: "0 0 6px 0", fontSize: "0.95rem" }}>
              Shared Artifacts ({collab.artifacts.length})
            </h4>
            {collab.artifacts.length === 0 ? (
              <p className="muted">No files generated in this mission.</p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {collab.artifacts.map((art) => (
                  <div
                    key={art.id}
                    style={{
                      background: "var(--nx-surface)",
                      border: "1px solid var(--nx-line)",
                      borderRadius: "6px",
                      padding: "8px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <div>
                      <strong>{art.name}</strong>
                      <div className="muted" style={{ fontSize: "0.75rem" }}>
                        {(art.sizeBytes / 1024).toFixed(1)} KB · {art.mimeType} · {art.taskKey}
                      </div>
                    </div>
                    <a
                      href={api.artifactDownloadUrl(missionId, art.uri)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="button primary"
                      style={{ fontSize: "0.75rem", padding: "2px 8px" }}
                    >
                      Open
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Adversarial debates */}
          {collab.debates.length > 0 ? (
            <div
              style={{
                background: "var(--nx-warn-bg)",
                border: "1px solid orange",
                borderRadius: "6px",
                padding: "10px",
              }}
            >
              <h4 style={{ margin: "0 0 6px 0", color: "var(--nx-warn)", fontSize: "0.95rem" }}>
                Adversarial debate detected
              </h4>
              {collab.debates.map((d) => (
                <div key={d.id} style={{ fontSize: "0.85rem" }}>
                  <p>
                    <strong>{d.issue}</strong>
                  </p>
                  <p className="muted">{d.recommendation}</p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Dynamic subtasks */}
          {collab.proposedSubtasks.length > 0 ? (
            <div>
              <h4 style={{ margin: "0 0 6px 0", fontSize: "0.95rem" }}>
                Dynamic subtasks proposed ({collab.proposedSubtasks.length})
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {collab.proposedSubtasks.map((st) => (
                  <div
                    key={st.key}
                    style={{
                      background: "var(--nx-surface)",
                      border: "1px solid var(--nx-line)",
                      borderRadius: "6px",
                      padding: "6px 10px",
                      fontSize: "0.85rem",
                    }}
                  >
                    <strong>{st.title}</strong> ({st.key}) ·{" "}
                    <span className="badge">{st.priority}</span>
                    <div className="muted">{st.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
