/**
 * NEXUS Spatial OS — Spatial Canvas Viewport
 * 2D Infinite Canvas, GPU-accelerated camera layer, and gesture navigation.
 */

import React, { useRef, useState, useCallback, useEffect } from "react";
import type { SessionManager } from "@nexus/client-core";
import type { SpatialStore } from "./useSpatialStore.js";
import { SpatialWindowItem } from "./SpatialWindowItem.js";
import { SpatialContentRenderer } from "./SpatialContentRenderer.js";
import { Minimap } from "./Minimap.js";
import { getDigitFromEvent, isEditingText } from "./keyboardUtils.js";
import { getKeybinding, eventMatchesShortcut } from "./keybindingStore.js";
import type { DashboardApi } from "../../lib/api.js";
import type { WindowContentType } from "./types.js";

interface SpatialCanvasProps {
  store: SpatialStore;
  api: DashboardApi;
  session: SessionManager;
}

export function SpatialCanvas({ store, api, session }: SpatialCanvasProps) {
  const {
    camera,
    windows,
    focusedWindowId,
    focusWindow,
    moveWindow,
    resizeWindow,
    toggleMaximize,
    toggleMinimize,
    toggleFloating,
    closeWindow,
    panBy,
    zoomToPoint,
    setCamera,
    showMinimap,
    setShowMinimap,
    fitAll,
    activeSpace,
    setActiveSpace,
    setIsPaletteOpen,
    tileWindows,
    tilingLayout,
    resetCamera,
  } = store;

  const viewportRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Mouse Wheel Zoom centered on cursor
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      // If target is inside a scrollable window content and not holding Ctrl, let the window scroll!
      const isInsideWindowContent = (e.target as HTMLElement).closest(".spatial-window-content");
      if (isInsideWindowContent && !e.ctrlKey) {
        return;
      }
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      zoomToPoint(e.clientX, e.clientY - 42, zoomFactor);
    },
    [zoomToPoint],
  );

  // Background Drag Pan
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only pan if clicking on empty viewport or grid, or middle mouse, or space pressed
      const isCanvasBackground =
        e.target === viewportRef.current ||
        (e.target as HTMLElement).classList.contains("spatial-grid-layer") ||
        (e.target as HTMLElement).classList.contains("spatial-canvas-world");

      if (isCanvasBackground || e.button === 1 || e.altKey) {
        e.preventDefault();
        setIsPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY };

        const handleMouseMove = (moveEvent: MouseEvent) => {
          const dx = moveEvent.clientX - panStartRef.current.x;
          const dy = moveEvent.clientY - panStartRef.current.y;
          panStartRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };
          panBy(dx, dy);
        };

        const handleMouseUp = () => {
          setIsPanning(false);
          document.removeEventListener("mousemove", handleMouseMove);
          document.removeEventListener("mouseup", handleMouseUp);
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
      }
    },
    [panBy],
  );

  // Touch panning and pinch-to-zoom for tablet & mobile
  const touchStateRef = useRef<{ x: number; y: number; dist: number }>({ x: 0, y: 0, dist: 0 });

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const isCanvasBackground =
      e.target === viewportRef.current ||
      (e.target as HTMLElement).classList.contains("spatial-grid-layer") ||
      (e.target as HTMLElement).classList.contains("spatial-canvas-world");
    if (!isCanvasBackground) return;

    const t0 = e.touches[0];
    const t1 = e.touches[1];
    if (e.touches.length === 1 && t0) {
      touchStateRef.current = {
        x: t0.clientX,
        y: t0.clientY,
        dist: 0,
      };
      setIsPanning(true);
    } else if (e.touches.length === 2 && t0 && t1) {
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      touchStateRef.current.dist = dist;
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      if (e.touches.length === 1 && touchStateRef.current.dist === 0 && t0) {
        const dx = t0.clientX - touchStateRef.current.x;
        const dy = t0.clientY - touchStateRef.current.y;
        touchStateRef.current.x = t0.clientX;
        touchStateRef.current.y = t0.clientY;
        panBy(dx, dy);
      } else if (e.touches.length === 2 && touchStateRef.current.dist > 0 && t0 && t1) {
        const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        const factor = dist / touchStateRef.current.dist;
        touchStateRef.current.dist = dist;
        const midX = (t0.clientX + t1.clientX) / 2;
        const midY = (t0.clientY + t1.clientY) / 2;
        zoomToPoint(midX, midY - 42, factor);
      }
    },
    [panBy, zoomToPoint],
  );

  const handleTouchEnd = useCallback(() => {
    setIsPanning(false);
    touchStateRef.current = { x: 0, y: 0, dist: 0 };
  }, []);

  // Keyboard Shortcuts (Omarchy / Hyprland / Universal)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

      // 1. Global Command Palette (Ctrl+K or custom keybinding)
      if (
        eventMatchesShortcut(e, getKeybinding("command-palette")) ||
        (hasModifier && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "p"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        setIsPaletteOpen((prev) => !prev);
        return;
      }

      // If user is typing in an input/textarea, do not intercept other keys
      if (isEditingText()) return;

      const digit = getDigitFromEvent(e);

      // 2. Spaces 1..5 (Custom keybinding or Ctrl/Alt/Meta + 1..5)
      const spaceMap: Record<number, typeof activeSpace> = {
        1: "command",
        2: "mission",
        3: "code",
        4: "device",
        5: "memory",
      };
      for (let s = 1; s <= 5; s++) {
        if (eventMatchesShortcut(e, getKeybinding(`space-${s}`)) || (hasModifier && digit === s)) {
          e.preventDefault();
          e.stopPropagation();
          const targetSpace = spaceMap[s];
          if (targetSpace) {
            setActiveSpace(targetSpace);
          }
          return;
        }
      }

      // 3. Fit All (Ctrl+0 or custom keybinding)
      if (
        eventMatchesShortcut(e, getKeybinding("fit-all")) ||
        (hasModifier && (digit === 0 || e.key === "0"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        fitAll();
        return;
      }

      // 4. Zoom in / Zoom out
      if (
        eventMatchesShortcut(e, getKeybinding("zoom-in")) ||
        (hasModifier && (e.key === "+" || e.key === "=" || e.code === "Equal"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        setCamera((prev) => ({
          ...prev,
          zoom: Math.min(2.0, Number((prev.zoom * 1.2).toFixed(2))),
        }));
        return;
      }
      if (
        eventMatchesShortcut(e, getKeybinding("zoom-out")) ||
        (hasModifier && (e.key === "-" || e.code === "Minus"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        setCamera((prev) => ({
          ...prev,
          zoom: Math.max(0.4, Number((prev.zoom / 1.2).toFixed(2))),
        }));
        return;
      }

      // 5. Reset camera (Escape or custom keybinding)
      if (
        eventMatchesShortcut(e, getKeybinding("reset-camera")) ||
        e.key === "Escape" ||
        (hasModifier && e.key === "Backspace")
      ) {
        e.preventDefault();
        resetCamera();
        return;
      }

      // 6. Toggle Minimap (Ctrl+M or custom)
      if (
        eventMatchesShortcut(e, getKeybinding("toggle-minimap")) ||
        (hasModifier && e.key.toLowerCase() === "m")
      ) {
        e.preventDefault();
        e.stopPropagation();
        setShowMinimap((prev) => !prev);
        return;
      }

      // 7. Maximize window (Ctrl+Enter or custom)
      if (
        eventMatchesShortcut(e, getKeybinding("toggle-maximize")) ||
        (hasModifier && e.key === "Enter")
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (focusedWindowId) toggleMaximize(focusedWindowId);
        return;
      }

      // 8. Close window (Ctrl+W or custom)
      if (
        eventMatchesShortcut(e, getKeybinding("close-window")) ||
        (hasModifier && e.key.toLowerCase() === "w") ||
        (e.altKey && e.key.toLowerCase() === "q")
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (focusedWindowId) closeWindow(focusedWindowId);
        return;
      }

      // 9. Toggle Floating (Ctrl+F or custom)
      if (
        eventMatchesShortcut(e, getKeybinding("toggle-floating")) ||
        (hasModifier && e.key.toLowerCase() === "f")
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (focusedWindowId) toggleFloating(focusedWindowId);
        return;
      }

      // 10. Cycle Tiling Layouts (Ctrl+Shift+S or custom)
      if (
        eventMatchesShortcut(e, getKeybinding("cycle-tiling")) ||
        (hasModifier && e.key.toLowerCase() === "s")
      ) {
        e.preventDefault();
        e.stopPropagation();
        const layouts: (typeof tilingLayout)[] = [
          "grid",
          "split-horizontal",
          "split-vertical",
          "columns",
        ];
        const curIdx = layouts.indexOf(tilingLayout);
        const nextLayout = layouts[(curIdx + 1) % layouts.length] ?? "grid";
        tileWindows(activeSpace, nextLayout);
        return;
      }

      // 11. Cycle focused window (Ctrl+Tab or custom)
      if (
        eventMatchesShortcut(e, getKeybinding("cycle-window")) ||
        (hasModifier && e.key === "Tab")
      ) {
        e.preventDefault();
        e.stopPropagation();
        const visibleWins = windows.filter((w) => !w.isMinimized);
        if (visibleWins.length > 1) {
          const curIdx = visibleWins.findIndex((w) => w.id === focusedWindowId);
          const nextIdx = e.shiftKey
            ? (curIdx - 1 + visibleWins.length) % visibleWins.length
            : (curIdx + 1) % visibleWins.length;
          const targetWin = visibleWins[nextIdx];
          if (targetWin) {
            focusWindow(targetWin.id);
          }
        }
        return;
      }

      // 12. Directional Navigation: Arrow keys or Vim H/J/K/L
      const isArrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
      const isVim = ["h", "j", "k", "l"].includes(e.key.toLowerCase());
      if (hasModifier && (isArrow || isVim)) {
        e.preventDefault();
        e.stopPropagation();
        let dir = e.key.toLowerCase();
        if (e.key === "ArrowLeft") dir = "h";
        if (e.key === "ArrowDown") dir = "j";
        if (e.key === "ArrowUp") dir = "k";
        if (e.key === "ArrowRight") dir = "l";

        const visibleWins = windows.filter((w) => !w.isMinimized);
        if (visibleWins.length === 0) return;

        const currentWin = visibleWins.find((w) => w.id === focusedWindowId) ?? visibleWins[0];
        if (!currentWin) return;
        let bestCandidate = currentWin;
        let minDistance = Infinity;

        for (const w of visibleWins) {
          if (w.id === currentWin.id) continue;
          let isDirectionMatch = false;
          if (dir === "h" && w.x < currentWin.x) isDirectionMatch = true;
          if (dir === "l" && w.x > currentWin.x) isDirectionMatch = true;
          if (dir === "k" && w.y < currentWin.y) isDirectionMatch = true;
          if (dir === "j" && w.y > currentWin.y) isDirectionMatch = true;

          if (isDirectionMatch) {
            const dist = Math.hypot(w.x - currentWin.x, w.y - currentWin.y);
            if (dist < minDistance) {
              minDistance = dist;
              bestCandidate = w;
            }
          }
        }

        if (bestCandidate && bestCandidate.id !== currentWin.id) {
          focusWindow(bestCandidate.id);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    activeSpace,
    focusedWindowId,
    windows,
    tilingLayout,
    setActiveSpace,
    setIsPaletteOpen,
    setShowMinimap,
    fitAll,
    setCamera,
    closeWindow,
    toggleMaximize,
    toggleFloating,
    tileWindows,
    focusWindow,
    resetCamera,
  ]);

  const handleMinimapNavigate = (worldX: number, worldY: number) => {
    const vpW = window.innerWidth;
    const vpH = window.innerHeight - 70;
    setCamera((prev) => ({
      ...prev,
      x: vpW / 2 - worldX * prev.zoom,
      y: vpH / 2 - worldY * prev.zoom,
    }));
  };

  return (
    <div
      ref={viewportRef}
      className={`spatial-canvas-viewport ${isPanning ? "is-panning" : ""}`}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Background Adaptive Dot Grid */}
      <div
        className="spatial-grid-layer"
        style={{
          transform: `translate(${camera.x % (32 * camera.zoom)}px, ${
            camera.y % (32 * camera.zoom)
          }px) scale(${camera.zoom})`,
        }}
      />

      {/* World Transform Layer (GPU Matrix/Translate3D) */}
      <div
        className="spatial-canvas-world"
        style={{
          transform: `translate3d(${camera.x}px, ${camera.y}px, 0px) scale(${camera.zoom})`,
        }}
      >
        {windows.map((win) => {
          const isFocused = win.id === focusedWindowId;
          return (
            <SpatialWindowItem
              key={win.id}
              window={win}
              camera={camera}
              isFocused={isFocused}
              onFocus={() => focusWindow(win.id)}
              onMove={(x, y) => moveWindow(win.id, x, y)}
              onResize={(w, h) => resizeWindow(win.id, w, h)}
              onToggleMaximize={() => toggleMaximize(win.id)}
              onToggleMinimize={() => toggleMinimize(win.id)}
              onToggleFloating={() => toggleFloating(win.id)}
              onClose={() => closeWindow(win.id)}
            >
              <SpatialContentRenderer
                window={win}
                api={api}
                session={session}
                onNavigate={(type) => store.openWindow(type as WindowContentType, type)}
              />
            </SpatialWindowItem>
          );
        })}
      </div>

      {/* Floating Recenter & Zoom Pill HUD when panned away */}
      {(Math.abs(camera.x) > 200 ||
        Math.abs(camera.y) > 150 ||
        Math.abs(camera.zoom - 1.0) > 0.1) && (
        <div className="spatial-recenter-pill" role="status">
          <button
            type="button"
            className="spatial-recenter-btn"
            onClick={fitAll}
            title="Recentrer toutes les fenêtres (Ctrl+0)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
            <span>Recentrer (Ctrl+0)</span>
          </button>
          <button
            type="button"
            className="spatial-reset-btn"
            onClick={resetCamera}
            title="Réinitialiser zoom 100% (Échap)"
          >
            {Math.round(camera.zoom * 100)}%
          </button>
        </div>
      )}

      {/* Minimap HUD (Bottom-right) */}
      {showMinimap && (
        <Minimap
          camera={camera}
          windows={windows}
          focusedWindowId={focusedWindowId}
          onFocusWindow={focusWindow}
          onNavigateToPoint={handleMinimapNavigate}
        />
      )}
    </div>
  );
}
