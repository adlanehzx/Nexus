import { useEffect, useMemo, useState } from "react";
import { DashboardApi, createSession } from "../lib/api.js";
import { Agents } from "./Agents.js";
import { Connections } from "./Connections.js";
import { NexusChat } from "./NexusChat.js";
import { SetupWizard } from "./SetupWizard.js";
import {
  Browser,
  Devices,
  Logs,
  Mcp,
  Memory,
  MissionControl,
  Notifications,
  Overview,
  Runs,
  Security,
  Tasks,
  Tools,
  Workers,
} from "./Sections.js";
import { Settings } from "./Settings.js";

function backendUrl(): string {
  const injected = (import.meta as { env?: { VITE_NEXUS_URL?: string; PROD?: boolean } }).env;
  const configured = injected?.VITE_NEXUS_URL?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return injected?.PROD === true ? window.location.origin : "http://localhost:3000";
}

const SUPERVISION_SECTIONS = [
  {
    label: "Control",
    items: [
      ["overview", "Overview", "overview"],
      ["tasks", "Tasks", "tasks"],
      ["runs", "Agent runs", "runs"],
      ["mission-control", "ACP missions", "missions"],
    ],
  },
  {
    label: "Infrastructure",
    items: [
      ["devices", "Devices", "devices"],
      ["workers", "Workers", "workers"],
      ["tools", "Tools", "tools"],
      ["mcp", "MCP", "mcp"],
      ["browser", "Browser", "browser"],
    ],
  },
  {
    label: "Governance",
    items: [
      ["memory", "Memory", "memory"],
      ["notifications", "Notifications", "notifications"],
      ["security", "Security", "security"],
      ["logs", "Logs", "logs"],
    ],
  },
] as const;

type SupervisionId = (typeof SUPERVISION_SECTIONS)[number]["items"][number][0];
type SectionId = SupervisionId | "chat" | "agents" | "connections" | "settings" | "setup";

