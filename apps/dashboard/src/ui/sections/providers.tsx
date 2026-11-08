import { useEffect, useState } from "react";
import type { DashboardApi, UnifiedModelDto, UnifiedProviderDto } from "../../lib/api.js";
import { Empty, Metric, Section, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import { IconCheck, IconClose } from "../icons.js";

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

  useEffect(() => {
    if (connections.data?.connections && connections.data.connections.length > 0) {
      const allUnchecked = connections.data.connections.every((c) => c.observation === null);
      if (allUnchecked && !detecting) {
        void detect();
      }
    }
  }, [connections.data]);

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
                label={tr("accounts signed in", "comptes connectés")}
              />
            </div>

            <section className="settings-panel" style={{ marginBottom: "1.5rem" }}>
              <h3>{tr("Status on this host", "État sur cet hôte")}</h3>
              <p className="muted">
                {tr(
                  "An installed CLI is not a connected account. “Signed in” is what the CLI itself reports, read locally without using quota; it does not prove a model call would succeed.",
                  "Un CLI installé n’est pas un compte connecté. « Connecté au compte » est ce que le CLI déclare lui-même, lu localement sans consommer de quota ; cela ne prouve pas qu’un appel au modèle réussirait.",
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
                      tr("Signed in", "Connecté au compte"),
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
                        <td data-auth={entry.observation?.authStatus ?? "unknown"}>
                          {
                            {
                              authenticated: tr("Yes", "Oui"),
                              unauthenticated: tr("No", "Non"),
                              expired: tr("Expired", "Expiré"),
                              unknown: tr("Unknown", "Inconnu"),
                            }[entry.observation?.authStatus ?? "unknown"]
                          }
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
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
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
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    minWidth: 0,
                    overflow: "hidden",
                    background: selectedProvider === p.id ? "rgba(0, 210, 255, 0.05)" : undefined,
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
                      alignItems: "flex-start",
                      gap: "8px",
                      marginBottom: "0.75rem",
                      minWidth: 0,
                    }}
                  >
                    <h4
                      style={{
                        margin: 0,
                        fontSize: "0.95rem",
                        fontWeight: 600,
                        lineHeight: 1.35,
                        wordBreak: "break-word",
                        overflowWrap: "anywhere",
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {p.displayName}
                    </h4>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: "0.65rem",
                        padding: "2px 6px",
                        letterSpacing: "0.05em",
                        borderRadius: "4px",
                        background: "var(--color-bg-subtle, rgba(255, 255, 255, 0.08))",
                        color: "var(--color-muted, #aaa)",
                        fontWeight: 600,
                        border: "1px solid var(--border-color, #333)",
                      }}
                    >
                      {p.id.toUpperCase()}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px",
                      fontSize: "0.8rem",
                      marginTop: "auto",
                      paddingTop: "0.6rem",
                      borderTop: "1px solid var(--border-color, rgba(255, 255, 255, 0.06))",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontSize: "0.75rem",
                        background: p.capabilities.streaming ? "rgba(0, 230, 118, 0.12)" : "rgba(255, 255, 255, 0.05)",
                        color: p.capabilities.streaming ? "var(--color-success, #00e676)" : "var(--color-muted, #888)",
                      }}
                    >
                      ● {tr("Streaming", "Streaming")}
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontSize: "0.75rem",
                        background: p.capabilities.toolCall ? "rgba(0, 230, 118, 0.12)" : "rgba(255, 255, 255, 0.05)",
                        color: p.capabilities.toolCall ? "var(--color-success, #00e676)" : "var(--color-muted, #888)",
                      }}
                    >
                      ● {tr("Tools", "Outils")}
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontSize: "0.75rem",
                        background: p.capabilities.checkpointRollback ? "rgba(0, 230, 118, 0.12)" : "rgba(255, 255, 255, 0.05)",
                        color: p.capabilities.checkpointRollback ? "var(--color-success, #00e676)" : "var(--color-muted, #888)",
                      }}
                    >
                      ● {tr("Checkpoints", "Points d'arrêt")}
                    </span>
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
                    <span className="pnl-positive" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                      <IconCheck size={15} color="#22c55e" />
                      {tr(
                        "Credentials are valid and ready for mission execution.",
                        "Identifiants valides et prêts pour l'exécution de missions.",
                      )}
                    </span>
                  ) : (
                    <span className="pnl-negative" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                      <IconClose size={15} color="#ef4444" />
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
