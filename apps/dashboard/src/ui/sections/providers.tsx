import { useEffect, useState } from "react";
import type {
  DashboardApi,
  ProviderAccountDto,
  UnifiedModelDto,
  UnifiedProviderDto,
} from "../../lib/api.js";
import { Empty, Metric, Section, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import {
  IconCheck,
  IconClock,
  IconClose,
  IconPause,
  IconPlay,
  IconPower,
  IconStar,
  IconStop,
  IconWarning,
} from "../icons.js";

export function Providers({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const providersState = useSection(() => api.unifiedProviders());
  const connections = useSection(() => api.connections());
  const accountsState = useSection(() => api.providerAccounts());
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

  // Agent accounts & emergency stop state
  const [accountActionBusy, setAccountActionBusy] = useState<string | null>(null);
  const [accountFeedback, setAccountFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [cooldownDurationSeconds, setCooldownDurationSeconds] = useState<number>(300);
  const [cooldownReason, setCooldownReason] = useState<string>("");
  const [selectedAccountIdForCooldown, setSelectedAccountIdForCooldown] = useState<string | null>(
    null,
  );
  const [accountProviderFilter, setAccountProviderFilter] = useState<string>("all");

  const handleToggleEnable = async (account: ProviderAccountDto) => {
    setAccountActionBusy(account.id);
    setAccountFeedback(null);
    try {
      if (account.enabled === false) {
        await api.enableProviderAccount(account.id);
        setAccountFeedback({
          type: "success",
          text: tr(
            `Agent account "${account.name}" enabled successfully.`,
            `Compte agent "${account.name}" activé avec succès.`,
          ),
        });
      } else {
        await api.disableProviderAccount(account.id);
        setAccountFeedback({
          type: "success",
          text: tr(
            `Agent account "${account.name}" disabled successfully.`,
            `Compte agent "${account.name}" désactivé avec succès.`,
          ),
        });
      }
      accountsState.reload();
    } catch (cause) {
      setAccountFeedback({
        type: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAccountActionBusy(null);
    }
  };

  const handleEmergencyKill = async (account: ProviderAccountDto) => {
    setAccountActionBusy(account.id);
    setAccountFeedback(null);
    try {
      await api.disableProviderAccount(account.id);
      await api.toggleProviderAccountCooldown(
        account.id,
        true,
        86400,
        "Emergency Stop: Kill switch activated by operator",
      );
      setAccountFeedback({
        type: "success",
        text: tr(
          `Emergency Stop engaged for "${account.name}". Routing halted and agent isolated.`,
          `Arrêt d'urgence déclenché pour "${account.name}". Routage suspendu et agent isolé.`,
        ),
      });
      accountsState.reload();
    } catch (cause) {
      setAccountFeedback({
        type: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAccountActionBusy(null);
    }
  };

  const handleEmergencyReset = async (account: ProviderAccountDto) => {
    setAccountActionBusy(account.id);
    setAccountFeedback(null);
    try {
      await api.toggleProviderAccountCooldown(account.id, false);
      await api.enableProviderAccount(account.id);
      setAccountFeedback({
        type: "success",
        text: tr(
          `Emergency Stop cleared for "${account.name}". Agent re-enabled.`,
          `Arrêt d'urgence réarmé pour "${account.name}". Agent réactivé.`,
        ),
      });
      accountsState.reload();
    } catch (cause) {
      setAccountFeedback({
        type: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAccountActionBusy(null);
    }
  };

  const handleTriggerCooldown = async (
    accountId: string,
    durationSeconds = 300,
    reason?: string,
  ) => {
    setAccountActionBusy(accountId);
    setAccountFeedback(null);
    try {
      const trimmed = reason?.trim();
      await api.toggleProviderAccountCooldown(
        accountId,
        true,
        durationSeconds,
        trimmed && trimmed.length > 0 ? trimmed : "Manual cooldown triggered by operator",
      );
      setAccountFeedback({
        type: "success",
        text: tr(
          `Cooldown of ${Math.round(durationSeconds / 60)} min applied.`,
          `Refroidissement de ${Math.round(durationSeconds / 60)} min appliqué.`,
        ),
      });
      setSelectedAccountIdForCooldown(null);
      accountsState.reload();
    } catch (cause) {
      setAccountFeedback({
        type: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAccountActionBusy(null);
    }
  };

  const handleClearCooldown = async (accountId: string) => {
    setAccountActionBusy(accountId);
    setAccountFeedback(null);
    try {
      await api.toggleProviderAccountCooldown(accountId, false);
      setAccountFeedback({
        type: "success",
        text: tr(`Cooldown cleared successfully.`, `Refroidissement levé avec succès.`),
      });
      accountsState.reload();
    } catch (cause) {
      setAccountFeedback({
        type: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAccountActionBusy(null);
    }
  };

  const handleEmergencyKillAll = async (accounts: ProviderAccountDto[]) => {
    const activeAccounts = accounts.filter(
      (a) => a.enabled !== false || a.cooldown?.active !== true,
    );
    if (activeAccounts.length === 0) return;
    setAccountActionBusy("all");
    setAccountFeedback(null);
    try {
      for (const acc of activeAccounts) {
        try {
          await api.disableProviderAccount(acc.id);
          await api.toggleProviderAccountCooldown(
            acc.id,
            true,
            86400,
            "Emergency Stop: Global kill switch activated",
          );
        } catch {
          // continue with next
        }
      }
      setAccountFeedback({
        type: "success",
        text: tr(
          `Global Emergency Stop engaged. All ${activeAccounts.length} agent account(s) halted.`,
          `Arrêt d'urgence global déclenché. Les ${activeAccounts.length} compte(s) agent ont été suspendus.`,
        ),
      });
      accountsState.reload();
    } finally {
      setAccountActionBusy(null);
    }
  };

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
                        ? "2px solid var(--nx-signal)"
                        : "1px solid var(--border-color, #2a2e39)",
                    borderRadius: "8px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    minWidth: 0,
                    overflow: "hidden",
                    background:
                      selectedProvider === p.id
                        ? "color-mix(in srgb, var(--nx-signal) 5%, transparent)"
                        : undefined,
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
                        background: "var(--nx-surface-hover)",
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
                      borderTop: "1px solid var(--nx-line)",
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
                        background: p.capabilities.streaming
                          ? "rgba(0, 230, 118, 0.12)"
                          : "var(--nx-surface-hover)",
                        color: p.capabilities.streaming
                          ? "var(--color-success, #00e676)"
                          : "var(--color-muted, #888)",
                      }}
                    >
                      <IconCheck size={11} color="currentColor" /> {tr("Streaming", "Streaming")}
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontSize: "0.75rem",
                        background: p.capabilities.toolCall
                          ? "rgba(0, 230, 118, 0.12)"
                          : "var(--nx-surface-hover)",
                        color: p.capabilities.toolCall
                          ? "var(--color-success, #00e676)"
                          : "var(--color-muted, #888)",
                      }}
                    >
                      <IconCheck size={11} color="currentColor" /> {tr("Tools", "Outils")}
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontSize: "0.75rem",
                        background: p.capabilities.checkpointRollback
                          ? "rgba(0, 230, 118, 0.12)"
                          : "var(--nx-surface-hover)",
                        color: p.capabilities.checkpointRollback
                          ? "var(--color-success, #00e676)"
                          : "var(--color-muted, #888)",
                      }}
                    >
                      <IconCheck size={11} color="currentColor" />{" "}
                      {tr("Checkpoints", "Points d'arrêt")}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Agent Accounts & Emergency Stop Controls (Lot 6.2) */}
            <section
              className="settings-panel"
              style={{ marginBottom: "1.5rem" }}
              data-testid="agent-emergency-controls-panel"
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                  gap: "1rem",
                  marginBottom: "1rem",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <IconStop size={18} color="#ef4444" />
                    <h3 style={{ margin: 0 }}>
                      {tr(
                        "Per-Agent Controls & Emergency Stop",
                        "Contrôles par Agent & Arrêt d'Urgence",
                      )}
                    </h3>
                  </div>
                  <p className="muted" style={{ margin: "4px 0 0 0" }}>
                    {tr(
                      "Granular execution switches, instant kill switch isolation, and cooldown regulators for all agent identities.",
                      "Interrupteurs d'exécution granulaires, coupure d'urgence immédiate et régulation du refroidissement pour toutes les identités d'agent.",
                    )}
                  </p>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <select
                    className="field"
                    value={accountProviderFilter}
                    onChange={(e) => setAccountProviderFilter(e.target.value)}
                    style={{ width: "auto" }}
                    aria-label={tr(
                      "Filter accounts by provider",
                      "Filtrer les comptes par fournisseur",
                    )}
                  >
                    <option value="all">
                      {tr("All Providers", "Tous les fournisseurs")} (
                      {accountsState.data?.accounts.length ?? 0})
                    </option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>

                  {accountsState.data?.accounts && accountsState.data.accounts.length > 0 ? (
                    <button
                      className="button danger compact"
                      type="button"
                      disabled={accountActionBusy !== null}
                      onClick={() =>
                        void handleEmergencyKillAll(accountsState.data?.accounts ?? [])
                      }
                      title={tr(
                        "Global Emergency Stop: Halt and isolate all agent accounts immediately",
                        "Arrêt d'urgence global : Stopper et isoler tous les comptes agents immédiatement",
                      )}
                      data-testid="global-kill-switch-btn"
                    >
                      <IconStop size={14} color="#ffffff" />
                      {tr("Kill All Agents", "Arrêt d'Urgence Global")}
                    </button>
                  ) : null}
                </div>
              </div>

              {accountFeedback ? (
                <div
                  className={`banner ${accountFeedback.type === "success" ? "success" : "error"}`}
                  style={{ marginBottom: "1rem" }}
                  role="alert"
                >
                  {accountFeedback.text}
                </div>
              ) : null}

              <Section state={accountsState}>
                {({ accounts }) => {
                  const filteredAccounts = accounts.filter(
                    (acc) =>
                      accountProviderFilter === "all" || acc.provider === accountProviderFilter,
                  );

                  if (filteredAccounts.length === 0) {
                    return (
                      <Empty>
                        {tr(
                          "No agent identities found for this filter.",
                          "Aucune identité d'agent trouvée pour ce filtre.",
                        )}
                      </Empty>
                    );
                  }

                  return (
                    <div className="agent-grid">
                      {filteredAccounts.map((acc) => {
                        const isBusy = accountActionBusy === acc.id || accountActionBusy === "all";
                        const isEnabled = acc.enabled !== false;
                        const isCooldown = acc.cooldown?.active ?? false;
                        const isEmergencyStopped = !isEnabled && isCooldown;
                        const isExhausted = acc.quotas?.exhausted ?? false;
                        const isAuthOk = acc.authStatus === "authenticated";

                        return (
                          <article
                            className={`agent-card ${isEmergencyStopped ? "border-danger" : ""}`}
                            key={acc.id}
                            data-testid={`agent-account-${acc.id}`}
                            data-enabled={isEnabled ? "true" : "false"}
                            data-cooldown={isCooldown ? "true" : "false"}
                            data-emergency={isEmergencyStopped ? "true" : "false"}
                          >
                            <div className="agent-card-top">
                              <div
                                className={`agent-avatar ${
                                  isEmergencyStopped
                                    ? "attention"
                                    : isEnabled && isAuthOk && !isCooldown
                                      ? "active"
                                      : "idle"
                                }`}
                              >
                                {acc.provider.slice(0, 2).toUpperCase()}
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "6px",
                                  }}
                                >
                                  <h4 style={{ margin: 0, fontSize: "0.95rem" }}>{acc.name}</h4>
                                  {acc.priority === 1 ? (
                                    <span
                                      className="state-pill good"
                                      style={{
                                        fontSize: "10px",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "3px",
                                      }}
                                    >
                                      <IconStar size={10} color="currentColor" />
                                      {tr("Primary", "Principal")}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="muted" style={{ fontSize: "11px" }}>
                                  <code>{acc.id}</code> &middot; {acc.provider} &middot; P
                                  {acc.priority}
                                </div>
                              </div>
                            </div>

                            {/* Status Badges with custom pure SVG icons */}
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: "6px",
                                margin: "10px 0",
                              }}
                              data-testid={`agent-status-badges-${acc.id}`}
                            >
                              {/* Execution status badge */}
                              {isEnabled ? (
                                <span
                                  className="state-pill good"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    fontSize: "11px",
                                  }}
                                  title={tr(
                                    "Agent is enabled for execution",
                                    "Agent activé pour exécution",
                                  )}
                                  data-status="enabled"
                                >
                                  <IconCheck size={12} color="currentColor" />
                                  {tr("Enabled", "Activé")}
                                </span>
                              ) : (
                                <span
                                  className="state-pill danger"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    fontSize: "11px",
                                  }}
                                  title={tr(
                                    "Agent is disabled from routing",
                                    "Agent désactivé du routage",
                                  )}
                                  data-status="disabled"
                                >
                                  <IconPower size={12} color="currentColor" />
                                  {tr("Disabled", "Désactivé")}
                                </span>
                              )}

                              {/* Emergency Stop badge */}
                              {isEmergencyStopped ? (
                                <span
                                  className="state-pill danger"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    fontSize: "11px",
                                    fontWeight: 700,
                                  }}
                                  title={tr("Emergency stop engaged", "Arrêt d'urgence engagé")}
                                  data-status="emergency-stop"
                                >
                                  <IconStop size={12} color="currentColor" />
                                  {tr("Emergency Stopped", "Arrêt d'Urgence")}
                                </span>
                              ) : null}

                              {/* Cooldown badge */}
                              {isCooldown ? (
                                <span
                                  className="state-pill warning"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    fontSize: "11px",
                                  }}
                                  title={
                                    acc.cooldown?.reason ??
                                    tr("Cooldown active", "Refroidissement actif")
                                  }
                                  data-status="cooldown-active"
                                >
                                  <IconClock size={12} color="currentColor" />
                                  {tr("Cooldown Active", "En Refroidissement")}
                                </span>
                              ) : (
                                <span
                                  className="state-pill neutral"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    fontSize: "11px",
                                  }}
                                  title={tr(
                                    "Normal state - no cooldown",
                                    "État normal - aucun refroidissement",
                                  )}
                                  data-status="no-cooldown"
                                >
                                  <IconPause size={12} color="currentColor" />
                                  {tr("No Cooldown", "Sans Pause")}
                                </span>
                              )}

                              {/* Auth status badge */}
                              <span
                                className={`state-pill ${
                                  isAuthOk
                                    ? "good"
                                    : acc.authStatus === "expired"
                                      ? "error"
                                      : "warning"
                                }`}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  fontSize: "11px",
                                }}
                                data-status={`auth-${acc.authStatus}`}
                              >
                                {isAuthOk ? (
                                  <IconCheck size={12} color="currentColor" />
                                ) : acc.authStatus === "expired" ? (
                                  <IconClose size={12} color="currentColor" />
                                ) : (
                                  <IconWarning size={12} color="currentColor" />
                                )}
                                {isAuthOk
                                  ? tr("Authenticated", "Authentifié")
                                  : acc.authStatus === "expired"
                                    ? tr("Auth Expired", "Auth Expirée")
                                    : tr("Unauthenticated", "Non Authentifié")}
                              </span>

                              {/* Quota warning */}
                              {isExhausted ? (
                                <span
                                  className="state-pill warning"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    fontSize: "11px",
                                  }}
                                  data-status="quota-exhausted"
                                >
                                  <IconWarning size={12} color="currentColor" />
                                  {tr("Quota Exhausted", "Quota Épuisé")}
                                </span>
                              ) : null}
                            </div>

                            {/* Reliability Stats */}
                            <div
                              className="agent-stats"
                              style={{ fontSize: "11px", marginBottom: "8px" }}
                            >
                              <span>
                                <strong>{Math.round(acc.reliability.score * 100)} %</strong>{" "}
                                {tr("reliability", "fiabilité")}
                              </span>
                              <span>
                                <strong>{acc.reliability.consecutiveFailures}</strong>{" "}
                                {tr("consec. err", "err. conséc.")}
                              </span>
                              <span>
                                <strong>{acc.reliability.totalRuns}</strong>{" "}
                                {tr("runs", "exécutions")}
                              </span>
                            </div>

                            {acc.cooldown?.reason ? (
                              <div
                                className="muted"
                                style={{
                                  fontSize: "11px",
                                  marginBottom: "8px",
                                  color: isEmergencyStopped
                                    ? "#ef4444"
                                    : "var(--color-warning, #f59e0b)",
                                }}
                              >
                                <strong>{tr("Reason:", "Raison :")}</strong> {acc.cooldown.reason}
                                {acc.cooldown.until ? (
                                  <span style={{ marginLeft: "4px" }}>
                                    (&le; {new Date(acc.cooldown.until).toLocaleTimeString()})
                                  </span>
                                ) : null}
                              </div>
                            ) : null}

                            {/* Controls: Enable/Disable, Emergency Kill Switch, Cooldown */}
                            <div
                              className="agent-card-actions"
                              style={{
                                display: "flex",
                                gap: "6px",
                                flexWrap: "wrap",
                                marginTop: "auto",
                              }}
                            >
                              {/* 1. Enable / Disable Toggle */}
                              <button
                                className={`button compact ${isEnabled ? "" : "primary"}`}
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleToggleEnable(acc)}
                                title={
                                  isEnabled
                                    ? tr(
                                        "Disable this agent identity",
                                        "Désactiver cette identité d'agent",
                                      )
                                    : tr(
                                        "Enable this agent identity",
                                        "Activer cette identité d'agent",
                                      )
                                }
                                data-testid={`agent-toggle-enable-${acc.id}`}
                              >
                                {isEnabled ? (
                                  <>
                                    <IconPower size={13} color="currentColor" />
                                    {tr("Disable", "Désactiver")}
                                  </>
                                ) : (
                                  <>
                                    <IconPlay size={13} color="currentColor" />
                                    {tr("Enable", "Activer")}
                                  </>
                                )}
                              </button>

                              {/* 2. Emergency Pause (Kill Switch) */}
                              {isEmergencyStopped ? (
                                <button
                                  className="button primary compact"
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleEmergencyReset(acc)}
                                  title={tr(
                                    "Clear emergency stop and restore agent operation",
                                    "Lever l'arrêt d'urgence et restaurer le fonctionnement de l'agent",
                                  )}
                                  data-testid={`agent-reset-emergency-${acc.id}`}
                                >
                                  <IconPlay size={13} color="currentColor" />
                                  {tr("Reset Emergency", "Réarmer")}
                                </button>
                              ) : (
                                <button
                                  className="button danger compact"
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleEmergencyKill(acc)}
                                  title={tr(
                                    "Emergency Stop: Immediately isolate and freeze this agent",
                                    "Arrêt d'Urgence : Isoler et geler immédiatement cet agent",
                                  )}
                                  data-testid={`agent-emergency-kill-${acc.id}`}
                                >
                                  <IconStop size={13} color="#ffffff" />
                                  {tr("Kill Switch", "Arrêt d'Urgence")}
                                </button>
                              )}

                              {/* 3. Cooldown Controls */}
                              {isCooldown ? (
                                <button
                                  className="button compact"
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleClearCooldown(acc.id)}
                                  title={tr(
                                    "Lift cooldown and resume availability",
                                    "Lever le refroidissement et reprendre la disponibilité",
                                  )}
                                  data-testid={`agent-clear-cooldown-${acc.id}`}
                                >
                                  <IconPlay size={13} color="currentColor" />
                                  {tr("Lift Cooldown", "Lever Pause")}
                                </button>
                              ) : (
                                <button
                                  className="button compact"
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => {
                                    if (selectedAccountIdForCooldown === acc.id) {
                                      setSelectedAccountIdForCooldown(null);
                                    } else {
                                      setSelectedAccountIdForCooldown(acc.id);
                                    }
                                  }}
                                  title={tr(
                                    "Configure cooldown pause",
                                    "Configurer la pause de refroidissement",
                                  )}
                                  data-testid={`agent-cooldown-options-${acc.id}`}
                                >
                                  <IconPause size={13} color="currentColor" />
                                  {tr("Cooldown...", "Refroidissement...")}
                                </button>
                              )}
                            </div>

                            {/* Inline Cooldown Drawer */}
                            {selectedAccountIdForCooldown === acc.id && !isCooldown ? (
                              <div
                                style={{
                                  marginTop: "8px",
                                  padding: "8px",
                                  borderRadius: "6px",
                                  background: "var(--nx-surface-hover)",
                                  border: "1px solid var(--border-color, #333)",
                                }}
                                data-testid={`agent-cooldown-panel-${acc.id}`}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    gap: "4px",
                                    marginBottom: "6px",
                                    alignItems: "center",
                                  }}
                                >
                                  <span style={{ fontSize: "11px", fontWeight: 600 }}>
                                    {tr("Duration:", "Durée :")}
                                  </span>
                                  {[
                                    { sec: 300, label: "5m" },
                                    { sec: 900, label: "15m" },
                                    { sec: 3600, label: "1h" },
                                    { sec: 86400, label: "24h" },
                                  ].map((d) => (
                                    <button
                                      key={d.sec}
                                      type="button"
                                      className={`button compact ${
                                        cooldownDurationSeconds === d.sec ? "primary" : ""
                                      }`}
                                      style={{ fontSize: "10px", padding: "2px 6px" }}
                                      onClick={() => setCooldownDurationSeconds(d.sec)}
                                    >
                                      {d.label}
                                    </button>
                                  ))}
                                </div>
                                <input
                                  aria-label={tr(
                                    "Optional reason (e.g. Rate limits, testing)",
                                    "Motif optionnel (ex. Quota dépassé, test)",
                                  )}
                                  className="field"
                                  style={{
                                    fontSize: "11px",
                                    padding: "4px 8px",
                                    marginBottom: "6px",
                                  }}
                                  placeholder={tr(
                                    "Optional reason (e.g. Rate limits, testing)",
                                    "Motif optionnel (ex. Quota dépassé, test)",
                                  )}
                                  value={cooldownReason}
                                  onChange={(e) => setCooldownReason(e.target.value)}
                                />
                                <div style={{ display: "flex", gap: "6px" }}>
                                  <button
                                    type="button"
                                    className="button primary compact"
                                    style={{ fontSize: "11px" }}
                                    disabled={isBusy}
                                    onClick={() =>
                                      void handleTriggerCooldown(
                                        acc.id,
                                        cooldownDurationSeconds,
                                        cooldownReason,
                                      )
                                    }
                                  >
                                    <IconClock size={11} color="currentColor" />
                                    {tr("Apply Cooldown", "Appliquer")}
                                  </button>
                                  <button
                                    type="button"
                                    className="button compact"
                                    style={{ fontSize: "11px" }}
                                    onClick={() => setSelectedAccountIdForCooldown(null)}
                                  >
                                    {tr("Cancel", "Annuler")}
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  );
                }}
              </Section>
            </section>

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
                  aria-label={tr(
                    `Enter API key or session token for ${selectedProvider}...`,
                    `Clé API ou token de session pour ${selectedProvider}...`,
                  )}
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
                    <span
                      className="pnl-positive"
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                    >
                      <IconCheck size={15} color="#22c55e" />
                      {tr(
                        "Credentials are valid and ready for mission execution.",
                        "Identifiants valides et prêts pour l'exécution de missions.",
                      )}
                    </span>
                  ) : (
                    <span
                      className="pnl-negative"
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                    >
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
