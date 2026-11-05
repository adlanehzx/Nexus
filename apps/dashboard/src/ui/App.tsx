import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { SessionManager } from "@nexus/client-core";
import { DashboardApi, createSession, type SystemPauseState } from "../lib/api.js";
import { createCareerEducationClient } from "../lib/career-education.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { I18nProvider, LanguageSwitch, useI18n } from "./i18n/index.js";
import { Futuristic3DCanvas } from "./Futuristic3DCanvas.js";
import { CyberRetypeTitle } from "./CyberRetypeTitle.js";
import { IconStop } from "./icons.js";
import { NexusLogo } from "./NexusLogo.js";
import { SpatialShell, useSpatialStore } from "./spatial/index.js";
import { getDigitFromEvent, isEditingText } from "./spatial/keyboardUtils.js";

const Agents = lazy(() =>
  import("./Agents.js").then(({ Agents: component }) => ({ default: component })),
);
const CareerEducation = lazy(() =>
  import("./CareerEducation/index.js").then(({ CareerEducation: component }) => ({
    default: component,
  })),
);
const Connections = lazy(() =>
  import("./Connections.js").then(({ Connections: component }) => ({ default: component })),
);
const NexusChat = lazy(() =>
  import("./NexusChat.js").then(({ NexusChat: component }) => ({ default: component })),
);
const OsintWorkspace = lazy(() =>
  import("./OsintWorkspace.js").then(({ OsintWorkspace: component }) => ({ default: component })),
);
const Settings = lazy(() =>
  import("./Settings.js").then(({ Settings: component }) => ({ default: component })),
);
const SetupWizard = lazy(() =>
  import("./SetupWizard.js").then(({ SetupWizard: component }) => ({ default: component })),
);
const sectionModule = () => import("./Sections.js");
const lazySection = <K extends keyof Awaited<ReturnType<typeof sectionModule>>>(name: K) =>
  lazy(() => sectionModule().then((module) => ({ default: module[name] })));
const Browser = lazySection("Browser");
const CommunicationGraph = lazySection("CommunicationGraph");
const DagDebugger = lazySection("DagDebugger");
const Devices = lazySection("Devices");
const Logs = lazySection("Logs");
const Marketplace = lazySection("Marketplace");
const Mcp = lazySection("Mcp");
const Memory = lazySection("Memory");
const MissionControl = lazySection("MissionControl");
const TradingLab = lazySection("TradingLab");
const Notifications = lazySection("Notifications");
const Overview = lazySection("Overview");
const QuotaForecast = lazySection("QuotaForecast");
const RunComparison = lazySection("RunComparison");
const Runs = lazySection("Runs");
const Security = lazySection("Security");
const Tasks = lazySection("Tasks");
const Tools = lazySection("Tools");
const VisualControl = lazySection("VisualControl");
const Workers = lazySection("Workers");
const VcsWorktrees = lazySection("VcsWorktrees");
const Providers = lazySection("Providers");
const Organizations = lazySection("Organizations");

function backendUrl(): string {
  const injected = (import.meta as { env?: { VITE_NEXUS_URL?: string; PROD?: boolean } }).env;
  const configured = injected?.VITE_NEXUS_URL?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return injected?.PROD === true ? window.location.origin : "http://localhost:3000";
}

