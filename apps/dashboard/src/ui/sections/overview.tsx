import type { DashboardApi } from "../../lib/api.js";
import { HEALTH_LABELS, formatAge, formatCount, overallHealth, sortActivity } from "../../lib/format.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import { Futuristic3DCanvas } from "../Futuristic3DCanvas.js";
import { Futuristic3DCard } from "../Futuristic3DCard.js";

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

export function Overview({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.overview());

  return (
    <div className="content">
      <Section state={state}>
        {(data) => (
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
                        {tr("Active Neural Mesh", "Réseau Neural Actif")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {formatCount(data.workers.connected)}{" "}
                        {tr("Workers Connected", "Agents Connectés")}
                      </div>
                    </div>
                    <div className="cyber-hud-stat">
                      <div className="cyber-hud-stat-label">
                        <span className="system-dot" />
                        {tr("Work Queue Flow", "Flux des Tâches")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {formatCount(data.tasks.running)} {tr("Running Tasks", "Tâches en Cours")}
                      </div>
                    </div>
                  </div>

                  <div
                    className="cyber-hud-column"
                    style={{ alignItems: "flex-end", textAlign: "right" }}
                  >
                    <div className="cyber-hud-stat">
                      <div className="cyber-hud-stat-label" style={{ justifyContent: "flex-end" }}>
                        <div className="hud-audio-bars">
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                        </div>
                        {tr("Singularity Core", "Cœur de Singularité")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {overallHealth(data.health) === "down"
                          ? tr("DEGRADED", "DÉGRADÉ")
                          : tr("OPERATIONAL 100%", "OPÉRATIONNEL 100%")}
                      </div>
                    </div>
                    <div className="cyber-hud-stat">
                      <div className="cyber-hud-stat-label" style={{ justifyContent: "flex-end" }}>
                        {tr("Security Grid", "Grille de Sécurité")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {tr("SHIELD ACTIVE", "BOUCLIER ACTIF")}
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
              head={[tr("Subsystem", "Sous-système"), tr("State", "État"), tr("Detail", "Détail")]}
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

            <h3>{tr("Recent Activity", "Activité Récente")}</h3>
            {data.recentActivity.length === 0 ? (
              <Empty>{tr("Nothing to report.", "Rien à signaler.")}</Empty>
            ) : (
              <Table head={[tr("When", "Quand"), tr("Source", "Source"), tr("Event", "Événement")]}>
                {sortActivity(data.recentActivity).map((entry, index) => (
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
          </>
        )}
      </Section>
    </div>
  );
}

/** Overall health borrows subsystem terminology for its label. */
function levelOf(overall: ReturnType<typeof overallHealth>): keyof typeof HEALTH_LABELS {
  return overall === "unknown" ? "unconfigured" : overall;
}
