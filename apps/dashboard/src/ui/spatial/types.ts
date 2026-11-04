/**
 * NEXUS Spatial OS — Core Types & Contracts
 */

export type NativeSpaceId = "command" | "mission" | "code" | "device" | "memory";

export type WindowContentType =
  | "chat"
  | "overview"
  | "tasks"
  | "runs"
  | "mission-control"
  | "dag-debugger"
  | "run-comparison"
  | "code-dual-agent"
  | "vcs-worktrees"
  | "terminal"
  | "diff-viewer"
  | "devices"
  | "workers"
  | "tools"
  | "mcp"
  | "browser"
  | "visual-control"
  | "memory"
  | "security"
  | "logs"
  | "communication-graph"
  | "quota-forecast"
  | "providers"
  | "settings"
  | "shortcuts"
  | "preferences"
  | "agents"
  | "connections"
  | "marketplace"
  | "notifications"
  | "career-education"
  | "trading-lab"
  | "osint";

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface SpatialWindow {
  id: string;
  title: string;
  spaceId: NativeSpaceId;
  type: WindowContentType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  isMinimized: boolean;
  isMaximized: boolean;
  isFloating: boolean;
  isPinned: boolean;
  metadata?: Record<string, unknown> | undefined;
}

export type LayoutMode = "manual" | "assist" | "auto";

export type TilingLayout = "grid" | "split-horizontal" | "split-vertical" | "columns" | "custom";

export interface SpaceConfig {
  id: NativeSpaceId;
  shortcut: string;
  numKey: number;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  defaultLayout: TilingLayout;
}

export interface CommandPaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  category: "Spaces" | "Windows" | "Agents & Code" | "Layouts" | "System";
  shortcut?: string;
  action: () => void;
  icon?: string;
}

export interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  spaceId: NativeSpaceId;
  windows: Omit<SpatialWindow, "zIndex">[];
  camera?: CameraState;
}
