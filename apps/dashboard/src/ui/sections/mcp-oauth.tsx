import { useState } from "react";
import type { DashboardApi, McpOAuthProviderDto } from "../../lib/api.js";
import { useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import {
  IconCheck,
  IconClose,
  IconExternalLink,
  IconGitHub,
  IconGoogleDrive,
  IconLinear,
  IconNotion,
  IconSlack,
  IconBolt,
  IconRefresh,
} from "../icons.js";

export function McpOAuthIntegrations({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const providersState = useSection(() => api.mcpOAuthProviders());
  const [selectedProvider, setSelectedProvider] = useState<McpOAuthProviderDto | null>(null);
  const [manualClientId, setManualClientId] = useState("");
  const [manualClientSecret, setManualClientSecret] = useState("");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authState, setAuthState] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetModal = () => {
    setSelectedProvider(null);
    setManualClientId("");
    setManualClientSecret("");
    setAuthUrl(null);
    setAuthState(null);
    setAuthCode("");
    setErrorMessage(null);
  };

  const startAuthFlow = async (provider: McpOAuthProviderDto, customClientId?: string) => {
    setBusy(true);
    setErrorMessage(null);
    try {
      const authPayload: { providerId: string; clientId?: string } = { providerId: provider.id };
      if (customClientId && customClientId.trim().length > 0) {
        authPayload.clientId = customClientId.trim();
      }
      const res = await api.mcpOAuthAuthorize(authPayload);
      setAuthUrl(res.authorizationUrl);
      setAuthState(res.state);

      // Open provider's official OAuth page in popup window (Classic Claude / Codex UX)
      const popup = window.open(
        res.authorizationUrl,
        `nexus_oauth_${provider.id}`,
        "width=650,height=750,menubar=no,toolbar=no,status=no,resizable=yes,scrollbars=yes",
      );
      if (!popup || popup.closed || typeof popup.closed === "undefined") {
        // Popups might be blocked by browser; user can click the manual link in modal
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : tr("Failed to initiate OAuth flow.", "Échec du démarrage du flux OAuth."),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleConnectClick = async (provider: McpOAuthProviderDto) => {
    setSelectedProvider(provider);
    setErrorMessage(null);
    setStatusMessage(null);
    setAuthCode("");

    // If client ID is preconfigured in .env (1-Click Mode like Claude Desktop / Codex)
    if (provider.clientIdConfigured) {
      await startAuthFlow(provider);
    } else {
      setAuthUrl(null);
      setAuthState(null);
    }
  };

  const handleCompleteAuth = async () => {
    if (!selectedProvider || !authState) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      let codeToUse = authCode.trim();
      // Handle when user copies the whole redirected URL instead of just the code param
      if (codeToUse.includes("code=")) {
        try {
          const parsed = new URL(codeToUse);
          codeToUse = parsed.searchParams.get("code") ?? codeToUse;
        } catch {
          const match = /[?&]code=([^&]+)/.exec(codeToUse);
          if (match?.[1]) codeToUse = match[1];
        }
      }

      const callbackPayload: {
        providerId: string;
        code: string;
        state: string;
        clientId?: string;
        clientSecret?: string;
      } = {
        providerId: selectedProvider.id,
        code: codeToUse,
        state: authState,
      };
      if (manualClientId.trim().length > 0) callbackPayload.clientId = manualClientId.trim();
      if (manualClientSecret.trim().length > 0)
        callbackPayload.clientSecret = manualClientSecret.trim();

      await api.mcpOAuthCallback(callbackPayload);

      setStatusMessage(
        tr(
          `Successfully connected ${selectedProvider.name} to NEXUS! Server mounted & live in runtime.`,
          `${selectedProvider.name} connecté avec succès à NEXUS ! Serveur monté et actif dans le runtime.`,
        ),
      );
      resetModal();
      providersState.reload();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : tr("Authorization code exchange failed.", "Échec de l'échange du code d'autorisation."),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async (provider: McpOAuthProviderDto) => {
    if (
      !window.confirm(
        tr(
          `Disconnect ${provider.name}? This will revoke access tokens from vault and unmount the MCP server.`,
          `Déconnecter ${provider.name} ? Cela révoquera les jetons du coffre et démontera le serveur MCP.`,
        ),
      )
    ) {
      return;
    }

    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await api.mcpOAuthDisconnect(provider.id);
      setStatusMessage(tr(`${provider.name} disconnected.`, `${provider.name} déconnecté.`));
      providersState.reload();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : tr("Failed to disconnect provider.", "Échec de la déconnexion."),
      );
    } finally {
      setBusy(false);
    }
  };

  const renderProviderIcon = (id: string, size = 20) => {
    switch (id) {
      case "github":
        return <IconGitHub size={size} color="currentColor" />;
      case "slack":
        return <IconSlack size={size} color="#e01e5a" />;
      case "google-drive":
        return <IconGoogleDrive size={size} color="#34a853" />;
      case "linear":
        return <IconLinear size={size} color="#5e6ad2" />;
      case "notion":
      default:
        return <IconNotion size={size} color="currentColor" />;
    }
  };

  const providers = providersState.data?.providers ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* Intro Header */}
      <section className="settings-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h3
              style={{
                margin: 0,
                fontSize: "1.2rem",
                color: "var(--nx-signal)",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <IconBolt size={18} color="var(--nx-signal)" />
              {tr("OAuth 2.0 PKCE Integrations", "Intégrations OAuth 2.0 PKCE")}
            </h3>
            <p
              className="muted"
              style={{ margin: "6px 0 0", fontSize: "0.88rem", maxWidth: "780px" }}
            >
              {tr(
                "Connect external MCP services (GitHub, Slack, Google Drive, Linear, Notion) with 1-click OAuth like Claude Desktop and OpenAI Codex. Credentials are exchanged via RFC 7636 PKCE S256 and sealed in the NEXUS AES-256 Vault.",
                "Connectez des services MCP externes (GitHub, Slack, Google Drive, Linear, Notion) en 1 clic OAuth comme Claude Desktop et OpenAI Codex. Les identifiants sont échangés via RFC 7636 PKCE S256 et scellés dans le coffre AES-256 de NEXUS.",
              )}
            </p>
          </div>
          <button
            className="button compact"
            type="button"
            onClick={() => providersState.reload()}
            disabled={providersState.loading}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <IconRefresh size={13} />
            {providersState.loading
              ? tr("Loading...", "Chargement...")
              : tr("Refresh", "Actualiser")}
          </button>
        </div>

        {statusMessage && (
          <div className="banner success" style={{ marginTop: "1rem" }}>
            {statusMessage}
          </div>
        )}
        {errorMessage && (
          <div className="banner error" style={{ marginTop: "1rem" }}>
            {errorMessage}
          </div>
        )}
      </section>

      {/* Provider Cards Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: "1.2rem",
        }}
      >
        {providers.map((p) => {
          const isConnected = p.connected;
          return (
            <div
              key={p.id}
              className="usage-panel"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                padding: "1.25rem",
                borderRadius: "8px",
                border: isConnected ? "1px solid var(--nx-ok-line)" : "1px solid var(--nx-line)",
                background: isConnected
                  ? "linear-gradient(180deg, var(--nx-ok-bg) 0%, var(--nx-surface) 100%)"
                  : "var(--nx-surface)",
                position: "relative",
              }}
            >
              {/* Card Header */}
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.75rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    <div
                      style={{
                        width: "36px",
                        height: "36px",
                        borderRadius: "8px",
                        background: "var(--nx-surface-hover)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid var(--nx-line)",
                      }}
                    >
                      {renderProviderIcon(p.id, 20)}
                    </div>
                    <div>
                      <h4 style={{ margin: 0, fontSize: "1.05rem" }}>{p.name}</h4>
                      <span className="muted" style={{ fontSize: "0.75rem" }}>
                        MCP Turnkey Server
                      </span>
                    </div>
                  </div>

                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      padding: "3px 8px",
                      borderRadius: "12px",
                      background: isConnected ? "var(--nx-ok-bg)" : "var(--nx-surface-hover)",
                      color: isConnected ? "var(--nx-ok)" : "var(--nx-text-muted)",
                      border: `1px solid ${isConnected ? "var(--nx-ok-line)" : "var(--nx-line)"}`,
                    }}
                  >
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "50%",
                        background: isConnected ? "var(--nx-ok)" : "var(--nx-text-faint)",
                        boxShadow: isConnected
                          ? "0 0 8px color-mix(in srgb, var(--nx-ok) 70%, transparent)"
                          : "none",
                      }}
                    />
                    {isConnected ? tr("CONNECTED", "CONNECTÉ") : tr("READY", "PRÊT")}
                  </span>
                </div>

                {/* Description */}
                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--nx-text-subtle, #a0aec0)",
                    margin: "0.5rem 0 1rem",
                    lineHeight: "1.4",
                  }}
                >
                  {p.description}
                </p>

                {/* Details / Vault Reference */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.4rem",
                    fontSize: "0.75rem",
                    marginBottom: "1rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="muted">{tr("Vault Secret Ref:", "Réf secret coffre :")}</span>
                    <code style={{ fontSize: "0.75rem", color: "var(--nx-signal)" }}>
                      {p.vaultRef}
                    </code>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="muted">
                      {tr("Security Protocol:", "Protocole sécurité :")}
                    </span>
                    <span style={{ color: "var(--nx-accent)" }}>
                      {p.supportsPkce ? "RFC 7636 PKCE (S256)" : "OAuth 2.0 Bearer"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="muted">
                      {tr("Environment Setup:", "Configuration .env :")}
                    </span>
                    <span
                      style={{
                        color: p.clientIdConfigured ? "var(--nx-ok)" : "var(--nx-warn)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.25rem",
                      }}
                    >
                      {p.clientIdConfigured ? (
                        <>
                          <IconCheck size={12} color="var(--nx-ok)" />
                          {tr("1-Click Ready", "Prêt 1-Clic")}
                        </>
                      ) : (
                        tr("Manual Input", "Saisie manuelle")
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                {isConnected ? (
                  <>
                    <button
                      className="button compact secondary"
                      type="button"
                      style={{ flex: 1 }}
                      onClick={() => providersState.reload()}
                    >
                      {tr("Active & Ready", "Actif & Prêt")}
                    </button>
                    <button
                      className="button compact danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDisconnect(p)}
                    >
                      {tr("Disconnect", "Déconnecter")}
                    </button>
                  </>
                ) : (
                  <button
                    className="button compact primary"
                    type="button"
                    style={{
                      flex: 1,
                      borderColor: "var(--nx-signal)",
                      background: "color-mix(in srgb, var(--nx-signal) 12%, transparent)",
                      color: "var(--nx-signal)",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "0.4rem",
                    }}
                    onClick={() => void handleConnectClick(p)}
                  >
                    <IconBolt size={13} />
                    {tr("Connect with OAuth", "Connecter avec OAuth")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Connect Modal / Dialog (Claude / Codex Style) */}
      {selectedProvider && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "var(--nx-scrim)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "1rem",
          }}
        >
          <div
            className="settings-panel"
            style={{
              width: "100%",
              maxWidth: "540px",
              background: "var(--nx-surface-overlay)",
              border: "1px solid var(--nx-signal)",
              borderRadius: "10px",
              boxShadow: "0 8px 32px color-mix(in srgb, var(--nx-signal) 20%, transparent)",
              padding: "1.5rem",
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1.2rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <div
                  style={{
                    width: "32px",
                    height: "32px",
                    borderRadius: "6px",
                    background: "var(--nx-surface-hover)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {renderProviderIcon(selectedProvider.id, 18)}
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "1.1rem", color: "var(--nx-signal)" }}>
                    {tr(`Connect ${selectedProvider.name}`, `Connecter ${selectedProvider.name}`)}
                  </h3>
                  <span className="muted" style={{ fontSize: "0.75rem" }}>
                    RFC 7636 PKCE S256 Secure Handshake
                  </span>
                </div>
              </div>
              <button
                className="button compact"
                type="button"
                onClick={resetModal}
                style={{
                  padding: "4px 8px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                aria-label="Close"
              >
                <IconClose size={14} />
              </button>
            </div>

            {errorMessage && (
              <div className="banner error" style={{ marginBottom: "1rem" }}>
                {errorMessage}
              </div>
            )}

            {/* When authorization flow is active (Classic Claude / Codex Experience) */}
            {authUrl ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
                <div
                  style={{
                    background: "rgba(16, 185, 129, 0.08)",
                    border: "1px solid rgba(16, 185, 129, 0.3)",
                    padding: "12px 14px",
                    borderRadius: "6px",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                  }}
                >
                  <span
                    style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      background: "var(--nx-ok)",
                      boxShadow: "0 0 10px color-mix(in srgb, var(--nx-ok) 70%, transparent)",
                      animation: "pulse 2s infinite",
                    }}
                  />
                  <div style={{ fontSize: "0.85rem", color: "var(--nx-ok)" }}>
                    {tr(
                      `Authorization window launched. Sign in and grant access on ${selectedProvider.name}.`,
                      `Fenêtre d'autorisation lancée. Connectez-vous et autorisez l'accès sur ${selectedProvider.name}.`,
                    )}
                  </div>
                </div>

                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {tr("Popup blocked or closed?", "Fenêtre fermée ou bloquée ?")}
                  </span>
                  <a
                    href={authUrl}
                    target={`nexus_oauth_${selectedProvider.id}`}
                    rel="noreferrer"
                    className="button compact secondary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.3rem",
                      fontSize: "0.78rem",
                    }}
                  >
                    <IconExternalLink size={12} />
                    {tr("Reopen Authorization Window", "Rouvrir la fenêtre")}
                  </a>
                </div>

                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.4rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <span>
                    {tr(
                      "Authorization Code or Callback URL",
                      "Code d'autorisation ou URL de rappel",
                    )}
                  </span>
                  <input
                    aria-label="Authorization code or redirect URL"
                    type="text"
                    placeholder="Paste code or entire redirect URL (e.g. http://127.0.0.1:8080/api/v1/mcp/oauth/callback?code=...)"
                    value={authCode}
                    onChange={(e) => setAuthCode(e.target.value)}
                    style={{
                      background: "var(--nx-canvas-sunken)",
                      border: "1px solid var(--nx-signal)",
                      padding: "9px 12px",
                      borderRadius: "6px",
                      color: "var(--nx-text)",
                      fontFamily: "monospace",
                      fontSize: "0.82rem",
                    }}
                  />
                </label>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  <button className="button" type="button" onClick={resetModal}>
                    {tr("Cancel", "Annuler")}
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    disabled={busy || authCode.trim().length === 0}
                    onClick={() => void handleCompleteAuth()}
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                  >
                    <IconCheck size={14} />
                    {busy
                      ? tr("Exchanging PKCE Code...", "Échange du code PKCE...")
                      : tr(
                          "Complete Connection & Save to Vault",
                          "Finaliser la connexion & sceller dans le coffre",
                        )}
                  </button>
                </div>
              </div>
            ) : (
              /* Fallback only if Client ID was NOT configured in .env */
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                  {tr(
                    `NEXUS Client ID is not configured in .env for ${selectedProvider.name}. For seamless 1-click connection like Claude Desktop, add it to your .env file, or provide it below for this session:`,
                    `Le Client ID n'est pas encore configuré dans le .env pour ${selectedProvider.name}. Pour une connexion fluide en 1 clic comme Claude Desktop, ajoutez-le dans votre fichier .env, ou saisissez-le ci-dessous pour cette session :`,
                  )}
                </p>

                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.3rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <span>{tr("OAuth Client ID", "Client ID OAuth")}</span>
                  <input
                    type="text"
                    placeholder="e.g. Ov23li... or configured in .env"
                    value={manualClientId}
                    onChange={(e) => setManualClientId(e.target.value)}
                    style={{
                      background: "var(--nx-canvas-sunken)",
                      border: "1px solid var(--nx-line)",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      color: "var(--nx-text)",
                    }}
                  />
                </label>

                {!selectedProvider.supportsPkce && (
                  <label
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.3rem",
                      fontSize: "0.85rem",
                    }}
                  >
                    <span>{tr("OAuth Client Secret", "Client Secret OAuth")}</span>
                    <input
                      type="password"
                      placeholder="Required for non-PKCE confidential providers"
                      value={manualClientSecret}
                      onChange={(e) => setManualClientSecret(e.target.value)}
                      style={{
                        background: "var(--nx-canvas-sunken)",
                        border: "1px solid var(--nx-line)",
                        padding: "8px 12px",
                        borderRadius: "6px",
                        color: "var(--nx-text)",
                      }}
                    />
                  </label>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  <button className="button" type="button" onClick={resetModal}>
                    {tr("Cancel", "Annuler")}
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    disabled={busy || manualClientId.trim().length === 0}
                    onClick={() => void startAuthFlow(selectedProvider, manualClientId)}
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                  >
                    <IconExternalLink size={14} />
                    {busy
                      ? tr("Generating PKCE...", "Génération PKCE...")
                      : tr("Launch Authorization Window", "Lancer la fenêtre d'autorisation")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
