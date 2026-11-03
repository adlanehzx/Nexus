import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Metric, Section, State, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 19. Phase 2: Visual Control (Claude Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function VisualControl({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.visualControlStatus());
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (op: () => Promise<unknown>) => {
    setActionError(null);
    void op()
      .then(() => state.reload())
      .catch((err: unknown) =>
        setActionError(
          err instanceof Error ? err.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(vc) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="metrics">
              <Metric
                value={vc.active ? tr("ACTIVE", "ACTIF") : tr("IDLE", "INACTIF")}
                label={tr("automation session", "session d'automatisation")}
                alert={vc.active && vc.paused}
              />
              <Metric
                value={vc.paused ? tr("PAUSED", "EN PAUSE") : tr("RUNNING", "EN COURS")}
                label={tr("execution state", "état d'exécution")}
                alert={vc.paused}
              />
              <Metric
                value={`${String(vc.bounds.width)} × ${String(vc.bounds.height)}`}
                label={tr("viewport resolution", "résolution de la vue")}
              />
            </div>

            <section className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <h3>
                    {tr("Remote Viewport & Safety Monitor", "Vue Distante & Moniteur de Sécurité")}
                  </h3>
                  <p className="muted">
                    {tr("Active Session:", "Session active :")}{" "}
                    <span className="mono">{vc.activeSessionId ?? tr("None", "Aucune")}</span>
                  </p>
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <State
                    tone={vc.safetyBoundaryEnforced ? "ok" : "down"}
                    label={
                      vc.safetyBoundaryEnforced
                        ? tr("SAFETY BOUNDARY ENFORCED", "LIMITE DE SÉCURITÉ ACTIVE")
                        : tr("UNRESTRICTED", "SANS RESTRICTION")
                    }
                  />
                  <button
                    className={`button ${vc.paused ? "primary" : "danger"}`}
                    type="button"
                    onClick={() => act(() => api.toggleVisualControlPause(!vc.paused))}
                  >
                    {vc.paused
                      ? tr("Resume Session", "Reprendre la session")
                      : tr(
                          "Pause Session (Emergency Stop)",
                          "Suspendre la session (Arrêt d'urgence)",
                        )}
                  </button>
                </div>
              </div>

              <div
                style={{
                  marginTop: "16px",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  minHeight: "240px",
                  background: "var(--nx-canvas-sunken)",
                  borderRadius: "8px",
                  border: "1px dashed var(--nx-line-strong)",
                }}
              >
                {vc.lastScreenshotUrl ? (
                  <img
                    src={vc.lastScreenshotUrl}
                    alt={tr("Live visual control preview", "Aperçu du contrôle visuel en direct")}
                    style={{ maxWidth: "100%", maxHeight: "400px", borderRadius: "4px" }}
                  />
                ) : (
                  <div className="muted" style={{ textAlign: "center" }}>
                    <span>
                      {tr(
                        "No active frame capture. Remote viewport is waiting for agent interactions.",
                        "Aucune capture d'image active. La vue distante attend les interactions de l'agent.",
                      )}
                    </span>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </Section>
    </div>
  );
}
