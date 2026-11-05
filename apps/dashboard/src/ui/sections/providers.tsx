import { useState } from "react";
import type { DashboardApi, UnifiedModelDto, UnifiedProviderDto } from "../../lib/api.js";
import { Empty, Metric, Section, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

export function Providers({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const providersState = useSection(() => api.unifiedProviders());
  const connections = useSection(() => api.connections());
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const installed = (connections.data?.connections ?? []).filter(
    (entry) =>
      entry.observation !== null &&
      entry.observation.state !== "not_installed" &&
      entry.observation.state !== "error",
  );

  const detect = async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      await api.detectConnections();
      connections.reload();
    } catch (cause) {
      setDetectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetecting(false);
    }
  };

  const [selectedProvider, setSelectedProvider] = useState<string>("claude");
  const modelsState = useSection(
    () => api.unifiedProviderModels(selectedProvider),
    [selectedProvider],
  );

  // Credential test state
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTestCredentials = async () => {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.validateProviderCredentials(selectedProvider, {
        apiKey: apiKey.trim(),
      });
      setTestResult(res);
    } catch (e) {
      setTestResult({ valid: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="content">
      <p className="muted" style={{ marginTop: 0 }}>
        {tr(
          "Engines known to NEXUS. The capabilities shown are those each driver declares; a live check is what proves a connection.",
          "Moteurs connus de NEXUS. Les capacités affichées sont celles déclarées par chaque driver ; seule une vérification réelle prouve une connexion.",
        )}
      </p>

      <Section state={providersState}>
        {({ providers }) => (
          <>
            <div className="metrics" style={{ marginBottom: "1.5rem" }}>
              <Metric
                value={String(providers.length)}
                label={tr("registered drivers", "drivers enregistrés")}
              />
              <Metric
                value={
                  connections.data === undefined
                    ? tr("Unavailable", "Indisponible")
                    : String(installed.length)
                }
                label={tr("CLIs detected on this host", "CLI détectés sur cet hôte")}
              />
              <Metric
                value={
                  connections.data === undefined
                    ? tr("Unavailable", "Indisponible")
                    : String(installed.filter((c) => c.observation?.state === "connected").length)
                }
                label={tr("verified connections", "connexions vérifiées")}
              />
            </div>

            <section className="settings-panel" style={{ marginBottom: "1.5rem" }}>
              <h3>{tr("Status on this host", "État sur cet hôte")}</h3>
              <p className="muted">
                {tr(
                  "An installed CLI is not a connected account: only a successful check shows “connected”.",
                  "Un CLI installé n’est pas un compte connecté : seule une vérification réussie affiche « connecté ».",
                )}
              </p>
              <button
                className="button compact"
                type="button"
                disabled={detecting}
                onClick={() => void detect()}
              >
                {detecting
                  ? tr("Scanning…", "Analyse…")
                  : tr("Detect installed CLIs", "Détecter les CLI installés")}
              </button>
              {detectError === null ? null : (
                <div className="banner error" role="alert">
                  {detectError}
                </div>
              )}
              <Section state={connections}>
                {({ connections: entries }) => (
                  <Table
                    head={[
                      tr("Engine", "Moteur"),
                      tr("State", "État"),
                      tr("Version", "Version"),
                      tr("Last check", "Dernière vérification"),
                    ]}
                  >
                    {entries.map((entry) => (
                      <tr key={entry.providerId} data-provider={entry.providerId}>
                        <td>{entry.displayName}</td>
                        <td>
                          {entry.observation === null
                            ? tr("Not checked", "Non vérifié")
                            : entry.observation.state}
                          {entry.observation?.userMessage == null ? null : (
                            <div className="muted">{entry.observation.userMessage}</div>
                          )}
                        </td>
                        <td className="mono">
                          {entry.observation?.version ?? tr("Unavailable", "Indisponible")}
                        </td>
                        <td>
                          {entry.observation?.lastCheckedAt == null
                            ? tr("Never", "Jamais")
                            : new Date(entry.observation.lastCheckedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Section>
            </section>

            {/* Providers Grid */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: "1rem",
                marginBottom: "1.5rem",
              }}
            >
              {providers.map((p: UnifiedProviderDto) => (
                <div
                  key={p.id}
                  className={`card ${selectedProvider === p.id ? "active-border" : ""}`}
                  style={{
                    cursor: "pointer",
                    padding: "1rem",
                    border:
                      selectedProvider === p.id
                        ? "2px solid var(--accent-color, #00d2ff)"
                        : "1px solid var(--border-color, #2a2e39)",
                    borderRadius: "8px",
                  }}
                  onClick={() => {
                    setSelectedProvider(p.id);
                    setTestResult(null);
                    setApiKey("");
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <h4>{p.displayName}</h4>
                    <span className="badge">{p.id.toUpperCase()}</span>
                  </div>
                  <div style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
                    <div>
                      ⚡ <strong>Streaming:</strong> {p.capabilities.streaming ? "Oui" : "Non"}
                    </div>
                    <div>
                      🛠️ <strong>Tool Calling:</strong> {p.capabilities.toolCall ? "Oui" : "Non"}
                    </div>
                    <div>
                      ⏪ <strong>Checkpoints:</strong>{" "}
                      {p.capabilities.checkpointRollback ? "Oui" : "Non"}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Credential Testing & Configuration Box */}
            <section className="settings-panel" style={{ marginBottom: "1.5rem" }}>
              <h3>
                {tr(
                  "Configure & Test Driver Credentials",
                  "Configurer & Tester les Identifiants du Driver",
                )}{" "}
                : <code>{selectedProvider}</code>
              </h3>
              <div
                style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}
              >
                <input
                  type="password"
                  placeholder={tr(
                    `Enter API key or session token for ${selectedProvider}...`,
                    `Clé API ou token de session pour ${selectedProvider}...`,
                  )}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  style={{ flex: 1, minWidth: "260px" }}
                />
                <button
                  type="button"
                  className="button primary"
                  disabled={testing || !apiKey.trim()}
                  onClick={() => {
                    void handleTestCredentials();
                  }}
                >
                  {testing
                    ? tr("Testing...", "Test en cours...")
                    : tr("Validate Credentials", "Valider les Identifiants")}
                </button>
              </div>

              {testResult && (
                <div style={{ marginTop: "0.75rem" }}>
                  {testResult.valid ? (
                    <span className="pnl-positive">
                      ✅{" "}
                      {tr(
                        "Credentials are valid and ready for mission execution.",
                        "Identifiants valides et prêts pour l'exécution de missions.",
                      )}
                    </span>
                  ) : (
                    <span className="pnl-negative">
                      ❌{" "}
                      {tr(
                        `Validation failed: ${testResult.error ?? "Invalid key"}`,
                        `Échec de validation : ${testResult.error ?? "Clé invalide"}`,
                      )}
                    </span>
                  )}
                </div>
              )}
            </section>

            {/* Provider Models Table */}
            <h3>
              {tr(
                `Available Models for ${selectedProvider}`,
                `Modèles Disponibles pour ${selectedProvider}`,
              )}
            </h3>
            <Section state={modelsState}>
              {({ models }) => (
                <>
                  {models.length === 0 ? (
                    <Empty>
                      {tr(
                        "No models registered for this provider.",
                        "Aucun modèle enregistré pour ce fournisseur.",
                      )}
                    </Empty>
                  ) : (
                    <Table
                      head={[
                        tr("Model ID", "ID du Modèle"),
                        tr("Display Name", "Nom"),
                        tr("Context Window", "Fenêtre de Contexte"),
                        tr("Max Tokens", "Max Tokens"),
                      ]}
                    >
                      {models.map((m: UnifiedModelDto) => {
                        const modelIdentifier = m.id ?? m.modelId ?? "";
                        const maxTokenCount = m.maxOutputTokens ?? m.maxTokens;
                        return (
                          <tr key={modelIdentifier}>
                            <td>
                              <code>{modelIdentifier}</code>
                            </td>
                            <td>
                              <strong>{m.displayName}</strong>
                            </td>
                            <td>
                              {m.contextWindow != null
                                ? `${m.contextWindow.toLocaleString()} tokens`
                                : "-"}
                            </td>
                            <td>
                              {maxTokenCount != null
                                ? `${maxTokenCount.toLocaleString()} tokens`
                                : "-"}
                            </td>
                          </tr>
                        );
                      })}
                    </Table>
                  )}
                </>
              )}
            </Section>
          </>
        )}
      </Section>
    </div>
  );
}
