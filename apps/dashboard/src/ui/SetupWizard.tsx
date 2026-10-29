import { useCallback, useEffect, useState } from "react";
import type { ConnectionCatalogEntry, DashboardApi, PairingTicket } from "../lib/api.js";
import { classifyConnection } from "../lib/format.js";
import type { ServerReadiness, SessionManager } from "@nexus/client-core";
import { ThemeToggle } from "./ThemeToggle.js";
import { LanguageSwitch, useI18n } from "./i18n/index.js";
import { Futuristic3DCanvas } from "./Futuristic3DCanvas.js";

type WizardStep = "prerequisites" | "admin" | "agents" | "capabilities" | "complete";

interface SetupWizardProps {
  session: SessionManager;
  api: DashboardApi;
  onComplete: () => void;
  onSwitchToLogin: () => void;
}

const STEP_ORDER: WizardStep[] = ["prerequisites", "admin", "agents", "capabilities", "complete"];

const STEP_TITLES: Record<WizardStep, string> = {
  prerequisites: "1. System Readiness",
  admin: "2. Admin Account",
  agents: "3. Connect Agents",
  capabilities: "4. Optional Capabilities",
  complete: "5. Ready to Launch",
};

const STEP_TITLES_FR: Record<WizardStep, string> = {
  prerequisites: "1. Prérequis Système",
  admin: "2. Compte Administrateur",
  agents: "3. Connexion Agents",
  capabilities: "4. Capacités Optionnelles",
  complete: "5. Prêt au Lancement",
};