export const SETTINGS_CATEGORIES = [
  {
    id: "general-ai",
    label: "Général & IA",
    labelEn: "General & AI",
    icon: "settings",
    items: [
      {
        id: "settings" as const,
        label: "Paramètres généraux",
        labelEn: "General Settings",
        icon: "settings",
      },
      {
        id: "providers" as const,
        label: "Fournisseurs de modèles",
        labelEn: "Model Providers",
        icon: "agents",
      },
      {
        id: "agents" as const,
        label: "Agents & Quotas",
        labelEn: "Agents & Quotas",
        icon: "agents",
      },
      {
        id: "connections" as const,
        label: "Connexions CLIs",
        labelEn: "CLI Connections",
        icon: "connections",
      },
    ],
  },
  {
    id: "vcs-code",
    label: "Code & VCS",
    labelEn: "Code & VCS",
    icon: "tools",
    items: [
      {
        id: "vcs-worktrees" as const,
        label: "VCS & Worktrees",
        labelEn: "VCS & Worktrees",
        icon: "tools",
      },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    labelEn: "Infrastructure",
    icon: "devices",
    items: [
      { id: "devices" as const, label: "Appareils", labelEn: "Devices", icon: "devices" },
      { id: "workers" as const, label: "Workers", labelEn: "Workers", icon: "workers" },
      { id: "tools" as const, label: "Outils", labelEn: "Tools", icon: "tools" },
      { id: "mcp" as const, label: "Serveurs MCP", labelEn: "MCP Servers", icon: "mcp" },
      { id: "browser" as const, label: "Navigateur", labelEn: "Browser", icon: "browser" },
    ],
  },
  {
    id: "governance",
    label: "Sécurité & Données",
    labelEn: "Security & Data",
    icon: "security",
    items: [
      {
        id: "security" as const,
        label: "Sécurité & Garde-fous",
        labelEn: "Security & Guardrails",
        icon: "security",
      },
      {
        id: "organizations" as const,
        label: "Organisations",
        labelEn: "Organizations",
        icon: "security",
      },
      {
        id: "memory" as const,
        label: "Mémoire sémantique",
        labelEn: "Semantic Memory",
        icon: "memory",
      },
      { id: "logs" as const, label: "Journaux système", labelEn: "Diagnostic Logs", icon: "logs" },
      {
        id: "notifications" as const,
        label: "Notifications",
        labelEn: "Notifications",
        icon: "notifications",
      },
    ],
  },
  {
    id: "diagnostics",
    label: "Diagnostics & Outils",
    labelEn: "Diagnostics & Tools",
    icon: "tasks",
    items: [
      { id: "runs" as const, label: "Exécutions d'agents", labelEn: "Agent Runs", icon: "runs" },
      {
        id: "mission-control" as const,
        label: "Missions ACP",
        labelEn: "ACP Missions",
        icon: "missions",
      },
      {
        id: "dag-debugger" as const,
        label: "Débogueur DAG",
        labelEn: "DAG Debugger",
        icon: "tasks",
      },
      {
        id: "run-comparison" as const,
        label: "Comparaison de runs",
        labelEn: "Run Comparison",
        icon: "runs",
      },
      {
        id: "visual-control" as const,
        label: "Contrôle visuel",
        labelEn: "Visual Control",
        icon: "browser",
      },
      {
        id: "communication-graph" as const,
        label: "Comms agents",
        labelEn: "Agent Comms",
        icon: "agents",
      },
      {
        id: "quota-forecast" as const,
        label: "Usage & Quotas",
        labelEn: "Usage & Quotas",
        icon: "overview",
      },
      {
        id: "marketplace" as const,
        label: "Place de marché",
        labelEn: "Marketplace",
        icon: "tools",
      },
      {
        id: "setup" as const,
        label: "Assistant d'installation",
        labelEn: "Setup Wizard",
        icon: "setup",
      },
    ],
  },
] as const;

export type SettingsSubSectionId = (typeof SETTINGS_CATEGORIES)[number]["items"][number]["id"];

export const ALL_SETTINGS_IDS: ReadonlySet<SettingsSubSectionId> = new Set<SettingsSubSectionId>(
  SETTINGS_CATEGORIES.flatMap((c) => c.items.map((i) => i.id)),
);

export function isSettingsSubSection(id: SectionId): boolean {
  return ALL_SETTINGS_IDS.has(id as SettingsSubSectionId);
}

export type SectionId =
  | SettingsSubSectionId
  | "chat"
  | "overview"
  | "tasks"
  | "career-education"
  | "trading-lab"
  | "osint";

const SECTION_IDS = new Set<SectionId>([
  "chat",
  "overview",
  "tasks",
  "career-education",
  "trading-lab",
  "osint",
  ...ALL_SETTINGS_IDS,
]);

function sectionFromHash(): SectionId {
  const candidate = window.location.hash.replace(/^#\/?/, "") as SectionId;
  return SECTION_IDS.has(candidate) ? candidate : "chat";
}

const PAGE_META: Record<SectionId, { title: string; description: string }> = {
  chat: { title: "Chat", description: "Assign a mission, NEXUS orchestrates the rest." },
  "career-education": {
    title: "Career & Education",
    description:
      "Long-term planning, multi-track discovery, tailored application preparation, and confirmed actions.",
  },
  "trading-lab": {
    title: "Trading Lab",
    description: "Paper portfolios, research markets, and risk experiments without real money.",
  },
  osint: {
    title: "OSINT Workspace",
    description: "Evidence-led investigations across lawfully accessible public sources.",
  },
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
  "dag-debugger": {
    title: "DAG debugger",
    description: "Inspect multi-step task execution graphs, pause and resume steps.",
  },
  "run-comparison": {
    title: "Run comparison",
    description: "Compare execution time, token consumption, and cost across runs.",
  },
  marketplace: {
    title: "Marketplace",
    description: "Browse, install, pause, and revoke third-party plugins and tools.",
  },
  "visual-control": {
    title: "Visual control",
    description: "Real-time GUI automation preview, session boundaries, and safety pauses.",
  },
  "communication-graph": {
    title: "Agent communication graph",
    description: "Inter-agent message topologies, communication volume, and latency.",
  },
  organizations: {
    title: "Organizations",
    description: "Organizations you belong to, their members and roles.",
  },
  "quota-forecast": {
    title: "Usage & Quotas",
    description: "Observed tokens, estimated API costs, exports, and provider quota windows.",
  },
  "vcs-worktrees": {
    title: "VCS & Worktrees",
    description: "Git worktrees, per-turn checkpoints, safe atomic rollbacks, and PR reviews.",
  },
  providers: {
    title: "Model Providers",
    description:
      "Unified AI engines (Claude, Cursor, Grok, ACP) with pre-execution safety and streaming.",
  },
};

export function App() {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
}

function AppContent() {
  const { t, tr } = useI18n();
  const [authenticated, setAuthenticated] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const session = useMemo(() => createSession(backendUrl(), () => setAuthenticated(false)), []);
  const api = useMemo(() => new DashboardApi(session), [session]);
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  const [refreshKey, setRefreshKey] = useState(0);
  const [systemPause, setSystemPause] = useState<SystemPauseState | null>(null);
  const [expandedNavGroups, setExpandedNavGroups] = useState<ReadonlySet<string>>(
    () => new Set(["Workspaces"]),
  );

  const spatialStore = useSpatialStore();
  const [viewMode, setViewMode] = useState<"spatial" | "classic">(() => {
    try {
      const saved = window.sessionStorage.getItem("nexus.ui.viewMode");
      if (saved === "classic") return "classic";
    } catch {
      // Storage unavailable
    }
    return "spatial";
  });

  const toggleViewMode = useCallback((mode?: "spatial" | "classic") => {
    setViewMode((prev) => {
      const next = mode ?? (prev === "spatial" ? "classic" : "spatial");
      try {
        window.sessionStorage.setItem("nexus.ui.viewMode", next);
      } catch {
        // Storage unavailable
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const handleViewModeChange = (e: Event) => {
      const custom = e as CustomEvent<"spatial" | "classic">;
      if (custom.detail === "spatial" || custom.detail === "classic") {
        setViewMode(custom.detail);
      }
    };
    window.addEventListener("nexus-viewmode-change", handleViewModeChange);
    return () => window.removeEventListener("nexus-viewmode-change", handleViewModeChange);
  }, []);

  const navigate = useCallback((next: SectionId): void => {
    setSection(next);
    const nextHash = `#/${next}`;
    if (window.location.hash !== nextHash) window.history.pushState(null, "", nextHash);
  }, []);

  useEffect(() => {
    const syncSection = (): void => setSection(sectionFromHash());
    window.addEventListener("hashchange", syncSection);
    window.addEventListener("popstate", syncSection);
    return () => {
      window.removeEventListener("hashchange", syncSection);
      window.removeEventListener("popstate", syncSection);
    };
  }, []);

  useEffect(() => {
    if (section === "career-education" || section === "trading-lab" || section === "osint") {
      setExpandedNavGroups((current) => {
        if (current.has("Workspaces")) return current;
        return new Set([...current, "Workspaces"]);
      });
    }
  }, [section]);

  // Classic Dashboard Keyboard Shortcuts (Ctrl+1..7, Ctrl+K, Ctrl+P, Ctrl+,, Ctrl+Shift+O)
  useEffect(() => {
    if (!authenticated || viewMode !== "classic") return;

    const handleClassicKeyDown = (e: KeyboardEvent) => {
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      if (!hasModifier) return;

      // Ctrl+K or Ctrl+P: Switch to Spatial and open Command Palette
      if (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        toggleViewMode("spatial");
        setTimeout(() => spatialStore.setIsPaletteOpen(true), 50);
        return;
      }

      // Ctrl+Shift+O / Alt+O: Toggle view mode between Classic and Spatial
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        e.stopPropagation();
        toggleViewMode("spatial");
        return;
      }

      // Ctrl+, : Settings
      if (e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        navigate("settings");
        return;
      }

      if (isEditingText()) return;

      const digit = getDigitFromEvent(e);
      if (digit !== null && digit >= 1 && digit <= 7) {
        e.preventDefault();
        e.stopPropagation();
        const sectionMap: Record<number, SectionId> = {
          1: "chat",
          2: "overview",
          3: "tasks",
          4: "career-education",
          5: "trading-lab",
          6: "osint",
          7: "settings",
        };
        const target = sectionMap[digit];
        if (target) navigate(target);
      }
    };

    window.addEventListener("keydown", handleClassicKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleClassicKeyDown, { capture: true });
  }, [authenticated, viewMode, navigate, toggleViewMode, spatialStore]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const fetchPause = () => {
      api
        .globalPause()
        .then((state) => {
          if (!cancelled) setSystemPause(state);
        })
        .catch(() => undefined);
    };
    fetchPause();
    const interval = setInterval(fetchPause, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [authenticated, api]);
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
        <NexusLogo size={48} />
      </main>
    );
  }

  if (!authenticated) {
    if (authMode === "setup") {
      return (
        <Suspense fallback={<FullPageLoading />}>
          <SetupWizard
            session={session}
            api={api}
            onComplete={() => {
              setAuthenticated(true);
              setAuthMode("login");
              navigate("chat");
            }}
            onSwitchToLogin={() => setAuthMode("login")}
          />
        </Suspense>
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

  if (viewMode === "spatial") {
    return (
      <SpatialShell
        store={spatialStore}
        api={api}
        session={session}
        onToggleClassicView={() => toggleViewMode("classic")}
      />
    );
  }

  const metaTitle = t(`meta.${section}.title`) || PAGE_META[section]?.title || section;
  const metaDescription = t(`meta.${section}.description`) || PAGE_META[section]?.description || "";

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="nexus-home" type="button" onClick={() => navigate("chat")}>
          <NexusLogo size={32} />
          <span>
            <strong>NEXUS</strong>
            <small>{t("nav.groups.supervision")}</small>
          </span>
        </button>
        <nav className="navigation" aria-label="Main navigation">
          <div className="nav-group nav-primary">
            <NavItem
              id="chat"
              label={t("nav.items.chat") || "Chat"}
              icon="chat"
              current={section}
              onSelect={navigate}
            />
            <NavItem
              id="overview"
              label={t("nav.items.overview") || "Overview"}
              icon="overview"
              current={section}
              onSelect={navigate}
            />
            <NavItem
              id="tasks"
              label={t("nav.items.tasks") || "Tasks"}
              icon="tasks"
              current={section}
              onSelect={navigate}
            />
          </div>
          <NavGroup
            label={t("nav.groups.workspaces")}
            expanded={expandedNavGroups.has("Workspaces")}
            onToggle={() =>
              setExpandedNavGroups((current) => toggleSetValue(current, "Workspaces"))
            }
          >
            <NavItem
              id="career-education"
              label={t("nav.items.career-education") || "Career"}
              icon="career"
              current={section}
              onSelect={navigate}
            />
            <NavItem
              id="trading-lab"
              label={t("nav.items.trading-lab") || "Trading Lab"}
              icon="trading"
              current={section}
              onSelect={navigate}
            />
            <NavItem
              id="osint"
              label={t("nav.items.osint") || "OSINT"}
              icon="osint"
              current={section}
              onSelect={navigate}
            />
          </NavGroup>
          <div
            className="nav-group nav-settings-entry"
            style={{ marginTop: "auto", paddingTop: "0.5rem" }}
          >
            <NavItem
              id="settings"
              label={t("nav.items.settings") || "Settings"}
              icon="settings"
              current={isSettingsSubSection(section) ? "settings" : section}
              onSelect={navigate}
            />
          </div>
        </nav>
        <div className="sidebar-footer">
          <span className="system-dot" aria-hidden="true" />
          <span>
            <strong>{tr("Local system", "Système local")}</strong>
            <small>{t("common.states.connected")}</small>
          </span>
        </div>
      </aside>

      <main className={`main section-${section}`}>
        <header className="header top-bar">
          <div>
            <div className="eyebrow">
              NEXUS /{" "}
              {isSettingsSubSection(section)
                ? tr("SETTINGS", "PARAMÈTRES")
                : section === "chat" ||
                    section === "career-education" ||
                    section === "trading-lab" ||
                    section === "osint"
                  ? tr("WORKSPACE", "ESPACE DE TRAVAIL")
                  : tr("SUPERVISION", "SUPERVISION")}
            </div>
            <h1>
              <CyberRetypeTitle text={metaTitle} />
            </h1>
            <p>{metaDescription}</p>
          </div>
          <div className="header-actions">
            <div
              className="hud-telemetry-badge"
              title={tr("System Core Status", "État du Cœur Système")}
            >
              <div className="radar-pulse-ring" />
              <span>
                {tr("CORE:", "CŒUR :")} <strong>{tr("NOMINAL", "NOMINAL")}</strong>
              </span>
              <div
                className="hud-audio-bars"
                title={tr("Neural Bus Activity", "Activité du Bus Neural")}
              >
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
              </div>
              <span>{tr("SYNC 100%", "SYNC 100%")}</span>
            </div>
            <div
              className="live-pulse-container"
              title={tr("NEXUS local services active", "Services locaux NEXUS actifs")}
            >
              <span className="live-pulse-dot" />
              <span>{t("common.messages.liveApi")}</span>
            </div>
            <button
              type="button"
              className={`button ${systemPause?.paused ? "ok" : "danger"}`}
              onClick={() => {
                const willPause = !systemPause?.paused;
                const reason = willPause
                  ? tr(
                      "Manual emergency stop from dashboard",
                      "Arrêt d'urgence manuel depuis le tableau de bord",
                    )
                  : undefined;
                void api.setGlobalPause(willPause, reason).then((state) => setSystemPause(state));
              }}
            >
              {systemPause?.paused
                ? tr("Resume NEXUS", "Reprendre NEXUS")
                : tr("Emergency stop", "Arrêt d'urgence")}
            </button>
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
                {t("common.actions.refresh")}
              </button>
            )}
            <button
              type="button"
              className="button logout-button"
              onClick={() => void session.logout().finally(() => setAuthenticated(false))}
            >
              {t("common.actions.disconnect")}
            </button>
          </div>
        </header>
        {systemPause?.paused && (
          <div role="alert" className="emergency-banner">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <IconStop size={22} color="var(--nx-danger, #ff3366)" />
              <span>
                {tr(
                  "EMERGENCY STOP ACTIVE: All NEXUS actions are suspended.",
                  "ARRÊT D'URGENCE ACTIF : Toutes les actions de NEXUS sont suspendues.",
                )}
                {systemPause.reason ? ` ${tr("Reason:", "Raison :")} ${systemPause.reason}` : ""}
              </span>
            </div>
            <button
              type="button"
              className="button compact"
              onClick={() => {
                void api.setGlobalPause(false).then((state) => setSystemPause(state));
              }}
            >
              {tr("Resume NEXUS", "Reprendre NEXUS")}
            </button>
          </div>
        )}
        <Suspense fallback={<SectionLoading />}>
          <div className="section-frame" key={`${section}-${String(refreshKey)}`}>
            {isSettingsSubSection(section) && (
              <SettingsHubNav currentSection={section} navigate={navigate} />
            )}
            {renderSection(section, api, session, navigate)}
          </div>
        </Suspense>
      </main>
    </div>
  );
}

function FullPageLoading() {
  return (
    <main className="session-restoring" role="status" aria-label="Loading setup">
      <NexusLogo size={48} />
    </main>
  );
}

function SectionLoading() {
  return (
    <div className="content" role="status" aria-label="Loading section">
      <div className="loading-state">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function toggleSetValue(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function NavGroup({
  label,
  expanded,
  onToggle,
  children,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const regionId = `nav-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <div className={`nav-group ${expanded ? "expanded" : "collapsed"}`}>
      <button
        type="button"
        className="nav-group-toggle"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={onToggle}
      >
        <span>{label}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m5 6 3 3 3-3" />
        </svg>
      </button>
      <div className="nav-group-items" id={regionId}>
        {children}
      </div>
    </div>
  );
}

function SettingsHubNav({
  currentSection,
  navigate,
}: {
  currentSection: SectionId;
  navigate: (next: SectionId) => void;
}) {
  const { locale, t } = useI18n();

  const currentCategory = useMemo(() => {
    return (
      SETTINGS_CATEGORIES.find((cat) => cat.items.some((item) => item.id === currentSection)) ??
      SETTINGS_CATEGORIES[0]
    );
  }, [currentSection]);

  const [activeCategoryId, setActiveCategoryId] = useState<string>(currentCategory.id);

  useEffect(() => {
    setActiveCategoryId(currentCategory.id);
  }, [currentCategory.id]);

  const activeCategory =
    SETTINGS_CATEGORIES.find((cat) => cat.id === activeCategoryId) ?? SETTINGS_CATEGORIES[0];

  return (
    <nav className="settings-hub-nav" aria-label="Settings sub-navigation">
      <div className="settings-categories-strip" role="tablist" aria-label="Settings categories">
        {SETTINGS_CATEGORIES.map((cat) => {
          const isActive = cat.id === activeCategoryId;
          const label = locale === "fr" ? cat.label : cat.labelEn;
          return (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`settings-category-btn ${isActive ? "active" : ""}`}
              onClick={() => {
                setActiveCategoryId(cat.id);
                if (!cat.items.some((item) => item.id === currentSection)) {
                  navigate(cat.items[0].id);
                }
              }}
            >
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      <div className="settings-subitems-strip" role="group" aria-label="Settings items">
        {activeCategory.items.map((item) => {
          const isActive = item.id === currentSection;
          const translated = t(`nav.items.${item.id}`);
          const fallback = locale === "fr" ? item.label : item.labelEn;
          const displayLabel = translated || fallback;
          return (
            <button
              key={item.id}
              type="button"
              className={`settings-subitem-pill ${isActive ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <span>{displayLabel}</span>
            </button>
          );
        })}
      </div>
    </nav>
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
    case "career-education":
      return <CareerEducation client={createCareerEducationClient(session)} />;
    case "osint":
      return <OsintWorkspace api={api} onOpenMissions={() => navigate("mission-control")} />;
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
    case "trading-lab":
      return <TradingLab api={api} />;
    case "memory":
      return <Memory api={api} />;
    case "organizations":
      return <Organizations api={api} />;
    case "notifications":
      return <Notifications api={api} />;
    case "security":
      return <Security api={api} />;
    case "logs":
      return <Logs api={api} />;
    case "dag-debugger":
      return <DagDebugger api={api} />;
    case "run-comparison":
      return <RunComparison api={api} />;
    case "marketplace":
      return <Marketplace api={api} />;
    case "visual-control":
      return <VisualControl api={api} />;
    case "communication-graph":
      return <CommunicationGraph api={api} />;
    case "quota-forecast":
      return <QuotaForecast api={api} />;
    case "vcs-worktrees":
      return <VcsWorktrees api={api} />;
    case "providers":
      return <Providers api={api} />;
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
    career: "M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
    trading: "M4 18 9 13l3 3 7-9m-5 0h5v5",
    osint: "M11 4a7 7 0 1 0 5 12l4 4m-9-12v6m-3-3h6",
    agents: "M16 18a4 4 0 0 0-8 0m10-7a3 3 0 1 1-6 0m-7 7a3 3 0 0 1 3-3m8 0a3 3 0 0 1 3 3",
    connections: "M8 12h8m-6-4 4 4-4 4M5 5h14v14H5V5Z",
    setup:
      "M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83",
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
  const { tr } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="login-page">
      <Futuristic3DCanvas className="login-3d-bg" />
      <div className="login-shell cyber-reticle">
        <div className="login-brand">
          <NexusLogo size={32} style={{ marginRight: 8 }} />
          <span>NEXUS</span>
          <span className="login-brand-spacer" />
          <LanguageSwitch />
          <ThemeToggle />
        </div>
        <div className="login-intro">
          <h1>{tr("Welcome back.", "Bienvenue.")}</h1>
          <p>
            {tr(
              "Sign in to supervise your agents and track their missions.",
              "Connectez-vous pour superviser vos agents et suivre leurs missions.",
            )}
          </p>
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
                setError(
                  cause instanceof Error
                    ? cause.message
                    : tr("Sign-in failed.", "Échec de connexion."),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label>
            {tr("Email address", "Adresse email")}
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
            {tr("Password", "Mot de passe")}
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
            {busy ? tr("Signing in…", "Connexion…") : tr("Sign in", "Se connecter")}
          </button>
          {error === null ? null : (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
        </form>

        <div style={{ marginTop: "16px", textAlign: "center" }}>
          <button type="button" className="button compact" onClick={onSwitchToSetup}>
            {tr("First time? Run setup wizard", "Première fois ? Lancer l'assistant")}
          </button>
        </div>

        <p className="login-security">
          {tr("Local secure administrator session.", "Session administrateur sécurisée locale.")}
        </p>
      </div>
    </main>
  );
}
