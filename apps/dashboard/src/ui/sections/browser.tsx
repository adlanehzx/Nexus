import { useEffect, useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Section, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 8. Browser Use
// ─────────────────────────────────────────────────────────────────────────────

export function Browser({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.browser());
  const [mode, setMode] = useState<"local-harness" | "remote-worker">("local-harness");
  const [cdpUrl, setCdpUrl] = useState("http://127.0.0.1:19222");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8100");
  const [tokenRef, setTokenRef] = useState("vault://nexus/browser-worker-token");
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const configuration = state.data?.configuration;
    if (configuration === null || configuration === undefined) return;
    setMode(configuration.mode);
    if (configuration.mode === "local-harness") setCdpUrl(configuration.cdpUrl);
    else {
      setBaseUrl(configuration.baseUrl);
      setTokenRef(configuration.tokenRef);
    }
    setEnabled(configuration.enabled);
  }, [state.data]);

  const act = (operation: () => Promise<unknown>, success: string): void => {
    setActionError(null);
    setMessage(null);
    void operation()
      .then(() => {
        setMessage(success);
        state.reload();
      })
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  return (
    <div className="content">
      {message === null ? null : <p className="banner success">{message}</p>}
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="settings-panel">
        <h3>{tr("Configure Browser Use", "Configurer Browser Use")}</h3>
        <p className="muted">
          {tr(
            "Local mode uses the official harness with Codex or Claude as the brain. It requires no API keys and maintains a separate NEXUS Chromium profile.",
            "Le mode local utilise le banc officiel avec Codex ou Claude comme cerveau. Il ne requiert aucune clé d'API et maintient un profil Chromium NEXUS séparé.",
          )}
        </p>
        <div className="settings-grid">
          <label className="settings-wide">
            {tr("Mode", "Mode")}
            <select
              className="field"
              value={mode}
              onChange={(event) => setMode(event.target.value as "local-harness" | "remote-worker")}
            >
              <option value="local-harness">
                {tr("Local browser — no API key", "Navigateur local — sans clé API")}
              </option>
              <option value="remote-worker">
                {tr(
                  "Autonomous worker — LLM provider required",
                  "Agent autonome — fournisseur LLM requis",
                )}
              </option>
            </select>
          </label>
          {mode === "local-harness" ? (
            <label className="settings-wide">
              {tr("Local CDP URL", "URL CDP locale")}
              <input
                className="field mono"
                value={cdpUrl}
                onChange={(event) => setCdpUrl(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="settings-wide">
                {tr("Worker URL", "URL de l'agent")}
                <input
                  className="field mono"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label className="settings-wide">
                {tr("Token reference", "Référence du jeton")}
                <input
                  className="field mono"
                  value={tokenRef}
                  onChange={(event) => setTokenRef(event.target.value)}
                />
              </label>
            </>
          )}
          <label className="settings-wide check-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {tr("Enable Browser Use", "Activer Browser Use")}
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="button primary"
            type="button"
            onClick={() =>
              act(
                () =>
                  api.configureBrowser(
                    mode === "local-harness"
                      ? { enabled, mode, cdpUrl }
                      : { enabled, mode, baseUrl, tokenRef },
                  ),
                tr("Browser configuration saved.", "Configuration du navigateur enregistrée."),
              )
            }
          >
            {tr("Save", "Enregistrer")}
          </button>
          <button
            className="button"
            type="button"
            onClick={() =>
              act(
                () => api.testBrowser(),
                tr("Browser worker reachable.", "Agent de navigation accessible."),
              )
            }
          >
            {tr("Test", "Tester")}
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) => (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px", marginBottom: "1rem" }}>
              <div className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: data.configured ? "var(--color-success, #00e676)" : "var(--color-muted, #757575)" }} />
                <div>
                  <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                    {tr("Configuration", "Configuration")}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "1rem" }}>
                    {data.configured ? tr("Configured", "Configuré") : tr("Not configured", "Non configuré")}
                  </div>
                </div>
              </div>

              <div className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: data.reachable ? "var(--color-success, #00e676)" : (data.configured ? "var(--color-error, #ff5252)" : "var(--color-muted, #757575)") }} />
                <div>
                  <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                    {tr("Browser Status", "Statut Navigateur")}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "1rem" }}>
                    {data.reachable ? tr("Ready & Connected", "Prêt & Connecté") : (data.configured ? tr("Unreachable", "Inaccessible") : tr("Idle", "En attente"))}
                  </div>
                </div>
              </div>
            </div>

            <p className="muted" style={{ margin: "0.5rem 0" }}>{data.detail}</p>
            {data.configuration?.mode === "remote-worker" ? (
              <p className="muted">
                {tr("Secret:", "Secret :")}{" "}
                {data.tokenConfigured
                  ? tr("present in keyring", "présent dans le trousseau")
                  : tr("missing", "manquant")}
              </p>
            ) : null}

            <BrowserHealthPanel health={data.health} />
          </>
        )}
      </Section>
    </div>
  );
}

