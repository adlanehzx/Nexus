import { useCallback, useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import {
  HEALTH_LABELS,
  formatAge,
  formatCount,
  overallHealth,
  sortActivity,
} from "../../lib/format.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import { Futuristic3DCanvas } from "../Futuristic3DCanvas.js";
import { Futuristic3DCard } from "../Futuristic3DCard.js";
import { Tasks } from "./tasks.js";
import { IconChevronRight } from "../icons.js";

/**
 * Supervision sections.
 *
 * Each loads its own data: a failure in one section does not take down the others,
 * and an unreachable MCP server must not clear the workers screen.
 *
 * Admin actions reuse existing business routes. Irreversible operations remain
 * explicitly confirmed; no section bypasses core permissions or validations.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Overview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Disclosure header. A real <button> so it is focusable, activates with Enter/Space,
 * and announces its state through aria-expanded.
 */
function CollapsibleHeader({
  open,
  onToggle,
  controlsId,
  expandLabel,
  collapseLabel,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controlsId: string;
  expandLabel: string;
  collapseLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="collapsible-header"
      aria-expanded={open}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      <span className="collapsible-header-title">
        <IconChevronRight size={16} className={open ? "is-open" : ""} />
        <span>{children}</span>
      </span>
      <span className="muted collapsible-header-hint">{open ? collapseLabel : expandLabel}</span>
    </button>
  );
}

export function Overview({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.overview());
  const [showTasks, setShowTasks] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [taskCounts, setTaskCounts] = useState<{ running: number; total: number } | null>(null);
  const onTaskCounts = useCallback((counts: { running: number; total: number }) => {
    setTaskCounts((previous) =>
      previous?.running === counts.running && previous.total === counts.total ? previous : counts,
    );
  }, []);

  return (
    <div className="content">
      <Section state={state}>
        {(data) => {
          const isHealthy = overallHealth(data.health) === "ok";
          const sorted = sortActivity(data.recentActivity);

          return (
            <>
              {/* 3D Holographic AI Core & Real-time HUD */}
              <div className="cyber-core-hero cyber-reticle">
                <div className="cyber-core-canvas-container">
                  <Futuristic3DCanvas />
                  <div className="cyber-core-overlay">
                    <div className="cyber-hud-column">
                      <div className="cyber-hud-stat">
                        <div className="cyber-hud-stat-label">
                          <span className="radar-pulse-ring" />
                          {tr("Cluster Workers", "Workers Connectés")}
                        </div>
                        <div className="cyber-hud-stat-value">
                          {formatCount(data.workers.connected)} {tr("active nodes", "nœuds actifs")}
                        </div>
                      </div>
                      <div className="cyber-hud-stat">
                        <div className="cyber-hud-stat-label">
                          <span className="system-dot" />
                          {tr("Tasks In Progress", "Tâches en Cours")}
                        </div>
                        <div className="cyber-hud-stat-value">
                          {formatCount(data.tasks.running)} {tr("running", "en cours")}
                        </div>
                      </div>
                    </div>

                    <div
                      className="cyber-hud-column"
                      style={{ alignItems: "flex-end", textAlign: "right" }}
                    >
                      <div className="cyber-hud-stat">
                        <div
                          className="cyber-hud-stat-label"
                          style={{ justifyContent: "flex-end" }}
                        >
                          {tr("Cluster Health", "Santé du Cluster")}
                        </div>
                        <div className="cyber-hud-stat-value">
                          {isHealthy
                            ? tr("ALL SERVICES NOMINAL", "TOUS SERVICES NOMINAUX")
                            : tr("SERVICES DEGRADED", "SERVICES DÉGRADÉS")}
                        </div>
                      </div>
                      <div className="cyber-hud-stat">
                        <div
                          className="cyber-hud-stat-label"
                          style={{ justifyContent: "flex-end" }}
                        >
                          {tr("Security Policy", "Politique de Sécurité")}
                        </div>
                        <div className="cyber-hud-stat-value">
                          {data.agentRuns.waitingForConfirmation > 0
                            ? tr("GUARDRAIL PENDING", "GARDE-FOU EN ATTENTE")
                            : tr("LOCAL ENCLAVE SECURE", "ENCLAVE LOCALE ACTIVE")}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="metrics">
                <Futuristic3DCard>
                  <Metric
                    value={formatCount(data.devices.online)}
                    label={tr("online devices", "appareils en ligne")}
                  />
                </Futuristic3DCard>
                <Futuristic3DCard>
                  <Metric
                    value={formatCount(data.workers.connected)}
                    label={tr("connected workers", "agents connectés")}
                  />
                </Futuristic3DCard>
                <Futuristic3DCard>
                  <Metric
                    value={formatCount(data.tasks.running)}
                    label={tr("running tasks", "tâches en cours")}
                  />
                </Futuristic3DCard>
                <Futuristic3DCard>
                  <Metric
                    value={formatCount(data.tasks.failed)}
                    label={tr("failed tasks", "tâches échouées")}
                    alert={data.tasks.failed > 0}
                  />
                </Futuristic3DCard>
                <Futuristic3DCard>
                  <Metric
                    value={formatCount(data.agentRuns.running)}
                    label={tr("active agent runs", "exécutions actives")}
                  />
                </Futuristic3DCard>
                <Futuristic3DCard>
                  <Metric
                    value={formatCount(data.agentRuns.waitingForConfirmation)}
                    label={tr("pending confirmation", "en attente de confirmation")}
                    alert={data.agentRuns.waitingForConfirmation > 0}
                  />
                </Futuristic3DCard>
                <Futuristic3DCard>
                  <Metric
                    value={formatCount(data.notifications.unread)}
                    label={tr("unread alerts", "alertes non lues")}
                  />
                </Futuristic3DCard>
                <Futuristic3DCard>
                  <Metric
                    value={tr(
                      HEALTH_LABELS[levelOf(overallHealth(data.health))],
                      HEALTH_LABELS[levelOf(overallHealth(data.health))] === "healthy"
                        ? "sain"
                        : HEALTH_LABELS[levelOf(overallHealth(data.health))] === "degraded"
                          ? "dégradé"
                          : HEALTH_LABELS[levelOf(overallHealth(data.health))] === "down"
                            ? "hors service"
                            : "non configuré",
                    )}
                    label={tr("overall health", "santé globale")}
                    alert={overallHealth(data.health) === "down"}
                  />
                </Futuristic3DCard>
              </div>

              <h3>{tr("Subsystem Health", "Santé des Sous-systèmes")}</h3>
              <Table
                head={[
                  tr("Subsystem", "Sous-système"),
                  tr("State", "État"),
                  tr("Detail", "Détail"),
                ]}
              >
                {data.health.map((entry) => (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td>
                      <State
                        tone={entry.level}
                        label={tr(
                          HEALTH_LABELS[entry.level],
                          entry.level === "ok"
                            ? "opérationnel"
                            : entry.level === "degraded"
                              ? "dégradé"
                              : entry.level === "down"
                                ? "hors service"
                                : "non configuré",
                        )}
                      />
                    </td>
                    <td className="muted">{entry.detail}</td>
                  </tr>
                ))}
              </Table>

              {/* Collapsible Tasks Section */}
              <div style={{ marginTop: "2rem", marginBottom: "1rem" }}>
                <CollapsibleHeader
                  open={showTasks}
                  onToggle={() => setShowTasks(!showTasks)}
                  controlsId="overview-tasks-panel"
                  expandLabel={tr("Click to expand", "Cliquer pour dérouler")}
                  collapseLabel={tr("Click to collapse", "Cliquer pour replier")}
                >
                  {tr("Tasks & Queue", "Tâches & File d'attente")}{" "}
                  <span
                    className={(taskCounts?.running ?? data.tasks.running) > 0 ? "is-live" : ""}
                  >
                    ({taskCounts?.running ?? data.tasks.running} {tr("running", "en cours")} /{" "}
                    {taskCounts?.total ?? data.tasks.total} {tr("total", "total")})
                  </span>
                </CollapsibleHeader>

                {showTasks && (
                  <div id="overview-tasks-panel" style={{ marginTop: "1rem" }}>
                    <Tasks api={api} embedded onCounts={onTaskCounts} />
                  </div>
                )}
              </div>

              {/* Collapsible Recent Activity Section */}
              <div style={{ marginTop: "2rem", marginBottom: "1.5rem" }}>
                <CollapsibleHeader
                  open={showActivity}
                  onToggle={() => setShowActivity(!showActivity)}
                  controlsId="overview-activity-panel"
                  expandLabel={tr("Click to expand", "Cliquer pour dérouler")}
                  collapseLabel={tr("Click to collapse", "Cliquer pour replier")}
                >
                  {tr("Recent Activity", "Activité Récente")} ({sorted.length})
                </CollapsibleHeader>

                {showActivity && (
                  <div id="overview-activity-panel" style={{ marginTop: "1rem" }}>
                    {sorted.length === 0 ? (
                      <Empty>{tr("Nothing to report.", "Rien à signaler.")}</Empty>
                    ) : (
                      <Table
                        head={[
                          tr("When", "Quand"),
                          tr("Source", "Source"),
                          tr("Event", "Événement"),
                        ]}
                      >
                        {sorted.map((entry, index) => (
                          <tr key={`${entry.at}-${String(index)}`}>
                            <td className="muted">{formatAge(entry.at)}</td>
                            <td>
                              <State
                                tone={entry.level === "info" ? "ok" : entry.level}
                                label={entry.kind}
                              />
                            </td>
                            <td>{entry.summary}</td>
                          </tr>
                        ))}
                      </Table>
                    )}
                  </div>
                )}
              </div>
            </>
          );
        }}
      </Section>
    </div>
  );
}

/** Overall health borrows subsystem terminology for its label. */
function levelOf(overall: ReturnType<typeof overallHealth>): keyof typeof HEALTH_LABELS {
  return overall === "unknown" ? "unconfigured" : overall;
}
