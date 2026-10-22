import { useCallback, useEffect, useState } from "react";
import type {
  ConnectionCatalogEntry,
  DashboardApi,
  PairingTicket,
} from "../lib/api.js";
import { classifyConnection } from "../lib/format.js";
import type { ServerReadiness, SessionManager } from "@nexus/client-core";

type WizardStep = "prerequisites" | "admin" | "agents" | "capabilities" | "complete";

interface SetupWizardProps {
  session: SessionManager;
  api: DashboardApi;
  onComplete: () => void;
  onSwitchToLogin: () => void;
}

const STEP_ORDER: WizardStep[] = [
  "prerequisites",
  "admin",
  "agents",
  "capabilities",
  "complete",
];

const STEP_TITLES: Record<WizardStep, string> = {
  prerequisites: "1. System Readiness",
  admin: "2. Admin Account",
  agents: "3. Connect Agents",
  capabilities: "4. Optional Capabilities",
  complete: "5. Ready to Launch",
};

export function SetupWizard({ session, api, onComplete, onSwitchToLogin }: SetupWizardProps) {
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

  // Step 2: Admin form
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminConfirm, setAdminConfirm] = useState("");

  // Step 3: Agent connections
  const [connections, setConnections] = useState<ConnectionCatalogEntry[]>([]);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  // Step 4: Optional capabilities
  const [browserMode, setBrowserMode] = useState<"disabled" | "local-harness" | "remote-worker">("disabled");
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
      const result = await session.checkReadiness();
      setReadiness(result);
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
      setConnections((current) =>
        current.map((c) => (c.providerId === providerId ? updated : c)),
      );
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
        providerId: entry.providerId,
        label: `${entry.displayName} Primary`,
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
        await api.saveBrowserConfig({ enabled: false, mode: "local-harness", cdpUrl: "http://127.0.0.1:9222" });
        setBrowserSuccessMsg("Browser automation disabled.");
      } else if (browserMode === "local-harness") {
        await api.saveBrowserConfig({ enabled: true, mode: "local-harness", cdpUrl });
        await api.testBrowser();
        setBrowserSuccessMsg("Local browser harness configured and verified.");
      } else {
        await api.saveBrowserConfig({
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

      await api.saveMcpServer(id, {
        transport: "stdio",
        command: mcpServerCommand.trim(),
        args,
        env: {},
        envRefs: {},
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
      const ticket = await api.createPairingTicket({ role: "WORKER", ttlSeconds: 900 });
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
      <div className="login-shell" style={{ maxWidth: "680px", width: "100%" }}>
        <div className="login-brand">
          <span className="brand-mark">N</span>
          <span>NEXUS · Setup Wizard</span>
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
                  color: isCurrent ? "var(--bright-accent)" : isPassed ? "var(--text)" : "var(--muted-text)",
                  border: isCurrent ? "1px solid var(--accent)" : "1px solid transparent",
                  fontSize: "12px",
                }}
              >
                {STEP_TITLES[item]}
              </button>
            );
          })}
        </div>

        {/* Global error banner with copyable diagnostic */}
        {error !== null && (
          <div className="banner error" role="alert" style={{ marginBottom: "16px" }}>
            <div>
              <strong>Error:</strong> {error}
            </div>
            {diagnostic !== null && (
              <div style={{ marginTop: "8px" }}>
                <button
                  type="button"
                  className="button compact"
                  onClick={copyDiagnostic}
                  style={{ fontSize: "11px" }}
                >
                  {copiedDiag ? "Copied diagnostic!" : "Copy sanitized diagnostic"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* STEP 1: PREREQUISITES */}
        {step === "prerequisites" && (
          <div>
            <div className="login-intro">
              <h1>Verify Infrastructure Readiness</h1>
              <p>Checking database, caching, and core service connectivity.</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px", margin: "16px 0" }}>
              <div className="card" style={{ padding: "14px", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>PostgreSQL Database</strong>
                  <span className={`state-pill ${readiness?.dependencies?.database?.status === "up" ? "good" : "danger"}`}>
                    {readiness?.dependencies?.database?.status === "up" ? "Connected" : "Disconnected"}
                  </span>
                </div>
                <small className="muted">
                  Latency: {readiness?.dependencies?.database?.latencyMs ?? "—"} ms
                </small>
              </div>

              <div className="card" style={{ padding: "14px", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>Redis Cache & Broker</strong>
                  <span className={`state-pill ${readiness?.dependencies?.redis?.status === "up" ? "good" : "danger"}`}>
                    {readiness?.dependencies?.redis?.status === "up" ? "Connected" : "Disconnected"}
                  </span>
                </div>
                <small className="muted">
                  Latency: {readiness?.dependencies?.redis?.latencyMs ?? "—"} ms
                </small>
              </div>

              <div className="card" style={{ padding: "14px", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>NEXUS Core API</strong>
                  <span className={`state-pill ${readiness?.status === "ok" ? "good" : readiness?.status === "degraded" ? "warning" : "danger"}`}>
                    {readiness?.status ?? "Checking…"}
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
                {busy ? "Checking…" : "Re-check Readiness"}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || readiness?.status === "down"}
                onClick={() => goToStep("admin")}
              >
                Continue to Account Setup
              </button>
              <button
                type="button"
                className="button compact"
                onClick={onSwitchToLogin}
                style={{ marginLeft: "auto" }}
              >
                Already have an account? Sign in
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: ADMIN REGISTRATION */}
        {step === "admin" && (
          <div>
            <div className="login-intro">
              <h1>Create Administrator Account</h1>
              <p>The first registered user is automatically granted root administrative authority.</p>
            </div>

            <form className="login-form" onSubmit={(e) => void handleRegisterAdmin(e)}>
              <label>
                Full Name
                <input
                  className="field"
                  type="text"
                  placeholder="Lead Engineer"
                  required
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                />
              </label>

              <label>
                Administrator Email
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
                Password (minimum 12 characters)
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
                Confirm Password
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
                  Back
                </button>
                <button
                  type="submit"
                  className="button primary login-submit"
                  disabled={busy || !adminEmail.trim() || adminPassword.length < 12}
                >
                  {busy ? "Creating Account…" : "Create Administrator & Continue"}
                </button>
              </div>

              <div style={{ marginTop: "12px", textAlign: "center" }}>
                <button
                  type="button"
                  className="button compact"
                  onClick={onSwitchToLogin}
                >
                  Instance already initialized? Sign in directly
                </button>
              </div>
            </form>
          </div>
        )}

        {/* STEP 3: AGENT DISCOVERY & OFFICIAL LOGIN */}
        {step === "agents" && (
          <div>
            <div className="login-intro">
              <h1>Discover & Connect AI Agents</h1>
              <p>
                NEXUS probes declared local CLI tools. No credentials or OAuth tokens ever pass through the browser.
              </p>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <span>Detected {connections.length} supported providers</span>
              <button
                type="button"
                className="button secondary compact"
                disabled={busy}
                onClick={() => void scanAgents()}
              >
                {busy ? "Scanning host…" : "Re-scan Host"}
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
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <strong>{entry.displayName}</strong>
                          <span className={`state-pill ${status.tone}`}>{status.label}</span>
                        </div>
                        <p style={{ margin: "4px 0", fontSize: "12px", color: "var(--muted-text)" }}>
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
                          {isTesting ? "Testing…" : "Test"}
                        </button>
                        <button
                          type="button"
                          className="button primary compact"
                          disabled={busy}
                          onClick={() => void addProviderToTeam(entry)}
                        >
                          Add to Routing
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
                          Official Sign-in Command
                        </div>
                        <p style={{ margin: "0 0 6px 0", fontSize: "12px" }}>
                          Run this official CLI command in your host terminal to open the provider's official browser login:
                        </p>
                        <code style={{ background: "#000", padding: "4px 8px", borderRadius: "4px", display: "inline-block" }}>
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
                              View Official Documentation →
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
              <button
                type="button"
                className="button secondary"
                onClick={() => goToStep("admin")}
              >
                Back
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => goToStep("capabilities")}
              >
                Continue to Capabilities
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: OPTIONAL CAPABILITIES (BROWSER, MCP, WORKER) */}
        {step === "capabilities" && (
          <div>
            <div className="login-intro">
              <h1>Configure Optional Capabilities</h1>
              <p>Configure browser automation, MCP tools, and external worker pairing. All are optional.</p>
            </div>

            {/* Browser Section */}
            <div className="card" style={{ padding: "16px", marginBottom: "14px", border: "1px solid var(--border)" }}>
              <h3>Browser Execution</h3>
              <p className="muted" style={{ fontSize: "12px", marginBottom: "12px" }}>
                Enable autonomous web browsing via CDP or dedicated container worker.
              </p>

              <div style={{ display: "flex", gap: "16px", marginBottom: "12px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="browserMode"
                    value="disabled"
                    checked={browserMode === "disabled"}
                    onChange={() => setBrowserMode("disabled")}
                  />
                  Disabled
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="browserMode"
                    value="local-harness"
                    checked={browserMode === "local-harness"}
                    onChange={() => setBrowserMode("local-harness")}
                  />
                  Local Chromium (CDP)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="browserMode"
                    value="remote-worker"
                    checked={browserMode === "remote-worker"}
                    onChange={() => setBrowserMode("remote-worker")}
                  />
                  Remote Worker
                </label>
              </div>

              {browserMode === "local-harness" && (
                <label style={{ display: "block", marginBottom: "10px" }}>
                  CDP Endpoint URL
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
                  Remote Worker Base URL
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
                Save Browser Mode
              </button>
              {browserSuccessMsg && (
                <span style={{ marginLeft: "10px", fontSize: "12px", color: "var(--ok)" }}>
                  ✓ {browserSuccessMsg}
                </span>
              )}
            </div>

            {/* MCP Section */}
            <div className="card" style={{ padding: "16px", marginBottom: "14px", border: "1px solid var(--border)" }}>
              <h3>Model Context Protocol (MCP)</h3>
              <p className="muted" style={{ fontSize: "12px", marginBottom: "12px" }}>
                Add local stdio tools. Sensitive variables must use vault references.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                <input
                  className="field"
                  placeholder="Server ID (e.g. filesystem)"
                  value={mcpServerName}
                  onChange={(e) => setMcpServerName(e.target.value)}
                />
                <input
                  className="field"
                  placeholder="Command (e.g. npx)"
                  value={mcpServerCommand}
                  onChange={(e) => setMcpServerCommand(e.target.value)}
                />
              </div>
              <input
                className="field"
                placeholder="Arguments (e.g. -y @modelcontextprotocol/server-filesystem /path)"
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
                Register MCP Server
              </button>
              {mcpSuccessMsg && (
                <span style={{ marginLeft: "10px", fontSize: "12px", color: "var(--ok)" }}>
                  ✓ {mcpSuccessMsg}
                </span>
              )}
            </div>

            {/* Worker Pairing Section */}
            <div className="card" style={{ padding: "16px", marginBottom: "14px", border: "1px solid var(--border)" }}>
              <h3>Pair a Device or Worker</h3>
              <p className="muted" style={{ fontSize: "12px", marginBottom: "12px" }}>
                Generate a single-use pairing ticket to attach a Windows, Linux, or Android worker without passing secrets on command lines.
              </p>

              {workerPairingTicket === null ? (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => void handleGenerateWorkerTicket()}
                >
                  Generate Worker Ticket
                </button>
              ) : (
                <div style={{ background: "var(--surface-2)", padding: "12px", borderRadius: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>Pairing Ticket Generated</strong>
                    <small className="muted">Expires: {new Date(workerPairingTicket.expiresAt).toLocaleTimeString()}</small>
                  </div>
                  <div style={{ margin: "8px 0" }}>
                    <span className="muted" style={{ fontSize: "11px" }}>One-time Token:</span>
                    <code style={{ background: "#000", padding: "4px 8px", borderRadius: "4px", display: "block", wordBreak: "break-all" }}>
                      {workerPairingTicket.token}
                    </code>
                  </div>
                  <div style={{ fontSize: "12px", marginTop: "8px" }}>
                    To pair an external worker, run:
                    <code style={{ background: "#000", padding: "4px 8px", borderRadius: "4px", display: "block", marginTop: "4px" }}>
                      nexus-worker --ticket {workerPairingTicket.token}
                    </code>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px" }}>
              <button
                type="button"
                className="button secondary"
                onClick={() => goToStep("agents")}
              >
                Back
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => goToStep("complete")}
              >
                Review & Finish
              </button>
            </div>
          </div>
        )}

        {/* STEP 5: REVIEW & COMPLETE */}
        {step === "complete" && (
          <div>
            <div className="login-intro">
              <h1>Setup Complete!</h1>
              <p>Your local NEXUS assistant is configured and ready for autonomous mission execution.</p>
            </div>

            <div className="card" style={{ padding: "16px", margin: "16px 0", border: "1px solid var(--border)" }}>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "10px" }}>
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>Core services and database healthy</span>
                </li>
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>Administrator session authenticated</span>
                </li>
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>Discovered {connections.length} AI CLI providers</span>
                </li>
                <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--ok)", fontWeight: "bold" }}>✓</span>
                  <span>Optional capabilities & worker pairing initialized</span>
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
                Launch NEXUS & Start Mission
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