function BrowserHealthPanel({ health }: { health: unknown }) {
  const { tr } = useI18n();

  if (health === null || health === undefined) return null;

  if (typeof health !== "object") {
    return (
      <section className="card" style={{ marginTop: "1rem", padding: "16px" }}>
        <h4 style={{ margin: "0 0 12px 0", display: "flex", alignItems: "center", gap: "8px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 14 14" />
          </svg>
          {tr("Engine Diagnostics & Health", "Diagnostics & Santé du Moteur")}
        </h4>
        <span className="mono">{JSON.stringify(health)}</span>
      </section>
    );
  }

  const h = health as Record<string, unknown>;
  const daemon = h.daemon as { alive?: boolean; browser_ready?: boolean; name?: string } | undefined;
  const isHealthy = Boolean(h.healthy);
  const version = typeof h.version === "string" ? h.version : "0.1.0";
  const installMode = typeof h.install_mode === "string" ? h.install_mode : "standard";
  const chromeRunning = h.chrome_running;

  return (
    <section className="card" style={{ marginTop: "1rem", padding: "16px" }}>
      <h4 style={{ margin: "0 0 12px 0", display: "flex", alignItems: "center", gap: "8px" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 14 14" />
        </svg>
        {tr("Engine Diagnostics & Health", "Diagnostics & Santé du Moteur")}
      </h4>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
        {/* Metric 1: Global Health */}
        <div style={{ background: "rgba(255,255,255,0.03)", padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: "0.75rem", color: "var(--nx-text-muted, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {tr("Global Health", "Santé Générale")}
          </div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem", marginTop: "4px" }}>
            <span style={{ color: isHealthy ? "var(--color-success, #00e676)" : "var(--color-muted, #95a3ba)" }}>
              {isHealthy ? tr("Operational", "Opérationnel") : tr("Idle / Standby", "En attente / Inactif")}
            </span>
          </div>
        </div>

        {/* Metric 2: Daemon State */}
        <div style={{ background: "rgba(255,255,255,0.03)", padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: "0.75rem", color: "var(--nx-text-muted, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {tr("Browser Daemon", "Démon Navigateur")}
          </div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem", marginTop: "4px" }}>
            {daemon?.browser_ready ? (
              <span style={{ color: "var(--color-success, #00e676)" }}>{tr("Ready", "Prêt")}</span>
            ) : daemon?.alive ? (
              <span style={{ color: "var(--nx-signal, #00f0ff)" }}>{tr("Connected", "Connecté")}</span>
            ) : (
              <span style={{ color: "var(--color-muted, #95a3ba)" }}>{tr("Inactive", "Inactif")}</span>
            )}
            {daemon?.name ? (
              <span className="muted" style={{ fontSize: "0.8rem", marginLeft: "6px", fontWeight: 400 }}>
                ({daemon.name})
              </span>
            ) : null}
          </div>
        </div>

        {/* Metric 3: Chrome Process */}
        <div style={{ background: "rgba(255,255,255,0.03)", padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: "0.75rem", color: "var(--nx-text-muted, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {tr("Browser Instance", "Navigateur Chrome")}
          </div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem", marginTop: "4px" }}>
            {chromeRunning === true ? (
              <span style={{ color: "var(--color-success, #00e676)" }}>{tr("Running", "En cours d'exécution")}</span>
            ) : (
              <span style={{ color: "var(--color-muted, #95a3ba)" }}>{tr("Standby (starts on task)", "En veille (démarre à la tâche)")}</span>
            )}
          </div>
        </div>

        {/* Metric 4: Version & Mode */}
        <div style={{ background: "rgba(255,255,255,0.03)", padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: "0.75rem", color: "var(--nx-text-muted, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {tr("Version & Package", "Version & Package")}
          </div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem", marginTop: "4px" }}>
            <span className="mono">v{version}</span>
            <span className="muted" style={{ fontSize: "0.8rem", marginLeft: "6px", fontWeight: 400, textTransform: "uppercase" }}>
              ({installMode})
            </span>
          </div>
        </div>
      </div>

      {/* Advanced Technical Details Collapsible */}
      <details style={{ marginTop: "1rem", fontSize: "0.825rem", color: "var(--nx-text-muted, #888)" }}>
        <summary style={{ cursor: "pointer", userSelect: "none" }}>
          {tr("Technical diagnostics (raw JSON)", "Diagnostics techniques avancés (JSON brut)")}
        </summary>
        <pre
          className="mono"
          style={{
            marginTop: "0.5rem",
            padding: "10px 12px",
            background: "rgba(0, 0, 0, 0.35)",
            borderRadius: "6px",
            border: "1px solid rgba(255,255,255,0.06)",
            overflowX: "auto",
            fontSize: "0.75rem",
            lineHeight: 1.4,
          }}
        >
          {JSON.stringify(health, null, 2)}
        </pre>
      </details>
    </section>
  );
}
