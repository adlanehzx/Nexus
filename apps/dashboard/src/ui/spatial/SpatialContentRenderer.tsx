/**
 * NEXUS Spatial OS — Content Component Renderer
 * Maps window content types to real NEXUS & T3 Code modules.
 */

import { lazy, Suspense } from "react";
import type { SessionManager } from "@nexus/client-core";
import type { DashboardApi } from "../../lib/api.js";
import type { SpatialWindow } from "./types.js";
import { createCareerEducationClient } from "../../lib/career-education.js";

// Lazy-loaded components matching App.tsx
const NexusChat = lazy(() =>
  import("../NexusChat.js").then(({ NexusChat: c }) => ({ default: c })),
);
const CareerEducation = lazy(() =>
  import("../CareerEducation/index.js").then(({ CareerEducation: c }) => ({ default: c })),
);
const OsintWorkspace = lazy(() =>
  import("../OsintWorkspace.js").then(({ OsintWorkspace: c }) => ({ default: c })),
);
const Settings = lazy(() => import("../Settings.js").then(({ Settings: c }) => ({ default: c })));
const Agents = lazy(() => import("../Agents.js").then(({ Agents: c }) => ({ default: c })));
const Connections = lazy(() =>
  import("../Connections.js").then(({ Connections: c }) => ({ default: c })),
);
const PreferencesPanel = lazy(() =>
  import("../PreferencesPanel.js").then(({ PreferencesPanel: c }) => ({ default: c })),
);
const KeybindingsPanel = lazy(() =>
  import("../KeybindingsPanel.js").then(({ KeybindingsPanel: c }) => ({ default: c })),
);

const sectionModule = () => import("../Sections.js");
const lazySection = <K extends keyof Awaited<ReturnType<typeof sectionModule>>>(name: K) =>
  lazy(() => sectionModule().then((module) => ({ default: module[name] })));

const Overview = lazySection("Overview");
const Tasks = lazySection("Tasks");
const Runs = lazySection("Runs");
const MissionControl = lazySection("MissionControl");
const DagDebugger = lazySection("DagDebugger");
const RunComparison = lazySection("RunComparison");
const VcsWorktrees = lazySection("VcsWorktrees");
const Devices = lazySection("Devices");
const Workers = lazySection("Workers");
const Tools = lazySection("Tools");
const Mcp = lazySection("Mcp");
const Browser = lazySection("Browser");
const VisualControl = lazySection("VisualControl");
const Memory = lazySection("Memory");
const Security = lazySection("Security");
const Logs = lazySection("Logs");
const CommunicationGraph = lazySection("CommunicationGraph");
const QuotaForecast = lazySection("QuotaForecast");
const Providers = lazySection("Providers");
const Organizations = lazySection("Organizations");
const TradingLab = lazySection("TradingLab");
const Marketplace = lazySection("Marketplace");
const Notifications = lazySection("Notifications");

interface ContentRendererProps {
  window: SpatialWindow;
  api: DashboardApi;
  session: SessionManager;
  onNavigate: (type: string) => void;
}

function WindowLoader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--sp-text-dim)",
        fontFamily: "var(--sp-font-mono)",
        fontSize: "12px",
      }}
    >
      <span>Initialisation du module...</span>
    </div>
  );
}

export function SpatialContentRenderer({
  window: win,
  api,
  session,
  onNavigate,
}: ContentRendererProps) {
  return (
    <Suspense fallback={<WindowLoader />}>
      {renderWindowContent(win, api, session, onNavigate)}
    </Suspense>
  );
}

function renderWindowContent(
  win: SpatialWindow,
  api: DashboardApi,
  session: SessionManager,
  onNavigate: (type: string) => void,
) {
  switch (win.type) {
    case "chat":
      return <NexusChat api={api} />;
    case "overview":
      return <Overview api={api} />;
    case "tasks":
      return <Tasks api={api} />;
    case "runs":
      return <Runs api={api} />;
    case "mission-control":
      return <MissionControl api={api} />;
    case "dag-debugger":
      return <DagDebugger api={api} />;
    case "run-comparison":
      return <RunComparison api={api} />;
    case "vcs-worktrees":
      return <VcsWorktrees api={api} />;
    case "devices":
      return <Devices api={api} />;
    case "workers":
      return <Workers api={api} />;
    case "tools":
      return <Tools api={api} />;
    case "mcp":
      return <Mcp api={api} />;
    case "browser":
      return <Browser api={api} />;
    case "visual-control":
      return <VisualControl api={api} />;
    case "memory":
      return <Memory api={api} />;
    case "security":
      return <Security api={api} />;
    case "logs":
      return <Logs api={api} />;
    case "communication-graph":
      return <CommunicationGraph api={api} />;
    case "quota-forecast":
      return <QuotaForecast api={api} />;
    case "providers":
      return <Providers api={api} />;
    case "settings":
      return <Settings api={api} />;
    case "agents":
      return <Agents api={api} />;
    case "connections":
      return <Connections api={api} />;
    case "marketplace":
      return <Marketplace api={api} />;
    case "organizations":
      return <Organizations api={api} />;
    case "notifications":
      return <Notifications api={api} />;
    case "shortcuts":
      return (
        <div style={{ padding: "16px", height: "100%", overflow: "auto" }}>
          <KeybindingsPanel />
        </div>
      );
    case "preferences":
      return (
        <div style={{ padding: "16px", height: "100%", overflow: "auto" }}>
          <PreferencesPanel />
        </div>
      );
    case "career-education":
      return <CareerEducation client={createCareerEducationClient(session)} />;
    case "trading-lab":
      return <TradingLab api={api} />;
    case "osint":
      return <OsintWorkspace api={api} onOpenMissions={() => onNavigate("mission-control")} />;
    default:
      return (
        <div style={{ padding: "20px", color: "var(--sp-text-muted)" }}>
          Contenu du panneau : <strong>{win.title}</strong> ({win.type})
        </div>
      );
  }
}
