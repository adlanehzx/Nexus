import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { SessionManager } from "@nexus/client-core";
import { DashboardApi, createSession, type SystemPauseState } from "../lib/api.js";
import { createCareerEducationClient } from "../lib/career-education.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { I18nProvider, LanguageSwitch, useI18n } from "./i18n/index.js";
import { Futuristic3DCanvas } from "./Futuristic3DCanvas.js";
import { CyberRetypeTitle } from "./CyberRetypeTitle.js";
import { IconLab, IconSettings, IconStop, IconUsage } from "./icons.js";
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
const Devices = lazySection("Devices");
const Mcp = lazySection("Mcp");
const Memory = lazySection("Memory");
const MissionControl = lazySection("MissionControl");
const TradingLab = lazySection("TradingLab");
const Notifications = lazySection("Notifications");
const Overview = lazySection("Overview");
const QuotaForecast = lazySection("QuotaForecast");
const UsageLimits = lazySection("UsageLimits");
const UsageCosts = lazySection("UsageCosts");
const UsageTokens = lazySection("UsageTokens");
const Providers = lazySection("Providers");
const Satellites = lazySection("Satellites");
const Domotique = lazySection("Domotique");

function backendUrl(): string {
  const injected = (import.meta as { env?: { VITE_NEXUS_URL?: string; PROD?: boolean } }).env;
  const configured = injected?.VITE_NEXUS_URL?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return injected?.PROD === true ? window.location.origin : "http://localhost:3000";
}

