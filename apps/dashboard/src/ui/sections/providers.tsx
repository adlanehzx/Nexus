import { useState } from "react";
import type { DashboardApi, UnifiedModelDto, UnifiedProviderDto } from "../../lib/api.js";
import { Empty, Metric, Section, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

export function Providers({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const providersState = useSection(() => api.unifiedProviders());

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
          "Unified LLM & Agent drivers fused from T3 Code into NEXUS. Every provider supports pre-execution tool safety policies, session checkpoint rollbacks, and streaming.",
          "Drivers LLM & Agents unifiés fusionnés de T3 Code dans NEXUS. Tous les providers supportent la politique de sécurité pré-exécution, les rollbacks de checkpoints et le streaming.",
        )}
      </p>

      <Section state={providersState}>
        {({ providers }) => (
          <>
            <div className="metrics" style={{ marginBottom: "1.5rem" }}>
              <Metric
                value={String(providers.length)}
                label={tr("unified drivers", "drivers unifiés")}
              />
              <Metric
                value="4"
                label={tr(
                  "active engines (Claude, Cursor, Grok, ACP)",
                  "moteurs actifs (Claude, Cursor, Grok, ACP)",
                )}
                tone="positive"
              />
              <Metric
                value="100%"
                label={tr("pre-call security coverage", "couverture sécurité pré-exécution")}
                tone="positive"
              />
            </div>

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
