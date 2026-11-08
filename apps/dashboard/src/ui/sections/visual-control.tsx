import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Section, State, useSection } from "../parts.js";
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: vc.active ? "var(--color-success, #00e676)" : "var(--color-muted, #757575)" }} />
                <div>
                  <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                    {tr("Automation Session", "Session d'automatisation")}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                    {vc.active ? tr("Active", "Actif") : tr("Idle", "Inactif")}
                  </div>
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: vc.paused ? "var(--color-warning, #ffb300)" : (vc.active ? "var(--color-success, #00e676)" : "var(--color-muted, #757575)") }} />
                <div>
                  <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                    {tr("Execution State", "État d'exécution")}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                    {vc.paused ? tr("Paused", "En pause") : (vc.active ? tr("Running", "En cours") : tr("Ready", "Prêt"))}
                  </div>
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--color-accent, #00e5ff)" }}><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                <div>
                  <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                    {tr("Viewport Resolution", "Résolution de la vue")}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                    {vc.bounds.width && vc.bounds.height ? `${vc.bounds.width} × ${vc.bounds.height}` : tr("Awaiting feed", "En attente")}
                  </div>
                </div>
              </div>
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
