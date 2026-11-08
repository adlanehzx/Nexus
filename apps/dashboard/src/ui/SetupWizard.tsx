import { useCallback, useEffect, useState } from "react";
import {
  ForbiddenError,
  type ConnectionCatalogEntry,
  type DashboardApi,
  type PairingTicket,
} from "../lib/api.js";
import { classifyConnection } from "../lib/format.js";
import {
  executeSmokeTest,
  SMOKE_TEST_STEP_NAMES,
  type SmokeTestExecutionResult,
} from "../lib/smoke-test.js";
import type { ServerReadiness, SessionManager } from "@nexus/client-core";
import { ThemeToggle } from "./ThemeToggle.js";
import { LanguageSwitch, useI18n } from "./i18n/index.js";
import { Futuristic3DCanvas } from "./Futuristic3DCanvas.js";
import { IconCheck, IconClose, IconWarning } from "./icons.js";
import { NexusLogo } from "./NexusLogo.js";

export type WizardStep = "prerequisites" | "admin" | "agents" | "capabilities" | "complete";

export interface SetupWizardProps {
  session: SessionManager;
  api: DashboardApi;
  onComplete: () => void;
  onSwitchToLogin: () => void;
}

export const STEP_ORDER: readonly WizardStep[] = [
  "prerequisites",
  "admin",
  "agents",
  "capabilities",
  "complete",
];

export const STEP_TITLES: Record<WizardStep, string> = {
  prerequisites: "1. System Readiness",
  admin: "2. Admin Account",
  agents: "3. Connect Agents",
  capabilities: "4. Optional Capabilities",
  complete: "5. Ready to Launch",
};

export const STEP_TITLES_FR: Record<WizardStep, string> = {
  prerequisites: "1. Prérequis Système",
  admin: "2. Compte Administrateur",
  agents: "3. Connexion Agents",
  capabilities: "4. Capacités Optionnelles",
  complete: "5. Prêt au Lancement",
};

export function getStepIndex(step: WizardStep): number {
  const idx = STEP_ORDER.indexOf(step);
  return idx >= 0 ? idx : 0;
}

export function getStepProgress(step: WizardStep): number {
  const idx = getStepIndex(step);
  return Math.round((idx / (STEP_ORDER.length - 1)) * 100);
}