const PAGE_META: Record<SectionId, { title: string; description: string }> = {
  chat: { title: "Chat", description: "Assign a mission, NEXUS orchestrates the rest." },
  setup: { title: "Setup wizard", description: "Guided installation and onboarding assistant." },
  agents: {
    title: "Agents",
    description: "Capabilities, availability, and quotas of your AI team.",
  },
  connections: {
    title: "Connections",
    description: "Discover local agent CLIs without importing their credentials.",
  },
  settings: { title: "Settings", description: "Persistent rules of the multi-agent engine." },
  overview: {
    title: "Overview",
    description: "Operational state of NEXUS at a glance.",
  },
  devices: { title: "Devices", description: "Paired machines, trust levels, and permissions." },
  workers: { title: "Workers", description: "Available capacity to execute tasks." },
  tasks: { title: "Tasks", description: "Work queue, dependencies, and results." },
  runs: { title: "Agent runs", description: "Execution traces and pending confirmations." },
  tools: {
    title: "Tools",
    description: "Native, ACP, and browser capabilities exposed to agents.",
  },
  mcp: { title: "MCP", description: "Context servers and connected tools." },
  browser: { title: "Browser", description: "Controllable Chromium sessions without LLM API key." },
  "mission-control": {
    title: "ACP missions",
    description: "Orchestration, progress, and recovery of autonomous missions.",
  },
  memory: {
    title: "Memory",
    description: "Durable context re-injected into upcoming missions.",
  },
  notifications: { title: "Notifications", description: "Events requiring your attention." },
  security: { title: "Security", description: "Audit logs, secrets, and guardrails." },
  logs: { title: "Logs", description: "Correlated platform-wide diagnostic logs." },
};

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const session = useMemo(() => createSession(backendUrl(), () => setAuthenticated(false)), []);
  const api = useMemo(() => new DashboardApi(session), [session]);
  const [section, setSection] = useState<SectionId>("chat");
  const [refreshKey, setRefreshKey] = useState(0);
  const [authMode, setAuthMode] = useState<"login" | "setup">(() => {
    try {
      const active = window.sessionStorage.getItem("nexus.setup.step");
      if (active !== null) return "setup";
    } catch {
      // Storage unavailable
    }
    return "login";
  });

  useEffect(() => {
    let active = true;
    void session.restore().then((restored) => {
      if (active) {
        setAuthenticated(restored);
        setRestoringSession(false);
      }
    });
    return () => {
      active = false;
    };
  }, [session]);

  if (restoringSession) {
    return (
      <main className="session-restoring" role="status" aria-label="Restoring session">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
      </main>
    );
  }

  if (!authenticated) {
    if (authMode === "setup") {
      return (
        <SetupWizard
          session={session}
          api={api}
          onComplete={() => {
            setAuthenticated(true);
            setAuthMode("login");
            setSection("chat");
          }}
          onSwitchToLogin={() => setAuthMode("login")}
        />
      );
    }

    return (
      <Login
        onSignIn={async (email, password) => {
          await session.login(email, password);
          setAuthenticated(true);
        }}
        onSwitchToSetup={() => setAuthMode("setup")}
      />
    );
  }

  const meta = PAGE_META[section];
  const navigate = (next: SectionId): void => setSection(next);

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="nexus-home" type="button" onClick={() => navigate("chat")}>
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>NEXUS</strong>
            <small>Mission control</small>
          </span>
        </button>
        <nav className="navigation" aria-label="Main navigation">
          <div className="nav-group nav-primary">
            <NavItem id="chat" label="Chat" icon="chat" current={section} onSelect={navigate} />
            <NavItem
              id="agents"
              label="Agents"
              icon="agents"
              current={section}
              onSelect={navigate}
            />
            <NavItem
              id="connections"
              label="Connections"
              icon="connections"
              current={section}
              onSelect={navigate}
            />
            <NavItem
              id="settings"
              label="Settings"
              icon="settings"
              current={section}
              onSelect={navigate}
            />
            <NavItem
              id="setup"
              label="Setup wizard"
              icon="setup"
              current={section}
              onSelect={navigate}
            />
          </div>
          {SUPERVISION_SECTIONS.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.map(([id, label, icon]) => (
                <NavItem
                  id={id}
                  label={label}
                  icon={icon}
                  current={section}
                  onSelect={navigate}
                  key={id}
                />
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="system-dot" aria-hidden="true" />
          <span>
            <strong>Local system</strong>
            <small>Connected</small>
          </span>
        </div>
      </aside>

      <main className={`main section-${section}`}>
        <header className="header">
          <div>
            <div className="eyebrow">
              NEXUS / {section === "chat" ? "WORKSPACE" : "SUPERVISION"}
            </div>
            <h1>{meta.title}</h1>
            <p>{meta.description}</p>
          </div>
          <div className="header-actions">
            {section === "chat" ? null : (
              <button
                type="button"
                className="button refresh-button"
                onClick={() => setRefreshKey((value) => value + 1)}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.6-2.5L20 11M4 13l2.3 4.5A7 7 0 0 0 18 15" />
                </svg>
                Refresh
              </button>
            )}
            <button
              type="button"
              className="button logout-button"
              onClick={() => void session.logout().finally(() => setAuthenticated(false))}
            >
              Sign out
            </button>
          </div>
        </header>
        <div className="section-frame" key={`${section}-${String(refreshKey)}`}>
          {renderSection(section, api, session, navigate)}
        </div>
      </main>
    </div>
  );
}

function renderSection(
  section: SectionId,
  api: DashboardApi,
  session: SessionManager,
  navigate: (next: SectionId) => void,
) {
  switch (section) {
    case "setup":
      return (
        <SetupWizard
          session={session}
          api={api}
          onComplete={() => navigate("chat")}
          onSwitchToLogin={() => navigate("chat")}
        />
      );
    case "chat":
      return <NexusChat api={api} />;
    case "agents":
      return <Agents api={api} />;
    case "connections":
      return <Connections api={api} />;
    case "settings":
      return <Settings api={api} />;
    case "overview":
      return <Overview api={api} />;
    case "devices":
      return <Devices api={api} />;
    case "workers":
      return <Workers api={api} />;
    case "tasks":
      return <Tasks api={api} />;
    case "runs":
      return <Runs api={api} />;
    case "tools":
      return <Tools api={api} />;
    case "mcp":
      return <Mcp api={api} />;
    case "browser":
      return <Browser api={api} />;
    case "mission-control":
      return <MissionControl api={api} />;
    case "memory":
      return <Memory api={api} />;
    case "notifications":
      return <Notifications api={api} />;
    case "security":
      return <Security api={api} />;
    case "logs":
      return <Logs api={api} />;
  }
}

function NavItem({
  id,
  label,
  icon,
  current,
  onSelect,
}: {
  id: SectionId;
  label: string;
  icon: string;
  current: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <button
      className="nav-item"
      type="button"
      aria-current={current === id ? "page" : undefined}
      onClick={() => onSelect(id)}
    >
      <NavIcon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    chat: "M4 5h16v11H8l-4 4V5Z",
    agents: "M16 18a4 4 0 0 0-8 0m10-7a3 3 0 1 1-6 0m-7 7a3 3 0 0 1 3-3m8 0a3 3 0 0 1 3 3",
    connections: "M8 12h8m-6-4 4 4-4 4M5 5h14v14H5V5Z",
    setup: "M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
    overview: "M4 13h6V4H4v9Zm10 7h6V11h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z",
    tasks: "m5 12 4 4L19 6M5 5h7M5 20h14",
    runs: "m8 5 11 7-11 7V5Z",
    missions: "M12 3v4m0 10v4M3 12h4m10 0h4m-6-3a4 4 0 1 1-6 6 4 4 0 0 1 6-6Z",
    devices: "M7 3h10v18H7V3Zm3 15h4",
    workers: "M4 7h16v10H4V7Zm4 14v-4m8 4v-4M9 11h.01M13 11h3",
    tools: "m14 6 4-3 3 3-3 4m-4-4-9 9v4h4l9-9",
    mcp: "M8 6h8M8 12h8M8 18h8M5 6h.01M5 12h.01M5 18h.01",
    browser: "M3 5h18v14H3V5Zm0 4h18M6 7h.01M9 7h.01",
    memory:
      "M8 4h8a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Zm1 5h6m-6 4h6m-6 4h4",
    notifications: "M6 16h12l-2-3V9a4 4 0 0 0-8 0v4l-2 3Zm4 3h4",
    security: "M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Zm-3 9 2 2 4-5",
    logs: "M5 4h14v16H5V4Zm3 4h8m-8 4h8m-8 4h5",
  };
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.overview} />
    </svg>
  );
}

function Login({
  onSignIn,
  onSwitchToSetup,
}: {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSwitchToSetup: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="login-page">
      <div className="login-shell">
        <div className="login-brand">
          <span className="brand-mark">N</span>
          <span>NEXUS</span>
        </div>
        <div className="login-intro">
          <h1>Welcome back.</h1>
          <p>Sign in to supervise your agents and track their missions.</p>
        </div>
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            const secret = password;
            setPassword("");
            void onSignIn(email.trim(), secret)
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Sign-in failed."),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Email address
            <input
              className="field"
              type="email"
              autoComplete="username"
              placeholder="name@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button primary login-submit"
            disabled={busy || email.trim().length === 0 || password.length === 0}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {error === null ? null : (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
        </form>

        <div style={{ marginTop: "16px", textAlign: "center" }}>
          <button
            type="button"
            className="button compact"
            onClick={onSwitchToSetup}
          >
            First time? Run setup wizard
          </button>
        </div>

        <p className="login-security">Local secure administrator session.</p>
      </div>
    </main>
  );
}