export const SETTINGS_CATEGORIES = [
  {
    id: "system-preferences",
    label: "Interface & Préférences",
    labelEn: "UI & Preferences",
    icon: "settings",
    items: [
      {
        id: "settings-preferences" as const,
        label: "Préférences & Thèmes",
        labelEn: "Preferences & Themes",
        icon: "settings",
      },
      {
        id: "settings-shortcuts" as const,
        label: "Raccourcis Clavier",
        labelEn: "Keybindings",
        icon: "shortcuts",
      },
      {
        id: "settings-secrets" as const,
        label: "Clés API & Secrets",
        labelEn: "API Keys & Secrets",
        icon: "secrets",
      },
      {
        id: "settings-backup" as const,
        label: "Sauvegarde & Restauration",
        labelEn: "Backup & Restore",
        icon: "backup",
      },
    ],
  },
  {
    id: "ai-engines",
    label: "Intelligence Artificielle",
    labelEn: "Artificial Intelligence",
    icon: "agents",
    items: [
      {
        id: "providers" as const,
        label: "Fournisseurs & CLIs",
        labelEn: "Providers & CLIs",
        icon: "agents",
      },
      {
        id: "agents" as const,
        label: "Agents & Profils",
        labelEn: "Agents & Profiles",
        icon: "agents",
      },
      {
        id: "settings-engine" as const,
        label: "Moteurs & Modèles LLM",
        labelEn: "LLM Engines & Routing",
        icon: "engine",
      },
    ],
  },
  {
    id: "capabilities-devices",
    label: "Capacités & Outils",
    labelEn: "Capabilities & Tools",
    icon: "devices",
    items: [
      {
        id: "devices" as const,
        label: "Appareils & Réseau",
        labelEn: "Devices & Network",
        icon: "devices",
      },
      {
        id: "mcp" as const,
        label: "Serveurs MCP & Outils",
        labelEn: "MCP Servers & Tools",
        icon: "mcp",
      },
      { id: "browser" as const, label: "Navigateur Web", labelEn: "Web Browser", icon: "browser" },
    ],
  },
  {
    id: "privacy-governance",
    label: "Données & Automatisation",
    labelEn: "Data & Automation",
    icon: "memory",
    items: [
      {
        id: "memory" as const,
        label: "Mémoire sémantique",
        labelEn: "Semantic Memory",
        icon: "memory",
      },
      {
        id: "notifications" as const,
        label: "Notifications",
        labelEn: "Notifications",
        icon: "notifications",
      },
      {
        id: "mission-control" as const,
        label: "Missions & Planifications",
        labelEn: "Missions & Schedules",
        icon: "missions",
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
  | "settings"
  | "career-education"
  | "trading-lab"
  | "osint"
  | "domotique"
  | "satellites"
  | "quota-forecast"
  | "usage-limits"
  | "usage-costs"
  | "usage-tokens";

const SECTION_IDS = new Set<SectionId>([
  "chat",
  "overview",
  "tasks",
  "settings",
  "career-education",
  "trading-lab",
  "osint",
  "domotique",
  "satellites",
  "quota-forecast",
  "usage-limits",
  "usage-costs",
  "usage-tokens",
  ...ALL_SETTINGS_IDS,
]);

export function isLabSection(id: SectionId): boolean {
  return (
    id === "career-education" ||
    id === "trading-lab" ||
    id === "osint" ||
    id === "domotique" ||
    id === "satellites"
  );
}

export function isUsageSection(id: SectionId): boolean {
  return (
    id === "quota-forecast" ||
    id === "usage-limits" ||
    id === "usage-costs" ||
    id === "usage-tokens"
  );
}

export function isSettingsSection(id: SectionId): boolean {
  return isSettingsSubSection(id) || id === "settings" || String(id).startsWith("settings-");
}

function sectionFromHash(): SectionId {
  const candidate = window.location.hash.replace(/^#\/?/, "") as SectionId;
  if (candidate === "satellites") return "domotique";
  return SECTION_IDS.has(candidate) ? candidate : "chat";
}

const PAGE_META: Record<string, { title: string; description: string }> = {
  chat: { title: "Chat", description: "Assign a mission, NEXUS orchestrates the rest." },
  domotique: {
    title: "Domotique & Satellites",
    description:
      "Supervision domotique, contrôle des pièces de vie, télémétrie acoustique et flotte de satellites vocaux ESP32.",
  },
  satellites: {
    title: "Domotique & Satellites",
    description:
      "Supervision domotique, contrôle des pièces de vie, télémétrie acoustique et flotte de satellites vocaux ESP32.",
  },
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
  "settings-preferences": {
    title: "Preferences & Themes",
    description: "Visual appearance, light/dark mode, language, and desktop interface options.",
  },
  "settings-shortcuts": {
    title: "Keybindings",
    description: "Configurable keyboard shortcuts and productivity hotkeys.",
  },
  "settings-engine": {
    title: "LLM Engines & Routing",
    description: "Configure local models, fallback chains, and external API providers.",
  },
  "settings-secrets": {
    title: "API Keys & Secrets",
    description: "Encrypted credentials, provider access tokens, and environment secrets.",
  },
  "settings-backup": {
    title: "Backup & Restore",
    description: "Snapshot configurations, export state, and restore previous checkpoints.",
  },
  "quota-forecast": {
    title: "Usage & Overview",
    description: "Real-time token telemetry, consumption trends, and cost analytics.",
  },
  "usage-limits": {
    title: "Limits & Resets",
    description: "Capacity gauges, sliding 5-hour windows, and weekly refresh countdowns.",
  },
  "usage-costs": {
    title: "Cost Breakdown",
    description: "T3 Code style cost breakdown by model, provider tier, and cache utilization.",
  },
  "usage-tokens": {
    title: "Token Stream & Metrics",
    description: "Granular prompt, completion, cache read/write token distributions.",
  },
  overview: {
    title: "Overview",
    description: "Operational state of NEXUS at a glance.",
  },
  devices: { title: "Devices", description: "Paired machines, trust levels, and permissions." },
  satellites: {
    title: "Satellites",
    description: "ESP32 hardware satellites, acoustic monitoring, room telemetry, and command bus.",
  },
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
  observability: {
    title: "Observability",
    description: "Service health, mission engine, MCP servers, recent errors and incident lookup.",
  },
  organizations: {
    title: "Organizations",
    description: "Organizations you belong to, their members and roles.",
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
  const { t, tr, locale } = useI18n();
  const [authenticated, setAuthenticated] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const session = useMemo(() => createSession(backendUrl(), () => setAuthenticated(false)), []);
  const api = useMemo(() => new DashboardApi(session), [session]);
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  const [refreshKey, setRefreshKey] = useState(0);
  const [systemPause, setSystemPause] = useState<SystemPauseState | null>(null);

  const rootMode: "supervision" | "lab" | "usage" | "settings" = useMemo(() => {
    if (isLabSection(section)) return "lab";
    if (isUsageSection(section)) return "usage";
    if (isSettingsSection(section)) return "settings";
    return "supervision";
  }, [section]);

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
          3: "career-education",
          4: "trading-lab",
          5: "osint",
          6: "domotique",
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

  const metaTitle = t(`meta.${section}.title`) ?? PAGE_META[section]?.title ?? section;
  const metaDescription = t(`meta.${section}.description`) ?? PAGE_META[section]?.description ?? "";

  return (
    <div className="app">
      <aside className="sidebar">
        {/* Top Header / Mode Switcher */}
        {rootMode === "supervision" ? (
          <button className="nexus-home" type="button" onClick={() => navigate("chat")}>
            <NexusLogo size={32} />
            <span>
              <strong>NEXUS</strong>
              <small>{t("nav.groups.supervision")}</small>
            </span>
          </button>
        ) : (
          <div className="sidebar-mode-header">
            <button
              className="sidebar-back-btn"
              type="button"
              onClick={() => navigate("chat")}
              title={tr("Back to Supervisor", "Retour au Superviseur")}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              <span>{tr("Supervisor", "Superviseur")}</span>
            </button>
            <div className="sidebar-mode-badge">
              {rootMode === "lab" && (
                <>
                  <IconLab size={15} />
                  <span>{tr("LABORATORY", "LABORATOIRE")}</span>
                </>
              )}
              {rootMode === "usage" && (
                <>
                  <IconUsage size={15} />
                  <span>{tr("USAGE & TELEMETRY", "USAGE & TÉLÉMÉTRIE")}</span>
                </>
              )}
              {rootMode === "settings" && (
                <>
                  <IconSettings size={15} />
                  <span>{tr("SETTINGS", "PARAMÈTRES")}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Dynamic Navigation for the active mode */}
        <nav className={`navigation navigation-${rootMode}`} aria-label={`${rootMode} navigation`}>
          {rootMode === "supervision" && (
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
            </div>
          )}

          {rootMode === "lab" && (
            <div className="nav-group nav-lab">
              <NavItem
                id="domotique"
                label={locale === "fr" ? "Domotique & Satellites" : "Smart Home & Satellites"}
                icon="domotique"
                current={section === "satellites" ? "domotique" : section}
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
                label={t("nav.items.osint") || "Espace OSINT"}
                icon="osint"
                current={section}
                onSelect={navigate}
              />
              <NavItem
                id="career-education"
                label={t("nav.items.career-education") || "Carrière & Éducation"}
                icon="career"
                current={section}
                onSelect={navigate}
              />
            </div>
          )}


          {rootMode === "usage" && (
            <div className="nav-group nav-usage">
              <NavItem
                id="quota-forecast"
                label={tr("Usage & Overview", "Vue d'ensemble & Quotas")}
                icon="overview"
                current={section}
                onSelect={navigate}
              />
              <NavItem
                id="usage-limits"
                label={tr("Limits & Resets", "Limites & Resets (%)")}
                icon="usage"
                current={section}
                onSelect={navigate}
              />
              <NavItem
                id="usage-costs"
                label={tr("Cost & Billing", "Coûts & Facturation")}
                icon="secrets"
                current={section}
                onSelect={navigate}
              />
              <NavItem
                id="usage-tokens"
                label={tr("Token Breakdown", "Détail des Tokens")}
                icon="engine"
                current={section}
                onSelect={navigate}
              />
            </div>
          )}

          {rootMode === "settings" && (
            <div className="nav-group nav-settings-categories">
              {SETTINGS_CATEGORIES.map((cat) => (
                <div key={cat.id} className="nav-settings-cat-group">
                  <div className="nav-settings-cat-title">
                    {locale === "fr" ? cat.label : cat.labelEn}
                  </div>
                  {cat.items.map((item) => (
                    <NavItem
                      key={item.id}
                      id={item.id}
                      label={locale === "fr" ? item.label : item.labelEn}
                      icon={item.icon}
                      current={
                        section === "settings" && item.id === "settings-preferences"
                          ? item.id
                          : section
                      }
                      onSelect={navigate}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </nav>

        {/* Bottom Quick Dock: Lab, Usage, Settings (Discreet T3 Code style) */}
        <div className="sidebar-bottom-dock">
          <div className="sidebar-dock-group">
            <button
              type="button"
              className={`sidebar-dock-btn ${rootMode === "lab" ? "active" : ""}`}
              onClick={() => navigate(isLabSection(section) ? section : "trading-lab")}
              data-tooltip={tr("Workspaces Lab", "Lab Espaces")}
              aria-label={tr("Workspaces Lab", "Lab Espaces")}
              aria-current={rootMode === "lab" ? "page" : undefined}
            >
              <IconLab size={16} />
            </button>

            <button
              type="button"
              className={`sidebar-dock-btn ${rootMode === "usage" ? "active" : ""}`}
              onClick={() => navigate(isUsageSection(section) ? section : "quota-forecast")}
              data-tooltip={tr("Usage & Quotas", "Usage & Quotas")}
              aria-label={tr("Usage & Quotas", "Usage & Quotas")}
              aria-current={rootMode === "usage" ? "page" : undefined}
            >
              <IconUsage size={16} />
            </button>
          </div>

          <div className="sidebar-dock-spacer" />

          <button
            type="button"
            className={`sidebar-dock-btn ${rootMode === "settings" ? "active" : ""}`}
            onClick={() => navigate(isSettingsSection(section) ? section : "settings-preferences")}
            data-tooltip={tr("Settings", "Paramètres")}
            aria-label={tr("Settings", "Paramètres")}
            aria-current={rootMode === "settings" ? "page" : undefined}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </aside>

      <main className={`main section-${section}`}>
        <header className="header top-bar">
          <div>
            <div className="eyebrow">
              NEXUS /{" "}
              {rootMode === "usage"
                ? tr("USAGE & QUOTAS", "USAGE & QUOTAS")
                : rootMode === "settings"
                  ? tr("SETTINGS", "PARAMÈTRES")
                  : rootMode === "lab"
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

function renderSection(
  section: SectionId,
  api: DashboardApi,
  session: SessionManager,
  navigate: (next: SectionId) => void,
) {
  switch (section) {
    case "chat":
      return <NexusChat api={api} />;
    case "career-education":
      return <CareerEducation client={createCareerEducationClient(session)} />;
    case "trading-lab":
      return <TradingLab api={api} />;
    case "osint":
      return <OsintWorkspace api={api} onOpenMissions={() => navigate("mission-control")} />;
    case "overview":
    case "tasks":
      return <Overview api={api} />;
    case "quota-forecast":
      return <QuotaForecast api={api} />;
    case "usage-limits":
      return <UsageLimits api={api} />;
    case "usage-costs":
      return <UsageCosts api={api} />;
    case "usage-tokens":
      return <UsageTokens api={api} />;
    case "providers":
      return <Providers api={api} />;
    case "agents":
      return <Agents api={api} />;
    case "settings":
    case "settings-preferences":
      return <Settings api={api} defaultTab="preferences" hideTopTabs={true} />;
    case "settings-shortcuts":
      return <Settings api={api} defaultTab="shortcuts" hideTopTabs={true} />;
    case "settings-engine":
      return <Settings api={api} defaultTab="engine" hideTopTabs={true} />;
    case "settings-secrets":
      return <Settings api={api} defaultTab="secrets" hideTopTabs={true} />;
    case "settings-backup":
      return <Settings api={api} defaultTab="backup" hideTopTabs={true} />;
    case "devices":
      return <Devices api={api} />;
    case "domotique":
    case "satellites":
      return <Domotique api={api} />;
    case "mcp":
      return <Mcp api={api} />;
    case "browser":
      return <Browser api={api} />;
    case "memory":
      return <Memory api={api} />;
    case "notifications":
      return <Notifications api={api} />;
    case "mission-control":
      return <MissionControl api={api} />;
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
    lab: "M10 2v7.5L4.5 19.5A2 2 0 0 0 6.2 22h11.6a2 2 0 0 0 1.7-2.5L14 9.5V2M8.5 2h7M7 16h10",
    usage:
      "M12 14.5l3.5-3.5M3.34 18a10 10 0 1 1 17.32 0M12 4v2M5.64 7.64l1.41 1.41M18.36 7.64l-1.41 1.41",
    agents: "M16 18a4 4 0 0 0-8 0m10-7a3 3 0 1 1-6 0m-7 7a3 3 0 0 1 3-3m8 0a3 3 0 0 1 3 3",
    connections: "M8 12h8m-6-4 4 4-4 4M5 5h14v14H5V5Z",
    setup:
      "M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
    shortcuts: "M2 4h20v16H2V4Zm4 4h.01M10 4h.01M14 4h.01M6 12h.01M10 12h.01M14 12h.01M6 16h12",
    secrets: "M15 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 0-6 6m2 2 2-2",
    backup: "M4 4h16v16H4V4Zm4 0v4h8V4M6 14h12",
    engine: "M4 4h16v16H4V4Zm5 5h6v6H9V9Zm-5 3h2m14 0h2M12 4v2m0 14v2",
    overview: "M4 13h6V4H4v9Zm10 7h6V11h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z",
    tasks: "m5 12 4 4L19 6M5 5h7M5 20h14",
    runs: "m8 5 11 7-11 7V5Z",
    missions: "M12 3v4m0 10v4M3 12h4m10 0h4m-6-3a4 4 0 1 1-6 6 4 4 0 0 1 6-6Z",
    devices: "M7 3h10v18H7V3Zm3 15h4",
    domotique:
      "M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z",
    satellites:
      "M4 10a7.5 7.5 0 0 0 10 10M4 6a11.5 11.5 0 0 0 14 14M4 2a15.5 15.5 0 0 0 18 18M4 20a2 2 0 1 0 0 .01",
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
