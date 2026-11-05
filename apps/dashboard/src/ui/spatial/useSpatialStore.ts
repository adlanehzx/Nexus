/**
 * NEXUS Spatial OS — State Store & Window Manager
 */

import { useState, useEffect, useCallback } from "react";
import type {
  CameraState,
  NativeSpaceId,
  SpatialWindow,
  LayoutMode,
  TilingLayout,
  WindowContentType,
} from "./types.js";

const STORAGE_KEY = "nexus_spatial_state_v1";

export const SPACE_CONFIGS: Record<
  NativeSpaceId,
  { label: string; labelEn: string; shortcut: string; num: number; description: string }
> = {
  command: {
    label: "Command",
    labelEn: "Command Space",
    shortcut: "Ctrl+1",
    num: 1,
    description: "Assistant conversationnel, missions et santé système",
  },
  mission: {
    label: "Mission",
    labelEn: "Mission Space",
    shortcut: "Ctrl+2",
    num: 2,
    description: "Orchestration interactive et graphes DAG",
  },
  code: {
    label: "Code",
    labelEn: "Code Space",
    shortcut: "Ctrl+3",
    num: 3,
    description: "Développement T3 Code, agents jumeaux, Git et worktrees",
  },
  device: {
    label: "Device",
    labelEn: "Device Space",
    shortcut: "Ctrl+4",
    num: 4,
    description: "Topologie des machines, workers et visual control",
  },
  memory: {
    label: "Memory",
    labelEn: "Memory Space",
    shortcut: "Ctrl+5",
    num: 5,
    description: "Mémoire sémantique, connaissances et gouvernance",
  },
};

