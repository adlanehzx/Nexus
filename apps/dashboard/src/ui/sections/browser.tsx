import { useEffect, useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Metric, Section, useSection } from "../parts.js";
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
            <div className="metrics">
              <Metric
                value={data.configured ? tr("yes", "oui") : tr("no", "non")}
                label={tr("configured", "configuré")}
              />
              <Metric
                value={data.reachable ? tr("ready", "prêt") : tr("unreachable", "inaccessible")}
                label={tr("browser", "navigateur")}
                alert={data.configured && !data.reachable}
              />
            </div>

            <p className="muted">{data.detail}</p>
            {data.configuration?.mode === "remote-worker" ? (
              <p className="muted">
                {tr("Secret:", "Secret :")}{" "}
                {data.tokenConfigured
                  ? tr("present in keyring", "présent dans le trousseau")
                  : tr("missing", "manquant")}
              </p>
            ) : null}

            {data.health === null ? null : (
              <>
                <h3>{tr("Reported Health", "Santé Rapportée")}</h3>
                <pre className="mono scroll-x" style={{ padding: 12, margin: 0 }}>
                  {JSON.stringify(data.health, null, 2)}
                </pre>
              </>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
