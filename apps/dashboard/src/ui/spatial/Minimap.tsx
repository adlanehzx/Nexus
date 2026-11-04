/**
 * NEXUS Spatial OS — Minimap HUD
 */

import React, { useMemo } from "react";
import type { CameraState, SpatialWindow } from "./types.js";

interface MinimapProps {
  camera: CameraState;
  windows: SpatialWindow[];
  focusedWindowId: string | null;
  onFocusWindow: (id: string) => void;
  onNavigateToPoint: (worldX: number, worldY: number) => void;
}

export function Minimap({
  camera,
  windows,
  focusedWindowId,
  onFocusWindow,
  onNavigateToPoint,
}: MinimapProps) {
  const visibleWindows = useMemo(() => windows.filter((w) => !w.isMinimized), [windows]);

  // Compute world bounds to normalize in minimap
  const { minX, minY, mapWidth, mapHeight } = useMemo(() => {
    let minX = 0;
    let minY = 0;
    let maxX = 1600;
    let maxY = 1000;

    for (const w of visibleWindows) {
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
      maxX = Math.max(maxX, w.x + w.width);
      maxY = Math.max(maxY, w.y + w.height);
    }

    const padding = 100;
    return {
      minX: minX - padding,
      minY: minY - padding,
      mapWidth: Math.max(1200, maxX - minX + padding * 2),
      mapHeight: Math.max(800, maxY - minY + padding * 2),
    };
  }, [visibleWindows]);

  const mapScaleX = 180 / mapWidth;
  const mapScaleY = 120 / mapHeight;

  // Viewport rectangle in world coords
  const vpWorldW = window.innerWidth / camera.zoom;
  const vpWorldH = (window.innerHeight - 70) / camera.zoom;
  const vpWorldX = -camera.x / camera.zoom;
  const vpWorldY = -camera.y / camera.zoom;

  const vpRect = {
    x: Math.max(0, Math.min(180, (vpWorldX - minX) * mapScaleX)),
    y: Math.max(0, Math.min(120, (vpWorldY - minY) * mapScaleY)),
    w: Math.max(10, Math.min(180, vpWorldW * mapScaleX)),
    h: Math.max(10, Math.min(120, vpWorldH * mapScaleY)),
  };

  const handleMinimapClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const targetWorldX = minX + clickX / mapScaleX;
    const targetWorldY = minY + clickY / mapScaleY;
    onNavigateToPoint(targetWorldX, targetWorldY);
  };

  return (
    <div
      className="spatial-minimap-container"
      title="Minimap — Click to navigate"
      onClick={handleMinimapClick}
    >
      <div className="spatial-minimap-content">
        {visibleWindows.map((win) => {
          const winX = (win.x - minX) * mapScaleX;
          const winY = (win.y - minY) * mapScaleY;
          const winW = win.width * mapScaleX;
          const winH = win.height * mapScaleY;
          const isFocused = win.id === focusedWindowId;

          return (
            <div
              key={win.id}
              className={`spatial-minimap-window ${isFocused ? "focused" : ""}`}
              style={{
                left: `${Math.max(0, winX)}px`,
                top: `${Math.max(0, winY)}px`,
                width: `${Math.max(4, winW)}px`,
                height: `${Math.max(4, winH)}px`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onFocusWindow(win.id);
              }}
            />
          );
        })}

        {/* Viewport Box */}
        <div
          className="spatial-minimap-viewport"
          style={{
            left: `${vpRect.x}px`,
            top: `${vpRect.y}px`,
            width: `${vpRect.w}px`,
            height: `${vpRect.h}px`,
          }}
        />
      </div>
    </div>
  );
}