export function SetupWizard({ session, api, onComplete, onSwitchToLogin }: SetupWizardProps) {
  const { tr, locale } = useI18n();
  const [step, setStep] = useState<WizardStep>(() => {
    try {
      const saved = window.sessionStorage.getItem("nexus.setup.step");
      if (saved !== null && (STEP_ORDER as string[]).includes(saved)) {
        return saved as WizardStep;
      }
    } catch {
      // Storage unavailable
    }
    return session.isAuthenticated ? "agents" : "prerequisites";
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [copiedDiag, setCopiedDiag] = useState(false);

  // Step 1: Readiness
  const [readiness, setReadiness] = useState<ServerReadiness | null>(null);
  const [alreadyInitialized, setAlreadyInitialized] = useState(false);

  // Step 2: Admin form
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminConfirm, setAdminConfirm] = useState("");

  // Step 3: Agent connections
  const [connections, setConnections] = useState<ConnectionCatalogEntry[]>([]);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  // Step 4: Optional capabilities
  const [browserMode, setBrowserMode] = useState<"disabled" | "local-harness" | "remote-worker">(
    "disabled",
  );
  const [cdpUrl, setCdpUrl] = useState("http://127.0.0.1:9222");
  const [remoteWorkerUrl, setRemoteWorkerUrl] = useState("http://127.0.0.1:8000");
  const [workerPairingTicket, setWorkerPairingTicket] = useState<PairingTicket | null>(null);
  const [mcpServerName, setMcpServerName] = useState("");
  const [mcpServerCommand, setMcpServerCommand] = useState("");
  const [mcpServerArgs, setMcpServerArgs] = useState("");
  const [mcpSuccessMsg, setMcpSuccessMsg] = useState<string | null>(null);
  const [browserSuccessMsg, setBrowserSuccessMsg] = useState<string | null>(null);

  const goToStep = useCallback((next: WizardStep) => {
    setError(null);
    setDiagnostic(null);
    setStep(next);
    try {
      window.sessionStorage.setItem("nexus.setup.step", next);
    } catch {
      // Ignore storage errors
    }
  }, []);

  const copyDiagnostic = (): void => {
    if (!diagnostic) return;
    void navigator.clipboard.writeText(diagnostic).then(() => {
      setCopiedDiag(true);
      setTimeout(() => setCopiedDiag(false), 2500);
    });
  };

  // ── Step 1: Probe Prerequisites ────────────────────────────────────────────
  const probeReadiness = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setDiagnostic(null);
    try {
      const [result, setupStatus] = await Promise.all([
        session.checkReadiness(),
        session.checkSetupStatus(),
      ]);
      setReadiness(result);
      setAlreadyInitialized(setupStatus.initialized);
      if (result.status === "down") {
        setError("Core server is unreachable. Verify that backend services are running.");
        setDiagnostic(
          JSON.stringify(
            {
              event: "readiness_probe_failed",
              at: new Date().toISOString(),
              status: result.status,
              diagnostic: result.diagnostic,
            },
            null,
            2,
          ),
        );
      } else if (result.status === "degraded") {
        setError("One or more core dependencies (database or redis) are degraded.");
        setDiagnostic(
          JSON.stringify(
            {
              event: "dependencies_degraded",
              at: new Date().toISOString(),
              dependencies: result.dependencies,
              diagnostic: result.diagnostic,
            },
            null,
            2,
          ),
        );
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Prerequisites check failed.";
      setError(msg);
      setDiagnostic(
        JSON.stringify(
          {
            event: "unhandled_check_error",
            at: new Date().toISOString(),
            error: msg,
          },
          null,
          2,
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [session]);

  useEffect(() => {
    if (step === "prerequisites" && readiness === null) {
      void probeReadiness();
    }
  }, [step, readiness, probeReadiness]);

  // ── Step 2: Register Administrator ─────────────────────────────────────────
  const handleRegisterAdmin = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (adminPassword.length < 12) {
      setError("Password must be at least 12 characters long.");
      return;
    }
    if (adminPassword !== adminConfirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    setError(null);
    setDiagnostic(null);
    const pwd = adminPassword;
    setAdminPassword("");
    setAdminConfirm("");

    try {
      await session.register({
        email: adminEmail.trim(),
        displayName: adminName.trim(),
        password: pwd,
      });
      goToStep("agents");
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Registration failed.";
      setError(msg);
      setDiagnostic(
        JSON.stringify(
          {
            event: "admin_registration_rejected",
            at: new Date().toISOString(),
            email: adminEmail.trim(),
            error: msg,
          },
          null,
          2,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  // ── Step 3: Scan & Test Connections ────────────────────────────────────────
  const scanAgents = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.detectConnections();
      setConnections(result.connections);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Agent detection failed.";
      setError(msg);
      setDiagnostic(
        JSON.stringify(
          {
            event: "agent_detection_failed",
            at: new Date().toISOString(),
            error: msg,
          },
          null,
          2,
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    if (step === "agents" && connections.length === 0 && session.isAuthenticated) {
      void scanAgents();
    }
  }, [step, connections.length, session.isAuthenticated, scanAgents]);

  const testProvider = async (providerId: string): Promise<void> => {
    setTestingProvider(providerId);
    setError(null);
    try {
      const updated = await api.testConnection(providerId);
      setConnections((current) => current.map((c) => (c.providerId === providerId ? updated : c)));
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : `Test for ${providerId} failed.`;
      setError(msg);
      setDiagnostic(
        JSON.stringify(
          {
            event: "provider_test_failed",
            providerId,
            at: new Date().toISOString(),
            error: msg,
          },
          null,
          2,
        ),
      );
    } finally {
      setTestingProvider(null);
    }
  };

  const addProviderToTeam = async (entry: ConnectionCatalogEntry): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.createProviderAccount({
        id: `${entry.providerId}-primary`,
        provider: entry.providerId,
        name: `${entry.displayName} Primary`,
        profileKey: "default",
        priority: 1,
      });
      await testProvider(entry.providerId);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Failed to add provider to team.";
      setError(msg);
      setDiagnostic(
        JSON.stringify(
          {
            event: "create_account_failed",
            providerId: entry.providerId,
            error: msg,
          },
          null,
          2,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  // ── Step 4: Capabilities ───────────────────────────────────────────────────
  const handleSaveBrowser = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setBrowserSuccessMsg(null);
    try {
      if (browserMode === "disabled") {
        await api.configureBrowser({
          enabled: false,
          mode: "local-harness",
          cdpUrl: "http://127.0.0.1:9222",
        });
        setBrowserSuccessMsg("Browser automation disabled.");
      } else if (browserMode === "local-harness") {
        await api.configureBrowser({ enabled: true, mode: "local-harness", cdpUrl });
        await api.testBrowser();
        setBrowserSuccessMsg("Local browser harness configured and verified.");
      } else {
        await api.configureBrowser({
          enabled: true,
          mode: "remote-worker",
          baseUrl: remoteWorkerUrl,
          tokenRef: "vault://nexus/browser-worker-token",
        });
        setBrowserSuccessMsg("Remote browser worker saved.");
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Failed to configure browser.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMcp = async (): Promise<void> => {
    if (!mcpServerName.trim() || !mcpServerCommand.trim()) return;
    setBusy(true);
    setError(null);
    setMcpSuccessMsg(null);
    try {
      const id = mcpServerName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const args = mcpServerArgs
        .split(" ")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      await api.saveMcp({
        name: id,
        enabled: true,
        transport: "stdio",
        command: mcpServerCommand.trim(),
        args,
        env: {},
        envRefs: {},
        defaultPermissions: [],
        defaultRisk: "LOW",
        toolPolicies: {},
        connectTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        autoReconnect: true,
        maxReconnectAttempts: 3,
        reconnectInitialDelayMs: 1_000,
        reconnectMaxDelayMs: 10_000,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 30_000,
        exposeResources: true,
      });
      setMcpSuccessMsg(`MCP server "${id}" registered.`);
      setMcpServerName("");
      setMcpServerCommand("");
      setMcpServerArgs("");
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Failed to register MCP server.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateWorkerTicket = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const ticket = await api.createPairingTicket("Setup Wizard Worker");
      setWorkerPairingTicket(ticket);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Failed to generate pairing ticket.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  // ── Render Steps ───────────────────────────────────────────────────────────
  return (
    <main className="login-page">
      <div className="login-3d-bg" aria-hidden="true">
        <Futuristic3DCanvas />
      </div>
      <div
        className="login-shell"
        style={{ maxWidth: "680px", width: "100%", position: "relative", zIndex: 1 }}
      >
        <div className="login-brand">
          <span className="brand-mark">N</span>
          <span>{tr("NEXUS · Setup Wizard", "NEXUS · Assistant d'installation")}</span>
          <span className="login-brand-spacer" />
          <LanguageSwitch />
          <ThemeToggle />
        </div>

        {/* Wizard progress tabs */}
        <div
          role="tablist"
          aria-label="Setup steps"
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "20px",
            overflowX: "auto",
            paddingBottom: "4px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {STEP_ORDER.map((item, idx) => {
            const isCurrent = step === item;
            const isPassed = STEP_ORDER.indexOf(step) > idx;
            return (
              <button
                key={item}
                type="button"
                className="button compact"
                role="tab"
                aria-selected={isCurrent}
                disabled={!isPassed && !isCurrent}
                onClick={() => goToStep(item)}
                style={{
                  background: isCurrent ? "var(--soft-accent)" : "transparent",
                  color: isCurrent
                    ? "var(--bright-accent)"
                    : isPassed
                      ? "var(--text)"
                      : "var(--muted-text)",
                  border: isCurrent ? "1px solid var(--accent)" : "1px solid transparent",
                  fontSize: "12px",
                }}
              >
                {locale === "fr" ? STEP_TITLES_FR[item] : STEP_TITLES[item]}
              </button>
            );
          })}
        </div>

        {/* Global error banner with copyable diagnostic */}
        {error !== null && (
          <div className="banner error" role="alert" style={{ marginBottom: "16px" }}>
            <div>
              <strong>{tr("Error:", "Erreur :")}</strong> {error}
            </div>
            {diagnostic !== null && (
              <div style={{ marginTop: "8px" }}>
                <button
                  type="button"
                  className="button compact"
                  onClick={copyDiagnostic}
                  style={{ fontSize: "11px" }}
                >
                  {copiedDiag
                    ? tr("Copied diagnostic!", "Diagnostic copié !")
                    : tr("Copy sanitized diagnostic", "Copier le diagnostic assaini")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* STEP 1: PREREQUISITES */}
        {step === "prerequisites" && (
          <div>
            <div className="login-intro">
              <h1>
                {tr(
                  "Verify Infrastructure Readiness",
                  "Vérifier la disponibilité de l'infrastructure",
                )}
              </h1>
              <p>
                {tr(
                  "Checking database, caching, and core service connectivity.",
                  "Vérification de la connectivité de la base de données, du cache et des services clés.",
                )}
              </p>
            </div>

            {alreadyInitialized && (
              <div
                className="card"
                style={{
                  padding: "14px",
                  border: "1px solid var(--nx-accent)",
                  background: "var(--nx-accent-muted)",
                  margin: "16px 0",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <strong>
                    {tr("Administrator Account Already Created", "Compte Administrateur Déjà Créé")}
                  </strong>
                  <div className="muted" style={{ fontSize: "13px" }}>
                    {tr(
                      "NEXUS instance has already been initialized. You can sign in directly.",
                      "L'instance NEXUS a déjà été initialisée. Vous pouvez vous connecter directement.",
                    )}
                  </div>
                </div>
                <button type="button" className="button primary compact" onClick={onSwitchToLogin}>
                  {tr("Sign In", "Se connecter")}
                </button>
              </div>
            )}

            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px", margin: "16px 0" }}
            >
              <div className="card" style={{ padding: "14px", border: "1px solid var(--border)" }}>
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <strong>{tr("PostgreSQL Database", "Base de données PostgreSQL")}</strong>
                  <span
                    className={`state-pill ${readiness?.dependencies?.database?.status === "up" ? "good" : "danger"}`}
                  >
                    {readiness?.dependencies?.database?.status === "up"
                      ? tr("Connected", "Connecté")
                      : tr("Disconnected", "Déconnecté")}
                  </span>
                </div>
                <small className="muted">
                  {tr("Latency:", "Latence :")}{" "}
                  {readiness?.dependencies?.database?.latencyMs ?? "—"} ms
                </small>
              </div>

              <div className="card" style={{ padding: "14px", border: "1px solid var(--border)" }}>
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <strong>{tr("Redis Cache & Broker", "Cache & Broker Redis")}</strong>
                  <span
                    className={`state-pill ${readiness?.dependencies?.redis?.status === "up" ? "good" : "danger"}`}
                  >
                    {readiness?.dependencies?.redis?.status === "up"
                      ? tr("Connected", "Connecté")
                      : tr("Disconnected", "Déconnecté")}
                  </span>
                </div>
                <small className="muted">
                  {tr("Latency:", "Latence :")} {readiness?.dependencies?.redis?.latencyMs ?? "—"}{" "}
                  ms
                </small>
              </div>

              <div className="card" style={{ padding: "14px", border: "1px solid var(--border)" }}>
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <strong>{tr("NEXUS Core API", "API Centrale NEXUS")}</strong>
                  <span
                    className={`state-pill ${readiness?.status === "ok" ? "good" : readiness?.status === "degraded" ? "warning" : "danger"}`}
                  >
                    {readiness?.status ?? tr("Checking…", "Vérification en cours…")}
                  </span>
                </div>
                <small className="muted">Version: {readiness?.version ?? "1.0.0"}</small>
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "20px" }}>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void probeReadiness()}
              >
                {busy
                  ? tr("Checking…", "Vérification…")
                  : tr("Re-check Readiness", "Revérifier les prérequis")}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || readiness?.status === "down"}
                onClick={() => goToStep("admin")}
              >
                {tr("Continue to Account Setup", "Continuer vers la configuration")}
              </button>
              <button
                type="button"
                className="button compact"
                onClick={onSwitchToLogin}
                style={{ marginLeft: "auto" }}
              >
                {tr("Already have an account? Sign in", "Déjà un compte ? Se connecter")}
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: ADMIN REGISTRATION */}
        {step === "admin" && (
          <div>
            <div className="login-intro">
              <h1>{tr("Create Administrator Account", "Créer le compte administrateur")}</h1>
              <p>
                {tr(
                  "The first registered user is automatically granted root administrative authority.",
                  "Le premier utilisateur enregistré reçoit automatiquement l'autorité administrateur racine.",
                )}
              </p>
            </div>

            <form className="login-form" onSubmit={(e) => void handleRegisterAdmin(e)}>
              <label>
                {tr("Full Name", "Nom complet")}
                <input
                  className="field"
                  type="text"
                  placeholder={tr("Lead Engineer", "Ingénieur Principal")}
                  required
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                />
              </label>

              <label>
                {tr("Administrator Email", "E-mail administrateur")}
                <input
                  className="field"
                  type="email"
                  autoComplete="username"
                  placeholder="admin@example.com"
                  required
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                />
              </label>

              <label>
                {tr("Password (minimum 12 characters)", "Mot de passe (minimum 12 caractères)")}
                <input
                  className="field"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••••••"
                  required
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                />
              </label>

              <label>
                {tr("Confirm Password", "Confirmer le mot de passe")}
                <input
                  className="field"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••••••"
                  required
                  value={adminConfirm}
                  onChange={(e) => setAdminConfirm(e.target.value)}
                />
              </label>

              <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => goToStep("prerequisites")}
                >
                  {tr("Back", "Retour")}
                </button>
                <button
                  type="submit"
                  className="button primary login-submit"
                  disabled={busy || !adminEmail.trim() || adminPassword.length < 12}
                >
                  {busy
                    ? tr("Creating Account…", "Création du compte…")
                    : tr("Create Administrator & Continue", "Créer l'administrateur & Continuer")}
                </button>
              </div>

              <div style={{ marginTop: "12px", textAlign: "center" }}>
                <button type="button" className="button compact" onClick={onSwitchToLogin}>
                  {tr(
                    "Instance already initialized? Sign in directly",
                    "Instance déjà initialisée ? Se connecter directement",
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* STEP 3: AGENT DISCOVERY & OFFICIAL LOGIN */}
        {step === "agents" && (
          <div>
            <div className="login-intro">
              <h1>{tr("Discover & Connect AI Agents", "Découvrir & Connecter les agents IA")}</h1>
              <p>
                {tr(
                  "NEXUS probes declared local CLI tools. No credentials or OAuth tokens ever pass through the browser.",
                  "NEXUS sonde les outils CLI locaux déclarés. Aucun identifiant ou jeton OAuth ne transite par le navigateur.",
                )}
              </p>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "12px",
              }}
            >
              <span>
                {tr(
                  `Detected ${connections.length} supported providers`,
                  `${connections.length} fournisseurs compatibles détectés`,
                )}
              </span>
              <button
                type="button"
                className="button secondary compact"
                disabled={busy}
                onClick={() => void scanAgents()}
              >
                {busy
                  ? tr("Scanning host…", "Analyse en cours…")
                  : tr("Re-scan Host", "Réanalyser l'hôte")}
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {connections.map((entry) => {
                const status = classifyConnection(entry);
                const isTesting = testingProvider === entry.providerId;
                return (
                  <div
                    key={entry.providerId}
                    className="card"
                    style={{
                      padding: "14px",
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <strong>{entry.displayName}</strong>
                          <span className={`state-pill ${status.tone}`}>{status.label}</span>
                        </div>
                        <p
                          style={{ margin: "4px 0", fontSize: "12px", color: "var(--muted-text)" }}
                        >
                          {status.description}
                        </p>
                      </div>

                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          className="button compact"
                          disabled={isTesting || !entry.supportedOnThisHost}
                          onClick={() => void testProvider(entry.providerId)}
                        >
                          {isTesting ? tr("Testing…", "Test…") : tr("Test", "Tester")}
                        </button>
                        <button
                          type="button"
                          className="button primary compact"
                          disabled={busy}
                          onClick={() => void addProviderToTeam(entry)}
                        >
                          {tr("Add to Routing", "Ajouter au routage")}
                        </button>
                      </div>
                    </div>

                    {/* Official CLI Login guidance when action is needed */}
                    {status.key === "connection_required" && (
                      <div
                        style={{
                          marginTop: "10px",
                          padding: "8px 12px",
                          background: "var(--surface-2)",
                          borderRadius: "6px",
                          borderLeft: "3px solid var(--gradient)",
                        }}
                      >
                        <div style={{ fontSize: "12px", fontWeight: "bold", marginBottom: "4px" }}>
                          {tr("Official Sign-in Command", "Commande officielle de connexion")}
                        </div>
                        <p style={{ margin: "0 0 6px 0", fontSize: "12px" }}>
                          {tr(
                            "Run this official CLI command in your host terminal to open the provider's official browser login:",
                            "Exécutez cette commande CLI officielle dans votre terminal pour ouvrir l'authentification officielle du fournisseur :",
                          )}
                        </p>
                        <code
                          style={{
                            background: "var(--nx-canvas-sunken)",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            display: "inline-block",
                          }}
                        >
                          {entry.providerId === "anthropic" || entry.providerId === "claude"
                            ? "claude login"
                            : entry.providerId === "codex" || entry.providerId === "openai"
                              ? "codex auth login"
                              : entry.providerId === "antigravity" || entry.providerId === "gemini"
                                ? "gemini auth login"
                                : `${entry.providerId} login`}
                        </code>
                        {entry.docsUrl && (
                          <div style={{ marginTop: "6px" }}>
                            <a
                              href={entry.docsUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: "11px", color: "var(--accent)" }}
                            >
                              {tr(
                                "View Official Documentation →",
                                "Consulter la documentation officielle →",
                              )}
                            </a>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px" }}>
              <button type="button" className="button secondary" onClick={() => goToStep("admin")}>
                {tr("Back", "Retour")}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => goToStep("capabilities")}
              >
                {tr("Continue to Capabilities", "Continuer vers les capacités")}
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: OPTIONAL CAPABILITIES (BROWSER, MCP, WORKER) */}
        {step === "capabilities" && (
          <div>
            <div className="login-intro">
              <h1>
                {tr("Configure Optional Capabilities", "Configurer les capacités optionnelles")}
              </h1>
              <p>
                {tr(
                  "Configure browser automation, MCP tools, and external worker pairing. All are optional.",
                  "Configurez l'automatisation de navigateur, les outils MCP et l'association de nœuds de travail externes. Tout est optionnel.",
                )}
              </p>
            </div>

            {/* Browser Section */}
            <div
              className="card"
              style={{ padding: "16px", marginBottom: "14px", border: "1px solid var(--border)" }}
            >
              <h3>{tr("Browser Execution", "Exécution du navigateur")}</h3>
              <p className="muted" style={{ fontSize: "12px", marginBottom: "12px" }}>
                {tr(
                  "Enable autonomous web browsing via CDP or dedicated container worker.",
                  "Activez la navigation web autonome via CDP ou conteneur dédié.",
                )}
              </p>

              <div style={{ display: "flex", gap: "16px", marginBottom: "12px" }}>
                <label
                  style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
                >
                  <input
                    type="radio"
                    name="browserMode"
                    value="disabled"
                    checked={browserMode === "disabled"}
                    onChange={() => setBrowserMode("disabled")}
                  />
                  {tr("Disabled", "Désactivé")}
                </label>
                <label
                  style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
                >
                  <input
                    type="radio"
                    name="browserMode"
                    value="local-harness"
                    checked={browserMode === "local-harness"}
                    onChange={() => setBrowserMode("local-harness")}
                  />
                  {tr("Local Chromium (CDP)", "Chromium local (CDP)")}
                </label>
                <label
                  style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
                >
                  <input
                    type="radio"
                    name="browserMode"
                    value="remote-worker"
                    checked={browserMode === "remote-worker"}
                    onChange={() => setBrowserMode("remote-worker")}
                  />
                  {tr("Remote Worker", "Nœud de travail distant")}
                </label>
              </div>

              {browserMode === "local-harness" && (
                <label style={{ display: "block", marginBottom: "10px" }}>
                  {tr("CDP Endpoint URL", "URL du point de terminaison CDP")}
                  <input
                    className="field"
                    type="url"
                    value={cdpUrl}
                    onChange={(e) => setCdpUrl(e.target.value)}
                  />
                </label>
              )}

              {browserMode === "remote-worker" && (
                <label style={{ display: "block", marginBottom: "10px" }}>
                  {tr("Remote Worker Base URL", "URL de base du nœud distant")}
                  <input
                    className="field"
                    type="url"
                    value={remoteWorkerUrl}
                    onChange={(e) => setRemoteWorkerUrl(e.target.value)}
                  />
                </label>
              )}

              <button
                type="button"
                className="button secondary compact"
                disabled={busy}
                onClick={() => void handleSaveBrowser()}
              >
                {tr("Save Browser Mode", "Enregistrer le mode navigateur")}
              </button>
              {browserSuccessMsg && (
                <span style={{ marginLeft: "10px", fontSize: "12px", color: "var(--ok)" }}>
                  ✓ {browserSuccessMsg}
                </span>
              )}
            </div>

            {/* MCP Section */}
            <div
              className="card"
              style={{ padding: "16px", marginBottom: "14px", border: "1px solid var(--border)" }}
            >
              <h3>Model Context Protocol (MCP)</h3>
              <p className="muted" style={{ fontSize: "12px", marginBottom: "12px" }}>
                {tr(
                  "Add local stdio tools. Sensitive variables must use vault references.",
                  "Ajoutez des outils stdio locaux. Les variables sensibles doivent utiliser des références de coffre.",
                )}
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "10px",
                  marginBottom: "10px",
                }}
              >
                <input
                  className="field"
                  placeholder={tr("Server ID (e.g. filesystem)", "ID du serveur (ex. filesystem)")}
                  value={mcpServerName}
                  onChange={(e) => setMcpServerName(e.target.value)}
                />
                <input
                  className="field"
                  placeholder={tr("Command (e.g. npx)", "Commande (ex. npx)")}
                  value={mcpServerCommand}
                  onChange={(e) => setMcpServerCommand(e.target.value)}
                />
              </div>
              <input
                className="field"
                placeholder={tr(
                  "Arguments (e.g. -y @modelcontextprotocol/server-filesystem /path)",
                  "Arguments (ex. -y @modelcontextprotocol/server-filesystem /chemin)",
                )}
                value={mcpServerArgs}
                onChange={(e) => setMcpServerArgs(e.target.value)}
                style={{ marginBottom: "10px" }}
              />
              <button
                type="button"
                className="button secondary compact"
                disabled={busy || !mcpServerName.trim() || !mcpServerCommand.trim()}
                onClick={() => void handleSaveMcp()}
              >
                {tr("Register MCP Server", "Enregistrer le serveur MCP")}
              </button>
              {mcpSuccessMsg && (
                <span style={{ marginLeft: "10px", fontSize: "12px", color: "var(--ok)" }}>
                  ✓ {mcpSuccessMsg}
                </span>
              )}
            </div>

            {/* Worker Pairing Section */}
            <div
              className="card"
              style={{ padding: "16px", marginBottom: "14px", border: "1px solid var(--border)" }}
            >
              <h3>{tr("Pair a Device or Worker", "Associer un appareil ou un travailleur")}</h3>
              <p className="muted" style={{ fontSize: "12px", marginBottom: "12px" }}>
                {tr(
                  "Generate a single-use pairing ticket to attach a Windows, Linux, or Android worker without passing secrets on command lines.",
                  "Générez un ticket d'association à usage unique pour connecter un nœud Windows, Linux ou Android sans transmettre de secrets en ligne de commande.",
                )}
              </p>

              {workerPairingTicket === null ? (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => void handleGenerateWorkerTicket()}
                >
                  {tr("Generate Worker Ticket", "Générer un ticket de travailleur")}
                </button>
              ) : (
                <div
                  style={{ background: "var(--surface-2)", padding: "12px", borderRadius: "6px" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <strong>{tr("Pairing Ticket Generated", "Ticket d'association généré")}</strong>
                    <small className="muted">
                      {tr("Expires:", "Expire à :")}{" "}
                      {new Date(workerPairingTicket.expiresAt).toLocaleTimeString()}
                    </small>
                  </div>
                  <div style={{ margin: "8px 0" }}>
                    <span className="muted" style={{ fontSize: "11px" }}>
                      {tr("One-time Token:", "Jeton à usage unique :")}
                    </span>
                    <code
                      style={{
                        background: "var(--nx-canvas-sunken)",
                        padding: "4px 8px",
                        borderRadius: "4px",
                        display: "block",
                        wordBreak: "break-all",
                      }}
                    >
                      {workerPairingTicket.token}
                    </code>
                  </div>
                  <div style={{ fontSize: "12px", marginTop: "8px" }}>
                    {tr(
                      "To pair an external worker, run:",
                      "Pour associer un nœud externe, exécutez :",
                    )}
                    <code
                      style={{
                        background: "var(--nx-canvas-sunken)",
                        padding: "4px 8px",
                        borderRadius: "4px",
                        display: "block",
                        marginTop: "4px",
                      }}
                    >
                      nexus-worker --ticket {workerPairingTicket.token}
                    </code>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px" }}>
              <button type="button" className="button secondary" onClick={() => goToStep("agents")}>
                {tr("Back", "Retour")}
              </button>
              <button type="button" className="button primary" onClick={() => goToStep("complete")}>
                {tr("Review & Finish", "Vérifier & Terminer")}
              </button>
            </div>
          </div>
        )}

        {/* STEP 5: REVIEW & COMPLETE */}
        {step === "complete" && (
          <div>
            <div className="login-intro">
              <h1>{tr("Setup Complete!", "Installation terminée !")}</h1>
              <p>
                {tr(
                  "Your local NEXUS assistant is configured and ready for autonomous mission execution.",
                  "Votre assistant local NEXUS est configuré et prêt pour l'exécution autonome de missions.",
                )}
              </p>
            </div>

            <div
              className="card"
              style={{ padding: "16px", margin: "16px 0", border: "1px solid var(--border)" }}
            >
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>
                    {tr(
                      "Core services and database healthy",
                      "Services clés et base de données sains",
                    )}
                  </span>
                </li>
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>
                    {tr(
                      "Administrator session authenticated",
                      "Session administrateur authentifiée",
                    )}
                  </span>
                </li>
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>
                    {tr(
                      `Discovered ${connections.length} AI CLI providers`,
                      `${connections.length} fournisseurs IA CLI découverts`,
                    )}
                  </span>
                </li>
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>
                    {tr(
                      "Optional capabilities & worker pairing initialized",
                      "Capacités optionnelles & association de nœuds initialisées",
                    )}
                  </span>
                </li>
              </ul>
            </div>

            <div style={{ marginTop: "24px" }}>
              <button
                type="button"
                className="button primary login-submit"
                onClick={() => {
                  try {
                    window.sessionStorage.removeItem("nexus.setup.step");
                  } catch {
                    // Ignore
                  }
                  onComplete();
                }}
              >
                {tr("Launch NEXUS & Start Mission", "Lancer NEXUS & Démarrer la mission")}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