export function isStepOptional(step: WizardStep): boolean {
  return step === "capabilities";
}

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

  // Step 5: Smoke test & Onboarding tour
  const [smokeTestStatus, setSmokeTestStatus] = useState<"idle" | "running" | "success" | "failed">(
    "idle",
  );
  const [smokeTestResult, setSmokeTestResult] = useState<SmokeTestExecutionResult | null>(null);
  const [testLevel, setTestLevel] = useState<1 | 2>(1);
  const [llmConsentGiven, setLlmConsentGiven] = useState(false);

  const runSmokeTest = async (): Promise<void> => {
    setSmokeTestStatus("running");
    try {
      const res = await executeSmokeTest(api, session, {
        level: testLevel,
        allowBillableRequests: testLevel === 2 ? llmConsentGiven : false,
      });
      setSmokeTestResult(res);
      setSmokeTestStatus(res.overallStatus === "passed" ? "success" : "failed");
    } catch (cause) {
      setSmokeTestStatus("failed");
      setSmokeTestResult({
        overallStatus: "failed",
        traceId: `smoke-err-${Date.now()}`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalDurationMs: 0,
        steps: [],
        error: cause instanceof Error ? cause.message : "Fatal error executing smoke test",
      });
    }
  };

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
      const isForbidden =
        cause instanceof ForbiddenError ||
        (cause instanceof Error && cause.message.includes("not accessible"));
      const msg = isForbidden
        ? tr(
            "This section requires an administrator account. Please sign in with the administrator user.",
            "Cette section nécessite un compte administrateur. Veuillez vous connecter avec le compte administrateur.",
          )
        : cause instanceof Error
          ? cause.message
          : "Agent detection failed.";
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
        try {
          await api.saveSecret("browser-worker-token", "auto-generated-remote-token");
        } catch {
          // Ignore if vault already has secret or cannot overwrite
        }
        await api.configureBrowser({
          enabled: true,
          mode: "remote-worker",
          baseUrl: remoteWorkerUrl,
          tokenRef: "vault://nexus/browser-worker-token",
        });
        setBrowserSuccessMsg(
          tr(
            "Remote browser worker saved. Connect the remote daemon to start routing.",
            "Nœud de travail distant enregistré. Démarrez le démon distant pour router.",
          ),
        );
      }
    } catch (cause) {
      const isForbidden =
        cause instanceof ForbiddenError ||
        (cause instanceof Error && cause.message.includes("not accessible"));
      const msg = isForbidden
        ? tr(
            "This configuration requires an administrator account. Please sign in with the administrator user.",
            "Cette configuration nécessite un compte administrateur. Veuillez vous connecter avec le compte administrateur.",
          )
        : cause instanceof Error
          ? cause.message
          : "Failed to configure browser.";
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
      <div className="setup-wizard-shell">
        <div className="login-brand" style={{ marginBottom: "1.5rem" }}>
          <NexusLogo size={28} style={{ marginRight: 8 }} />
          <span style={{ fontSize: "1rem", letterSpacing: "0.04em" }}>
            {tr("NEXUS · Setup Wizard", "NEXUS · Assistant d'installation")}
          </span>
          <span className="login-brand-spacer" />
          <LanguageSwitch />
          <ThemeToggle />
        </div>

        {/* Wizard progress tabs */}
        <div className="setup-wizard-tabs" role="tablist" aria-label="Setup steps">
          {STEP_ORDER.map((item, idx) => {
            const isCurrent = step === item;
            const isPassed = STEP_ORDER.indexOf(step) > idx;
            return (
              <button
                key={item}
                type="button"
                className={`setup-tab-btn ${isCurrent ? "active" : isPassed ? "passed" : ""}`}
                role="tab"
                aria-selected={isCurrent}
                disabled={!isPassed && !isCurrent}
                onClick={() => goToStep(item)}
              >
                {isPassed && <IconCheck size={12} color="var(--ok)" />}
                <span>{locale === "fr" ? STEP_TITLES_FR[item] : STEP_TITLES[item]}</span>
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
                className="setup-card"
                style={{
                  border: "1px solid var(--nx-accent)",
                  background: "var(--nx-accent-muted)",
                  marginBottom: "1.25rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "1rem",
                }}
              >
                <div>
                  <strong>
                    {tr("Administrator Account Already Created", "Compte Administrateur Déjà Créé")}
                  </strong>
                  <div className="muted" style={{ fontSize: "13px", marginTop: "4px" }}>
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
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "1rem",
                margin: "1.25rem 0 1.75rem",
              }}
            >
              <div className="setup-card">
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <strong style={{ fontSize: "0.95rem" }}>
                    {tr("PostgreSQL Database", "Base de données PostgreSQL")}
                  </strong>
                  <span
                    className={`state-pill ${readiness?.dependencies?.database?.status === "up" ? "good" : "danger"}`}
                  >
                    {readiness?.dependencies?.database?.status === "up"
                      ? tr("Connected", "Connecté")
                      : tr("Disconnected", "Déconnecté")}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: "0.8rem", marginTop: "6px" }}>
                  {tr("Latency:", "Latence :")}{" "}
                  <strong>{readiness?.dependencies?.database?.latencyMs ?? "—"} ms</strong>
                </div>
              </div>

              <div className="setup-card">
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <strong style={{ fontSize: "0.95rem" }}>
                    {tr("Redis Cache & Broker", "Cache & Broker Redis")}
                  </strong>
                  <span
                    className={`state-pill ${readiness?.dependencies?.redis?.status === "up" ? "good" : "danger"}`}
                  >
                    {readiness?.dependencies?.redis?.status === "up"
                      ? tr("Connected", "Connecté")
                      : tr("Disconnected", "Déconnecté")}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: "0.8rem", marginTop: "6px" }}>
                  {tr("Latency:", "Latence :")}{" "}
                  <strong>{readiness?.dependencies?.redis?.latencyMs ?? "—"} ms</strong>
                </div>
              </div>

              <div className="setup-card">
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <strong style={{ fontSize: "0.95rem" }}>
                    {tr("NEXUS Core API", "API Centrale NEXUS")}
                  </strong>
                  <span
                    className={`state-pill ${readiness?.status === "ok" ? "good" : readiness?.status === "degraded" ? "warning" : "danger"}`}
                  >
                    {readiness?.status ?? tr("Checking…", "Vérification en cours…")}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: "0.8rem", marginTop: "6px" }}>
                  Version: <strong>{readiness?.version ?? "1.0.0"}</strong>
                </div>
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
                onClick={() => {
                  if (alreadyInitialized) {
                    if (session.isAuthenticated) {
                      goToStep("agents");
                    } else {
                      onSwitchToLogin();
                    }
                  } else {
                    goToStep("admin");
                  }
                }}
              >
                {alreadyInitialized
                  ? session.isAuthenticated
                    ? tr("Continue Configuration", "Continuer la configuration")
                    : tr("Sign In as Administrator", "Se connecter en tant qu'administrateur")
                  : tr("Continue to Account Setup", "Continuer vers la configuration")}
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

            {alreadyInitialized ? (
              <div
                className="setup-card"
                style={{
                  border: "1px solid var(--accent, #00f0ff)",
                  background: "rgba(0, 240, 255, 0.05)",
                  padding: "1.75rem",
                  marginBottom: "1.25rem",
                  borderRadius: "8px",
                }}
              >
                <h3 style={{ color: "var(--accent, #00f0ff)", margin: "0 0 0.5rem" }}>
                  {tr("Instance already initialized", "Instance déjà initialisée")}
                </h3>
                <p
                  style={{
                    fontSize: "0.9rem",
                    color: "var(--nx-text-primary, #e6edf3)",
                    margin: "0 0 1.25rem",
                    lineHeight: "1.5",
                  }}
                >
                  {tr(
                    "An administrator account already exists on this NEXUS instance. Creating another account here would create an unprivileged user without administrative authority. Please sign in with the administrator account to configure the instance.",
                    "Un compte administrateur existe déjà sur cette instance NEXUS. Créer un autre compte ici produira un utilisateur sans privilèges administrateur (bloquant la détection d'agents et le navigateur). Veuillez vous connecter avec le compte administrateur existant.",
                  )}
                </p>
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <button type="button" className="button primary" onClick={onSwitchToLogin}>
                    {tr("Sign In Directly", "Se connecter directement")}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => goToStep("prerequisites")}
                  >
                    {tr("Back to Prerequisites", "Retour aux prérequis")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="setup-card" style={{ padding: "2rem clamp(1.25rem, 3vw, 2.25rem)" }}>
                <form
                  className="login-form"
                  onSubmit={(e) => void handleRegisterAdmin(e)}
                  style={{ gap: "1.25rem" }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: "1.25rem",
                    }}
                  >
                    <label>
                      <span style={{ fontWeight: 600, color: "var(--nx-text)" }}>
                        {tr("Full Name", "Nom complet")}
                      </span>
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
                      <span style={{ fontWeight: 600, color: "var(--nx-text)" }}>
                        {tr("Administrator Email", "E-mail administrateur")}
                      </span>
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
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: "1.25rem",
                    }}
                  >
                    <label>
                      <span style={{ fontWeight: 600, color: "var(--nx-text)" }}>
                        {tr(
                          "Password (minimum 12 characters)",
                          "Mot de passe (minimum 12 caractères)",
                        )}
                      </span>
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
                      <span style={{ fontWeight: 600, color: "var(--nx-text)" }}>
                        {tr("Confirm Password", "Confirmer le mot de passe")}
                      </span>
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
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "1rem",
                      marginTop: "1.5rem",
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
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
                      style={{ flex: 1, minWidth: "220px" }}
                    >
                      {busy
                        ? tr("Creating Account…", "Création du compte…")
                        : tr(
                            "Create Administrator & Continue",
                            "Créer l'administrateur & Continuer",
                          )}
                    </button>
                  </div>

                  <div style={{ marginTop: "1rem", textAlign: "center" }}>
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

            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {connections.map((entry) => {
                const status = classifyConnection(entry);
                const isTesting = testingProvider === entry.providerId;
                return (
                  <div key={entry.providerId} className="setup-card">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        flexWrap: "wrap",
                        gap: "12px",
                      }}
                    >
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <strong style={{ fontSize: "1rem" }}>{entry.displayName}</strong>
                          <span className={`state-pill ${status.tone}`}>{status.label}</span>
                        </div>
                        <p
                          style={{
                            margin: "6px 0 0",
                            fontSize: "13px",
                            color: "var(--muted-text)",
                          }}
                        >
                          {status.description}
                        </p>
                      </div>

                      <div style={{ display: "flex", gap: "8px" }}>
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
                          marginTop: "14px",
                          padding: "12px 16px",
                          background: "rgba(10, 18, 34, 0.8)",
                          borderRadius: "8px",
                          borderLeft: "3px solid var(--accent, #00f0ff)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "12px",
                            fontWeight: "bold",
                            marginBottom: "6px",
                            color: "var(--accent, #00f0ff)",
                          }}
                        >
                          {tr("Official Sign-in Command", "Commande officielle de connexion")}
                        </div>
                        <p style={{ margin: "0 0 8px 0", fontSize: "12px", lineHeight: 1.4 }}>
                          {tr(
                            "Run this official CLI command in your host terminal to open the provider's official browser login:",
                            "Exécutez cette commande CLI officielle dans votre terminal pour ouvrir l'authentification officielle du fournisseur :",
                          )}
                        </p>
                        <code className="setup-terminal-block">
                          {entry.providerId === "anthropic" || entry.providerId === "claude"
                            ? "claude login"
                            : entry.providerId === "codex" || entry.providerId === "openai"
                              ? "codex auth login"
                              : entry.providerId === "antigravity" || entry.providerId === "gemini"
                                ? "gemini auth login"
                                : `${entry.providerId} login`}
                        </code>
                        {entry.docsUrl && (
                          <div style={{ marginTop: "8px" }}>
                            <a
                              href={entry.docsUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                fontSize: "12px",
                                color: "var(--accent, #00f0ff)",
                                fontWeight: 600,
                              }}
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
            <div className="setup-card" style={{ marginBottom: "1.25rem" }}>
              <h3>{tr("Browser Execution", "Exécution du navigateur")}</h3>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "1rem" }}>
                {tr(
                  "Enable autonomous web browsing via CDP or dedicated container worker.",
                  "Activez la navigation web autonome via CDP ou conteneur dédié.",
                )}
              </p>

              <div
                style={{ display: "flex", gap: "1.5rem", marginBottom: "1rem", flexWrap: "wrap" }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                    fontSize: "0.88rem",
                  }}
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
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                    fontSize: "0.88rem",
                  }}
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
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                    fontSize: "0.88rem",
                  }}
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
                <label style={{ display: "block", marginBottom: "1rem" }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.8rem",
                      color: "var(--nx-text-muted)",
                      marginBottom: "4px",
                    }}
                  >
                    {tr("CDP Endpoint URL", "URL du point de terminaison CDP")}
                  </span>
                  <input
                    className="field"
                    type="url"
                    value={cdpUrl}
                    onChange={(e) => setCdpUrl(e.target.value)}
                  />
                </label>
              )}

              {browserMode === "remote-worker" && (
                <label style={{ display: "block", marginBottom: "1rem" }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.8rem",
                      color: "var(--nx-text-muted)",
                      marginBottom: "4px",
                    }}
                  >
                    {tr("Remote Worker Base URL", "URL de base du nœud distant")}
                  </span>
                  <input
                    className="field"
                    type="url"
                    value={remoteWorkerUrl}
                    onChange={(e) => setRemoteWorkerUrl(e.target.value)}
                  />
                </label>
              )}

              <div
                style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "0.5rem" }}
              >
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => void handleSaveBrowser()}
                >
                  {tr("Save Browser Mode", "Enregistrer le mode navigateur")}
                </button>
                {browserSuccessMsg && (
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--ok)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <IconCheck size={13} color="var(--ok)" />
                    <span>{browserSuccessMsg}</span>
                  </span>
                )}
              </div>
            </div>

            {/* MCP Section */}
            <div className="setup-card" style={{ marginBottom: "1.25rem" }}>
              <h3>Model Context Protocol (MCP)</h3>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "1rem" }}>
                {tr(
                  "Add local stdio tools. Sensitive variables must use vault references.",
                  "Ajoutez des outils stdio locaux. Les variables sensibles doivent utiliser des références de coffre.",
                )}
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                  gap: "1rem",
                  marginBottom: "1rem",
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
                style={{ marginBottom: "1rem" }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy || !mcpServerName.trim() || !mcpServerCommand.trim()}
                  onClick={() => void handleSaveMcp()}
                >
                  {tr("Register MCP Server", "Enregistrer le serveur MCP")}
                </button>
                {mcpSuccessMsg && (
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--ok)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <IconCheck size={13} color="var(--ok)" />
                    <span>{mcpSuccessMsg}</span>
                  </span>
                )}
              </div>
            </div>

            {/* Worker Pairing Section */}
            <div className="setup-card" style={{ marginBottom: "1.25rem" }}>
              <h3>{tr("Pair a Device or Worker", "Associer un appareil ou un travailleur")}</h3>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "1rem" }}>
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
                  style={{
                    background: "rgba(10, 18, 34, 0.8)",
                    border: "1px solid rgba(0, 240, 255, 0.2)",
                    padding: "1rem 1.25rem",
                    borderRadius: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <strong style={{ color: "var(--nx-signal, #00f0ff)" }}>
                      {tr("Pairing Ticket Generated", "Ticket d'association généré")}
                    </strong>
                    <small className="muted">
                      {tr("Expires:", "Expire à :")}{" "}
                      {new Date(workerPairingTicket.expiresAt).toLocaleTimeString()}
                    </small>
                  </div>
                  <div style={{ margin: "10px 0" }}>
                    <span className="muted" style={{ fontSize: "12px" }}>
                      {tr("One-time Token:", "Jeton à usage unique :")}
                    </span>
                    <code className="setup-terminal-block" style={{ marginTop: "4px" }}>
                      {workerPairingTicket.token}
                    </code>
                  </div>
                  <div style={{ fontSize: "12px", marginTop: "10px" }}>
                    {tr(
                      "To pair an external worker, run:",
                      "Pour associer un nœud externe, exécutez :",
                    )}
                    <code className="setup-terminal-block" style={{ marginTop: "6px" }}>
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

            <div className="setup-card" style={{ margin: "1.5rem 0" }}>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "14px",
                }}
              >
                <li
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    fontSize: "0.92rem",
                  }}
                >
                  <IconCheck size={18} color="var(--ok)" />
                  <span>
                    {tr(
                      "Core services and database healthy",
                      "Services clés et base de données sains",
                    )}
                  </span>
                </li>
                <li
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    fontSize: "0.92rem",
                  }}
                >
                  <IconCheck size={18} color="var(--ok)" />
                  <span>
                    {tr(
                      "Administrator session authenticated",
                      "Session administrateur authentifiée",
                    )}
                  </span>
                </li>
                <li
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    fontSize: "0.92rem",
                  }}
                >
                  <IconCheck size={18} color="var(--ok)" />
                  <span>
                    {tr(
                      `Discovered ${connections.length} AI CLI providers`,
                      `${connections.length} fournisseurs IA CLI découverts`,
                    )}
                  </span>
                </li>
                <li
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    fontSize: "0.92rem",
                  }}
                >
                  <IconCheck size={18} color="var(--ok)" />
                  <span>
                    {tr(
                      "Optional capabilities & worker pairing initialized",
                      "Capacités optionnelles & association de nœuds initialisées",
                    )}
                  </span>
                </li>
              </ul>
            </div>

            {/* Quick Smoke Test Mission */}
            <div
              className="setup-card"
              style={{
                marginBottom: "1.5rem",
                border: smokeTestStatus === "success" ? "1px solid var(--ok, #22c55e)" : undefined,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "1rem",
                }}
              >
                <div>
                  <strong>
                    {tr("Run Smoke Test Mission", "Lancer la mission de test rapide (Smoke Test)")}
                  </strong>
                  <div className="muted" style={{ fontSize: "0.85rem", marginTop: "4px" }}>
                    {tr(
                      "Verify system health and routing pipeline prior to launching operations.",
                      "Valider la santé système et le pipeline de routage avant le démarrage opérationnel.",
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={smokeTestStatus === "running" || (testLevel === 2 && !llmConsentGiven)}
                  onClick={() => void runSmokeTest()}
                >
                  {smokeTestStatus === "running"
                    ? tr("Testing…", "Test en cours…")
                    : smokeTestStatus === "success"
                      ? tr("Re-run Smoke Test", "Relancer le test")
                      : tr("Run Smoke Test", "Lancer le test")}
                </button>
              </div>

              {/* Tier Selection */}
              <div style={{ marginTop: "1rem", display: "grid", gap: "0.5rem" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  <input
                    type="radio"
                    name="smokeTestTier"
                    value="1"
                    checked={testLevel === 1}
                    onChange={() => setTestLevel(1)}
                  />
                  <span>
                    <strong>
                      {tr("Level 1: Zero-Cost Diagnostic", "Niveau 1 : Diagnostic sans coût")}
                    </strong>
                    {" — "}
                    <span className="muted">
                      {tr(
                        "Checks backend health, session, provider reachability and sandbox without billable API calls.",
                        "Vérifie la disponibilité backend, la session, le fournisseur et le bac à sable sans appel LLM payant.",
                      )}
                    </span>
                  </span>
                </label>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  <input
                    type="radio"
                    name="smokeTestTier"
                    value="2"
                    checked={testLevel === 2}
                    onChange={() => setTestLevel(2)}
                  />
                  <span>
                    <strong>
                      {tr("Level 2: Full Agent Core Run", "Niveau 2 : Test Agent Core complet")}
                    </strong>
                    {" — "}
                    <span className="muted">
                      {tr(
                        "Executes a real Agent Core conversation run using active model (~100 tokens).",
                        "Exécute une vraie requête Agent Core avec le modèle configuré (~100 jetons).",
                      )}
                    </span>
                  </span>
                </label>

                {testLevel === 2 && (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      padding: "0.75rem",
                      borderRadius: "6px",
                      background: "rgba(234, 179, 8, 0.1)",
                      border: "1px solid rgba(234, 179, 8, 0.3)",
                      fontSize: "0.82rem",
                    }}
                  >
                    <div
                      style={{
                        color: "var(--warning, #eab308)",
                        fontWeight: 600,
                        marginBottom: "4px",
                      }}
                    >
                      {tr(
                        "Notice: Billable API Consumption",
                        "Avertissement : Consommation API payante",
                      )}
                    </div>
                    <div className="muted" style={{ marginBottom: "8px" }}>
                      {tr(
                        "Level 2 invokes your configured LLM provider directly. Depending on your provider agreement, this will consume API credits (estimated usage: ~100 tokens).",
                        "Le Niveau 2 sollicite directement votre fournisseur LLM configuré. Selon votre abonnement ou clé API, cela consommera des crédits réels (consommation estimée : ~100 jetons).",
                      )}
                    </div>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={llmConsentGiven}
                        onChange={(e) => setLlmConsentGiven(e.target.checked)}
                      />
                      <span>
                        {tr(
                          "I understand and explicitly authorize a real billable LLM test run.",
                          "Je comprends et autorise expressément l'exécution d'un test LLM réel avec consommation de jetons.",
                        )}
                      </span>
                    </label>
                  </div>
                )}
              </div>

              {smokeTestStatus !== "idle" && (
                <div style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
                  {smokeTestResult !== null && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "0.75rem",
                        padding: "0.5rem 0.75rem",
                        borderRadius: "4px",
                        background:
                          smokeTestResult.overallStatus === "passed"
                            ? "rgba(34, 197, 94, 0.1)"
                            : "rgba(239, 68, 68, 0.1)",
                        border:
                          smokeTestResult.overallStatus === "passed"
                            ? "1px solid var(--ok, #22c55e)"
                            : "1px solid var(--danger, #ef4444)",
                      }}
                    >
                      <div>
                        <strong>
                          {smokeTestResult.overallStatus === "passed"
                            ? tr("Smoke test passed", "Test rapide réussi")
                            : tr("Smoke test failed", "Échec du test rapide")}
                        </strong>
                        <span className="muted" style={{ marginLeft: "8px" }}>
                          ({smokeTestResult.totalDurationMs} ms)
                        </span>
                      </div>
                      <code style={{ fontSize: "0.75rem" }}>{smokeTestResult.traceId}</code>
                    </div>
                  )}

                  {smokeTestResult?.steps.map((s) => {
                    const pillClass =
                      s.status === "passed"
                        ? "good"
                        : s.status === "failed"
                          ? "danger"
                          : s.status === "blocked"
                            ? "warning"
                            : "neutral";
                    const symbol =
                      s.status === "passed" ? (
                        <IconCheck size={11} />
                      ) : s.status === "failed" ? (
                        <IconClose size={11} />
                      ) : s.status === "blocked" ? (
                        <IconWarning size={11} />
                      ) : (
                        "–"
                      );
                    return (
                      <div
                        key={s.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          marginBottom: "8px",
                          padding: "4px 0",
                          borderBottom: "1px dashed rgba(255,255,255,0.05)",
                        }}
                      >
                        <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                          <span className={`state-pill ${pillClass}`}>{symbol}</span>
                          <div>
                            <div>
                              <strong>
                                {SMOKE_TEST_STEP_NAMES[s.id]?.[locale === "fr" ? "fr" : "en"] ||
                                  s.name}
                              </strong>
                              <span
                                className="muted"
                                style={{ marginLeft: "8px", fontSize: "0.75rem" }}
                              >
                                {s.durationMs} ms
                              </span>
                            </div>
                            {s.error && (
                              <div style={{ color: "var(--danger, #ef4444)", marginTop: "2px" }}>
                                {s.error}
                              </div>
                            )}
                            {s.details && (
                              <div
                                className="muted"
                                style={{ fontSize: "0.75rem", marginTop: "2px" }}
                              >
                                {s.details}
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="muted mono" style={{ fontSize: "0.7rem" }}>
                          {s.status.toUpperCase()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Guided Tour Contextual Cards */}
            <div style={{ marginBottom: "1.5rem" }}>
              <h4
                style={{
                  fontSize: "0.9rem",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginBottom: "0.75rem",
                }}
              >
                {tr("Quickstart Guided Tour", "Visite guidée de démarrage")}
              </h4>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "0.75rem",
                }}
              >
                <div className="setup-card" style={{ padding: "0.75rem" }}>
                  <strong style={{ fontSize: "0.85rem" }}>
                    {tr("1. Mission Control", "1. Mission Control")}
                  </strong>
                  <p className="muted" style={{ fontSize: "0.75rem", margin: "4px 0 0" }}>
                    {tr(
                      "Submit multi-step engineering prompts and track subagent DAG executions.",
                      "Soumettez des objectifs et suivez les DAGs multi-agents.",
                    )}
                  </p>
                </div>
                <div className="setup-card" style={{ padding: "0.75rem" }}>
                  <strong style={{ fontSize: "0.85rem" }}>
                    {tr("2. Observability", "2. Observabilité")}
                  </strong>
                  <p className="muted" style={{ fontSize: "0.75rem", margin: "4px 0 0" }}>
                    {tr(
                      "Monitor live health status matrix, latency pings, and sanitized incident logs.",
                      "Matrice de santé en temps réel et journaux assainis.",
                    )}
                  </p>
                </div>
                <div className="setup-card" style={{ padding: "0.75rem" }}>
                  <strong style={{ fontSize: "0.85rem" }}>
                    {tr("3. Usage & Quotas", "3. Usage & Quotas")}
                  </strong>
                  <p className="muted" style={{ fontSize: "0.75rem", margin: "4px 0 0" }}>
                    {tr(
                      "Live countdown timers for quota reset windows and customizable alerts.",
                      "Compte à rebours de réinitialisation et alertes de seuil.",
                    )}
                  </p>
                </div>
                <div className="setup-card" style={{ padding: "0.75rem" }}>
                  <strong style={{ fontSize: "0.85rem" }}>{tr("4. MCP Hub", "4. MCP Hub")}</strong>
                  <p className="muted" style={{ fontSize: "0.75rem", margin: "4px 0 0" }}>
                    {tr(
                      "Supervise tool permissions, SSRF-filtered remote URLs, and one-click presets.",
                      "Permissions d'outils, protection SSRF et préconfigurations.",
                    )}
                  </p>
                </div>
              </div>
            </div>

            <div style={{ marginTop: "2rem" }}>
              <button
                type="button"
                className="button primary login-submit"
                style={{ width: "100%", minHeight: "44px", fontSize: "1rem", fontWeight: 700 }}
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