export const INITIAL_WINDOWS_PER_SPACE: Record<NativeSpaceId, SpatialWindow[]> = {
  command: [
    {
      id: "cmd-chat-1",
      title: "Assistant Exécutif NEXUS",
      spaceId: "command",
      type: "chat",
      x: 40,
      y: 40,
      width: 760,
      height: 720,
      zIndex: 10,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "cmd-tasks-1",
      title: "File d'attente des Tâches",
      spaceId: "command",
      type: "tasks",
      x: 820,
      y: 40,
      width: 580,
      height: 350,
      zIndex: 11,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "cmd-overview-1",
      title: "Vue d'ensemble du Système",
      spaceId: "command",
      type: "overview",
      x: 820,
      y: 410,
      width: 580,
      height: 350,
      zIndex: 12,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
  ],
  mission: [
    {
      id: "msn-dag-1",
      title: "Débogueur de Graphe DAG",
      spaceId: "mission",
      type: "dag-debugger",
      x: 40,
      y: 40,
      width: 840,
      height: 720,
      zIndex: 10,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "msn-ctrl-1",
      title: "Missions ACP en cours",
      spaceId: "mission",
      type: "mission-control",
      x: 900,
      y: 40,
      width: 540,
      height: 400,
      zIndex: 11,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "msn-logs-1",
      title: "Journaux d'Orchestration",
      spaceId: "mission",
      type: "logs",
      x: 900,
      y: 460,
      width: 540,
      height: 300,
      zIndex: 12,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
  ],
  code: [
    {
      id: "code-claude-1",
      title: "Agent Claude 3.7 Sonnet (T3)",
      spaceId: "code",
      type: "chat",
      x: 40,
      y: 40,
      width: 680,
      height: 480,
      zIndex: 10,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
      metadata: { provider: "claude", role: "Frontend & Architecture" },
    },
    {
      id: "code-codex-1",
      title: "Agent Cursor / Codex (T3)",
      spaceId: "code",
      type: "chat",
      x: 740,
      y: 40,
      width: 680,
      height: 480,
      zIndex: 11,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
      metadata: { provider: "cursor", role: "Backend & Systems" },
    },
    {
      id: "code-vcs-1",
      title: "VCS & Worktrees Git Isolés",
      spaceId: "code",
      type: "vcs-worktrees",
      x: 40,
      y: 540,
      width: 820,
      height: 350,
      zIndex: 12,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "code-runs-1",
      title: "Exécutions d'agents & Tests",
      spaceId: "code",
      type: "runs",
      x: 880,
      y: 540,
      width: 540,
      height: 350,
      zIndex: 13,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
  ],
  device: [
    {
      id: "dev-mesh-1",
      title: "Topologie des Appareils",
      spaceId: "device",
      type: "devices",
      x: 40,
      y: 40,
      width: 760,
      height: 720,
      zIndex: 10,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "dev-workers-1",
      title: "Pool de Workers Distribués",
      spaceId: "device",
      type: "workers",
      x: 820,
      y: 40,
      width: 600,
      height: 340,
      zIndex: 11,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "dev-browser-1",
      title: "Browser Worker & Visual Control",
      spaceId: "device",
      type: "browser",
      x: 820,
      y: 400,
      width: 600,
      height: 360,
      zIndex: 12,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
  ],
  memory: [
    {
      id: "mem-search-1",
      title: "Explorateur de Mémoire Sémantique",
      spaceId: "memory",
      type: "memory",
      x: 40,
      y: 40,
      width: 820,
      height: 720,
      zIndex: 10,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "mem-graph-1",
      title: "Graphe de Communication & Provenance",
      spaceId: "memory",
      type: "communication-graph",
      x: 880,
      y: 40,
      width: 560,
      height: 400,
      zIndex: 11,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
    {
      id: "mem-sec-1",
      title: "Sécurité & Garde-fous",
      spaceId: "memory",
      type: "security",
      x: 880,
      y: 460,
      width: 560,
      height: 300,
      zIndex: 12,
      isMinimized: false,
      isMaximized: false,
      isFloating: false,
      isPinned: false,
    },
  ],
};

export interface SpatialStoreState {
  activeSpace: NativeSpaceId;
  camera: CameraState;
  camerasPerSpace: Record<NativeSpaceId, CameraState>;
  windows: Record<NativeSpaceId, SpatialWindow[]>;
  focusedWindowId: string | null;
  layoutMode: LayoutMode;
  tilingLayout: TilingLayout;
  showMinimap: boolean;
  isPaletteOpen: boolean;
}

/** Starts below the shell's bars, which float above the canvas. */
const DEFAULT_CAMERA: CameraState = { x: 0, y: 40, zoom: 1.0 };

/** Height covered by the top and hint bars, and the gap kept around a new window. */
const SHELL_CHROME_HEIGHT = 70;
const WINDOW_MARGIN = 16;

interface PersistedSpatialState {
  windows?: Record<NativeSpaceId, SpatialWindow[]>;
  activeSpace?: NativeSpaceId;
  camerasPerSpace?: Record<NativeSpaceId, CameraState>;
  layoutMode?: LayoutMode;
  showMinimap?: boolean;
}

function readPersistedState(): PersistedSpatialState {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = saved === null ? null : JSON.parse(saved);
    if (typeof parsed !== "object" || parsed === null) return {};
    const state = parsed as PersistedSpatialState;
    return state.windows !== undefined && state.activeSpace !== undefined ? state : {};
  } catch {
    return {};
  }
}

export function useSpatialStore() {
  // Read while initializing state: restoring from an effect races with the effect that saves,
  // which then overwrites what was stored with the defaults.
  const [persisted] = useState(readPersistedState);
  const [activeSpace, setActiveSpaceState] = useState<NativeSpaceId>(
    persisted.activeSpace ?? "command",
  );
  const [camerasPerSpace, setCamerasPerSpace] = useState<Record<NativeSpaceId, CameraState>>(
    persisted.camerasPerSpace ?? {
      command: { ...DEFAULT_CAMERA },
      mission: { ...DEFAULT_CAMERA },
      code: { ...DEFAULT_CAMERA },
      device: { ...DEFAULT_CAMERA },
      memory: { ...DEFAULT_CAMERA },
    },
  );
  const [windows, setWindows] = useState<Record<NativeSpaceId, SpatialWindow[]>>(
    persisted.windows ?? INITIAL_WINDOWS_PER_SPACE,
  );
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>("cmd-chat-1");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(persisted.layoutMode ?? "manual");
  const [tilingLayout, setTilingLayout] = useState<TilingLayout>("grid");
  const [showMinimap, setShowMinimap] = useState<boolean>(persisted.showMinimap ?? true);
  const [isPaletteOpen, setIsPaletteOpen] = useState<boolean>(false);

  // Save to sessionStorage on change
  useEffect(() => {
    try {
      const payload = {
        version: 1,
        activeSpace,
        camerasPerSpace,
        windows,
        layoutMode,
        showMinimap,
      };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // storage full or disabled
    }
  }, [activeSpace, camerasPerSpace, windows, layoutMode, showMinimap]);

  const currentCamera = camerasPerSpace[activeSpace] ?? DEFAULT_CAMERA;

  const setCamera = useCallback(
    (updater: CameraState | ((prev: CameraState) => CameraState)) => {
      setCamerasPerSpace((prev) => {
        const cur = prev[activeSpace] ?? DEFAULT_CAMERA;
        const next = typeof updater === "function" ? updater(cur) : updater;
        // Clamp zoom between 0.4 and 2.0 (prevents microscopic or gargantuan distortion)
        const clampedZoom = Math.min(2.0, Math.max(0.4, Number(next.zoom.toFixed(3))));
        // Bound panning so the user can never get lost in infinite void
        const maxPanX = 1800;
        const minPanX = -1800;
        const maxPanY = 1400;
        const minPanY = -1400;
        const clampedX = Math.min(maxPanX, Math.max(minPanX, Math.round(next.x)));
        const clampedY = Math.min(maxPanY, Math.max(minPanY, Math.round(next.y)));
        return {
          ...prev,
          [activeSpace]: { x: clampedX, y: clampedY, zoom: clampedZoom },
        };
      });
    },
    [activeSpace],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setCamera((prev) => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy,
      }));
    },
    [setCamera],
  );

  const zoomToPoint = useCallback(
    (clientX: number, clientY: number, deltaFactor: number) => {
      setCamera((prev) => {
        const newZoom = Math.min(2.5, Math.max(0.25, prev.zoom * deltaFactor));
        if (newZoom === prev.zoom) return prev;
        const newX = clientX - (clientX - prev.x) * (newZoom / prev.zoom);
        const newY = clientY - (clientY - prev.y) * (newZoom / prev.zoom);
        return { x: newX, y: newY, zoom: newZoom };
      });
    },
    [setCamera],
  );

  const resetCamera = useCallback(() => {
    setCamera({ ...DEFAULT_CAMERA });
  }, [setCamera]);

  const fitAll = useCallback(() => {
    const curWindows = windows[activeSpace]?.filter((w) => !w.isMinimized) ?? [];
    if (curWindows.length === 0) {
      resetCamera();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of curWindows) {
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
      maxX = Math.max(maxX, w.x + w.width);
      maxY = Math.max(maxY, w.y + w.height);
    }
    const worldW = maxX - minX + 80;
    const worldH = maxY - minY + 80;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight - 70;
    const scaleX = vpW / worldW;
    const scaleY = vpH / worldH;
    const targetZoom = Math.min(1.2, Math.max(0.35, Math.min(scaleX, scaleY)));
    const targetX = (vpW - worldW * targetZoom) / 2 - minX * targetZoom + 40 * targetZoom;
    const targetY = (vpH - worldH * targetZoom) / 2 - minY * targetZoom + 40 * targetZoom;
    setCamera({ x: targetX, y: targetY, zoom: targetZoom });
  }, [windows, activeSpace, resetCamera, setCamera]);

  const setActiveSpace = useCallback(
    (spaceId: NativeSpaceId) => {
      setActiveSpaceState(spaceId);
      const spaceWins = windows[spaceId] ?? [];
      const firstWin = spaceWins[0];
      if (firstWin) {
        setFocusedWindowId(firstWin.id);
      }
    },
    [windows],
  );

  const focusWindow = useCallback(
    (windowId: string) => {
      setFocusedWindowId(windowId);
      setWindows((prev) => {
        const spaceWins = prev[activeSpace] ?? [];
        const highestZ = spaceWins.reduce((max, w) => Math.max(max, w.zIndex), 10);
        const updated = spaceWins.map((w) =>
          w.id === windowId ? { ...w, zIndex: highestZ + 1, isMinimized: false } : w,
        );
        return { ...prev, [activeSpace]: updated };
      });
    },
    [activeSpace],
  );

  const moveWindow = useCallback(
    (windowId: string, x: number, y: number) => {
      setWindows((prev) => {
        const spaceWins = prev[activeSpace] ?? [];
        const updated = spaceWins.map((w) => (w.id === windowId ? { ...w, x, y } : w));
        return { ...prev, [activeSpace]: updated };
      });
    },
    [activeSpace],
  );

  const resizeWindow = useCallback(
    (windowId: string, width: number, height: number) => {
      const clampedW = Math.max(320, width);
      const clampedH = Math.max(200, height);
      setWindows((prev) => {
        const spaceWins = prev[activeSpace] ?? [];
        const updated = spaceWins.map((w) =>
          w.id === windowId ? { ...w, width: clampedW, height: clampedH } : w,
        );
        return { ...prev, [activeSpace]: updated };
      });
    },
    [activeSpace],
  );

  const toggleMaximize = useCallback(
    (windowId: string) => {
      setWindows((prev) => {
        const spaceWins = prev[activeSpace] ?? [];
        const updated = spaceWins.map((w) =>
          w.id === windowId ? { ...w, isMaximized: !w.isMaximized, isMinimized: false } : w,
        );
        return { ...prev, [activeSpace]: updated };
      });
      setFocusedWindowId(windowId);
    },
    [activeSpace],
  );

  const toggleMinimize = useCallback(
    (windowId: string) => {
      setWindows((prev) => {
        const spaceWins = prev[activeSpace] ?? [];
        const updated = spaceWins.map((w) =>
          w.id === windowId ? { ...w, isMinimized: !w.isMinimized } : w,
        );
        return { ...prev, [activeSpace]: updated };
      });
    },
    [activeSpace],
  );

  const toggleFloating = useCallback(
    (windowId: string) => {
      setWindows((prev) => {
        const spaceWins = prev[activeSpace] ?? [];
        const updated = spaceWins.map((w) =>
          w.id === windowId ? { ...w, isFloating: !w.isFloating } : w,
        );
        return { ...prev, [activeSpace]: updated };
      });
    },
    [activeSpace],
  );

  const closeWindow = useCallback(
    (windowId: string) => {
      setWindows((prev) => {
        const spaceWins = prev[activeSpace] ?? [];
        const updated = spaceWins.filter((w) => w.id !== windowId);
        return { ...prev, [activeSpace]: updated };
      });
      setFocusedWindowId((current) => (current === windowId ? null : current));
    },
    [activeSpace],
  );

  const openWindow = useCallback(
    (
      type: WindowContentType,
      title: string,
      targetSpace?: NativeSpaceId,
      customMetadata?: Record<string, unknown>,
    ) => {
      const space = targetSpace ?? activeSpace;
      const id = `${space}-${type}-${Date.now().toString(36)}`;
      // Placed in what the user is looking at, whatever the camera and screen size.
      const camera = camerasPerSpace[space] ?? DEFAULT_CAMERA;
      const viewWidth = window.innerWidth / camera.zoom;
      const viewHeight = (window.innerHeight - SHELL_CHROME_HEIGHT) / camera.zoom;
      const width = Math.min(720, viewWidth - 2 * WINDOW_MARGIN);
      const height = Math.min(520, viewHeight - 2 * WINDOW_MARGIN);
      const cascade = Math.random() * 40;
      const newWin: SpatialWindow = {
        id,
        title,
        spaceId: space,
        type,
        x:
          -camera.x / camera.zoom +
          WINDOW_MARGIN +
          Math.min(cascade, viewWidth - width - 2 * WINDOW_MARGIN),
        y:
          (SHELL_CHROME_HEIGHT - camera.y) / camera.zoom +
          WINDOW_MARGIN +
          Math.min(cascade, viewHeight - height - 2 * WINDOW_MARGIN),
        width,
        height,
        zIndex: 20,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
        ...(customMetadata ? { metadata: customMetadata } : {}),
      };

      setWindows((prev) => {
        const cur = prev[space] ?? [];
        return { ...prev, [space]: [...cur, newWin] };
      });
      if (space !== activeSpace) {
        setActiveSpaceState(space);
      }
      setFocusedWindowId(id);
    },
    [activeSpace, camerasPerSpace],
  );

  const tileWindows = useCallback(
    (spaceId: NativeSpaceId, layout: TilingLayout) => {
      setTilingLayout(layout);
      setWindows((prev) => {
        const spaceWins = prev[spaceId] ?? [];
        if (spaceWins.length === 0) return prev;
        const count = spaceWins.length;
        const vpW = 1440;
        const vpH = 820;
        let updated: SpatialWindow[];

        if (layout === "split-horizontal" || count === 2) {
          const colW = (vpW - 60) / Math.max(1, count);
          updated = spaceWins.map((w, idx) => ({
            ...w,
            x: 40 + idx * (colW + 20),
            y: 40,
            width: colW,
            height: vpH,
            isMaximized: false,
            isMinimized: false,
            isFloating: false,
          }));
        } else if (layout === "split-vertical") {
          const rowH = (vpH - 60) / Math.max(1, count);
          updated = spaceWins.map((w, idx) => ({
            ...w,
            x: 40,
            y: 40 + idx * (rowH + 20),
            width: vpW,
            height: rowH,
            isMaximized: false,
            isMinimized: false,
            isFloating: false,
          }));
        } else {
          // Default 2x2 grid or quad
          const cols = count > 2 ? 2 : count;
          const rows = Math.ceil(count / cols);
          const cellW = (vpW - 40 * (cols - 1)) / cols;
          const cellH = (vpH - 40 * (rows - 1)) / rows;
          updated = spaceWins.map((w, idx) => {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            return {
              ...w,
              x: 40 + col * (cellW + 20),
              y: 40 + row * (cellH + 20),
              width: cellW,
              height: cellH,
              isMaximized: false,
              isMinimized: false,
              isFloating: false,
            };
          });
        }
        return { ...prev, [spaceId]: updated };
      });
      fitAll();
    },
    [fitAll],
  );

  const resetToDefaultLayout = useCallback(() => {
    setWindows(INITIAL_WINDOWS_PER_SPACE);
    resetCamera();
  }, [resetCamera]);

  return {
    activeSpace,
    setActiveSpace,
    camera: currentCamera,
    setCamera,
    panBy,
    zoomToPoint,
    resetCamera,
    fitAll,
    windows: windows[activeSpace] ?? [],
    allWindows: windows,
    focusedWindowId,
    focusWindow,
    moveWindow,
    resizeWindow,
    toggleMaximize,
    toggleMinimize,
    toggleFloating,
    closeWindow,
    openWindow,
    tileWindows,
    resetToDefaultLayout,
    layoutMode,
    setLayoutMode,
    tilingLayout,
    showMinimap,
    setShowMinimap,
    isPaletteOpen,
    setIsPaletteOpen,
  };
}

export type SpatialStore = ReturnType<typeof useSpatialStore>;
