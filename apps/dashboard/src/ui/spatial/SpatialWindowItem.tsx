/**
 * NEXUS Spatial OS — Spatial Window Frame & Window Manager
 */

import React, { useState, useRef, useCallback } from "react";
import type { SpatialWindow, CameraState } from "./types.js";
import { IconClose, IconPin, IconKanban, IconMaximize, IconMinimize } from "../icons.js";

interface SpatialWindowItemProps {
  window: SpatialWindow;
  camera: CameraState;
  isFocused: boolean;
  onFocus: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (width: number, height: number) => void;
  onToggleMaximize: () => void;
  onToggleMinimize: () => void;
  onToggleFloating: () => void;
  onClose: () => void;
  children: React.ReactNode;
}

export function SpatialWindowItem({
  window: win,
  camera,
  isFocused,
  onFocus,
  onMove,
  onResize,
  onToggleMaximize,
  onToggleMinimize,
  onToggleFloating,
  onClose,
  children,
}: SpatialWindowItemProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; winX: number; winY: number }>({
    mouseX: 0,
    mouseY: 0,
    winX: 0,
    winY: 0,
  });

  // Handle Drag Move (via Titlebar)
  const handleTitlebarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (win.isMaximized) return;
      if ((e.target as HTMLElement).closest(".spatial-win-btn")) return;
      e.preventDefault();
      onFocus();
      setIsDragging(true);
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        winX: win.x,
        winY: win.y,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = (moveEvent.clientX - dragStartRef.current.mouseX) / camera.zoom;
        const deltaY = (moveEvent.clientY - dragStartRef.current.mouseY) / camera.zoom;
        const nextX = Math.round(dragStartRef.current.winX + deltaX);
        const nextY = Math.round(dragStartRef.current.winY + deltaY);
        onMove(nextX, nextY);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [win.isMaximized, win.x, win.y, camera.zoom, onFocus, onMove],
  );

  // Handle Resizing (8 directions)
  const startResize = useCallback(
    (direction: string, e: React.MouseEvent) => {
      if (win.isMaximized) return;
      e.preventDefault();
      e.stopPropagation();
      onFocus();

      const startX = e.clientX;
      const startY = e.clientY;
      const startW = win.width;
      const startH = win.height;
      const startPosX = win.x;
      const startPosY = win.y;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = (moveEvent.clientX - startX) / camera.zoom;
        const deltaY = (moveEvent.clientY - startY) / camera.zoom;

        let newW = startW;
        let newH = startH;
        let newX = startPosX;
        let newPosY = startPosY;

        if (direction.includes("e")) newW = Math.max(320, startW + deltaX);
        if (direction.includes("s")) newH = Math.max(200, startH + deltaY);
        if (direction.includes("w")) {
          const potW = startW - deltaX;
          if (potW >= 320) {
            newW = potW;
            newX = startPosX + deltaX;
          }
        }
        if (direction.includes("n")) {
          const potH = startH - deltaY;
          if (potH >= 200) {
            newH = potH;
            newPosY = startPosY + deltaY;
          }
        }

        if (newX !== startPosX || newPosY !== startPosY) {
          onMove(Math.round(newX), Math.round(newPosY));
        }
        onResize(Math.round(newW), Math.round(newH));
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [win.isMaximized, win.width, win.height, win.x, win.y, camera.zoom, onFocus, onMove, onResize],
  );

  if (win.isMinimized) return null;

  return (
    <div
      className={`spatial-window ${isFocused ? "focused" : ""} ${win.isMaximized ? "maximized" : ""} ${
        isDragging ? "dragging" : ""
      }`}
      style={{
        left: `${win.x}px`,
        top: `${win.y}px`,
        width: `${win.width}px`,
        height: `${win.height}px`,
        zIndex: win.zIndex,
      }}
      onMouseDown={onFocus}
    >
      {/* Titlebar / Drag Handle */}
      <div className="spatial-window-titlebar" onMouseDown={handleTitlebarMouseDown}>
        <div className="spatial-window-info">
          <span className="spatial-window-space-tag">{win.spaceId}</span>
          <span className="spatial-window-title" title={win.title}>
            {win.title}
          </span>
        </div>

        <div className="spatial-window-controls">
          <button
            type="button"
            className="spatial-win-btn"
            title={win.isFloating ? "Mode Tiled (Alt+F)" : "Mode Floating (Alt+F)"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFloating();
            }}
          >
            {win.isFloating ? <IconPin size={11} /> : <IconKanban size={11} />}
          </button>
          <button
            type="button"
            className="spatial-win-btn"
            title="Minimiser"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMinimize();
            }}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3 11h10v2H3z" />
            </svg>
          </button>
          <button
            type="button"
            className="spatial-win-btn"
            title={win.isMaximized ? "Restaurer (Alt+Enter)" : "Maximiser (Alt+Enter)"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize();
            }}
          >
            {win.isMaximized ? <IconMinimize size={10} /> : <IconMaximize size={10} />}
          </button>
          <button
            type="button"
            className="spatial-win-btn close"
            title="Fermer"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <IconClose size={11} />
          </button>
        </div>
      </div>

      {/* Main Component Content Container */}
      <div className="spatial-window-content">{children}</div>

      {/* Resize Handles (8 directions) */}
      {!win.isMaximized && (
        <>
          <div
            className="spatial-resize-handle spatial-resize-n"
            onMouseDown={(e) => startResize("n", e)}
          />
          <div
            className="spatial-resize-handle spatial-resize-s"
            onMouseDown={(e) => startResize("s", e)}
          />
          <div
            className="spatial-resize-handle spatial-resize-w"
            onMouseDown={(e) => startResize("w", e)}
          />
          <div
            className="spatial-resize-handle spatial-resize-e"
            onMouseDown={(e) => startResize("e", e)}
          />
          <div
            className="spatial-resize-handle spatial-resize-nw"
            onMouseDown={(e) => startResize("nw", e)}
          />
          <div
            className="spatial-resize-handle spatial-resize-ne"
            onMouseDown={(e) => startResize("ne", e)}
          />
          <div
            className="spatial-resize-handle spatial-resize-sw"
            onMouseDown={(e) => startResize("sw", e)}
          />
          <div
            className="spatial-resize-handle spatial-resize-se"
            onMouseDown={(e) => startResize("se", e)}
          />
        </>
      )}
    </div>
  );
}
