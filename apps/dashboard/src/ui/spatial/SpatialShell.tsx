/**
 * NEXUS Spatial OS — Spatial Shell
 * Omarchy top bar, workspace switcher, command palette, and camera HUD.
 */

import { useState, useMemo } from "react";
import type { SessionManager } from "@nexus/client-core";
import type { SpatialStore } from "./useSpatialStore.js";
import { SPACE_CONFIGS } from "./useSpatialStore.js";
import { SpatialCanvas } from "./SpatialCanvas.js";
import { CommandPalette } from "./CommandPalette.js";
import type { CommandPaletteItem, NativeSpaceId } from "./types.js";
import { PRESET_LAYOUTS, analyzeIntentForAssistLayout } from "./AdaptiveLayoutEngine.js";
import { NexusLogo } from "../NexusLogo.js";
import type { DashboardApi } from "../../lib/api.js";

interface SpatialShellProps {
  store: SpatialStore;
  api: DashboardApi;
  session: SessionManager;
  onToggleClassicView?: () => void;
}

export function SpatialShell({ store, api, session, onToggleClassicView }: SpatialShellProps) {
  const {
    activeSpace,
    setActiveSpace,
    camera,
    setCamera,
    resetCamera,
    fitAll,
    windows,
    focusedWindowId,
    layoutMode,
    setLayoutMode,
    showMinimap,
    setShowMinimap,
    isPaletteOpen,
    setIsPaletteOpen,
    openWindow,
    tileWindows,
    resetToDefaultLayout,
  } = store;

  const [assistQuery, setAssistQuery] = useState("");
  const activeSpaceConfig = SPACE_CONFIGS[activeSpace];
  const focusedWin = windows.find((w) => w.id === focusedWindowId);

  // Assist recommendation
  const assistRecommendation = useMemo(() => {
    if (layoutMode !== "assist") return null;
    return analyzeIntentForAssistLayout(assistQuery);
  }, [layoutMode, assistQuery]);

  // Command Palette Items
  const paletteItems: CommandPaletteItem[] = useMemo(() => {
    const list: CommandPaletteItem[] = [];

    // Spaces
    (Object.keys(SPACE_CONFIGS) as NativeSpaceId[]).forEach((spaceId) => {
      const cfg = SPACE_CONFIGS[spaceId];
      list.push({
        id: `space-${spaceId}`,
        title: `Espace ${cfg.label} (${cfg.labelEn})`,
        subtitle: cfg.description,
        category: "Spaces",
        shortcut: cfg.shortcut,
        action: () => setActiveSpace(spaceId),
      });
    });

    // Preset Layouts
    Object.values(PRESET_LAYOUTS).forEach((preset) => {
      list.push({
        id: `preset-${preset.id}`,
        title: `Disposition : ${preset.name}`,
        subtitle: preset.description,
        category: "Layouts",
        action: () => {
          setActiveSpace(preset.spaceId);
          tileWindows(preset.spaceId, "grid");
        },
      });
    });

    // Quick Window Openers
    list.push(
      {
        id: "win-chat",
        title: "Ouvrir Assistant Nexus (Chat)",
        subtitle: "Session de dialogue IA principale",
        category: "Windows",
        action: () => openWindow("chat", "Assistant Exécutif NEXUS"),
      },
      {
        id: "win-vcs",
        title: "Ouvrir VCS & Worktrees Git",
        subtitle: "Worktrees isolés, commits, diffs et branches T3",
        category: "Windows",
        action: () => openWindow("vcs-worktrees", "VCS & Worktrees Git"),
      },
      {
        id: "win-dag",
        title: "Ouvrir Débogueur de Graphe DAG",
        subtitle: "Visualisation temps réel du graphe de mission",
        category: "Windows",
        action: () => openWindow("dag-debugger", "Débogueur de Graphe DAG"),
      },
      {
        id: "win-devices",
        title: "Ouvrir Topologie des Appareils",
        subtitle: "Mesh de machines et workers distribués",
        category: "Windows",
        action: () => openWindow("devices", "Topologie des Appareils"),
      },
      {
        id: "win-memory",
        title: "Ouvrir Explorateur de Mémoire",
        subtitle: "Recherche vectorielle et souvenirs sémantiques",
        category: "Windows",
        action: () => openWindow("memory", "Explorateur de Mémoire"),
      },
      {
        id: "win-overview",
        title: "Ouvrir Vue d'ensemble",
        subtitle: "Télémétrie et métriques système",
        category: "Windows",
        action: () => openWindow("overview", "Vue d'ensemble du Système"),
      },
      {
        id: "win-providers",
        title: "Ouvrir Providers (fournisseurs de modèles)",
        subtitle: "Moteurs, CLI détectés et état réel des connexions",
        category: "Agents & Code",
        action: () => openWindow("providers", "Providers"),
      },
      {
        id: "win-tasks",
        title: "Ouvrir Tâches & Missions",
        subtitle: "Files d'attente et exécutions",
        category: "Windows",
        action: () => openWindow("tasks", "Tâches & Missions"),
      },
      {
        id: "win-trading",
        title: "Ouvrir Trading Lab",
        subtitle: "Stratégies algorithmiques et backtests",
        category: "Windows",
        action: () => openWindow("trading-lab", "Trading Lab & Stratégies"),
      },
      {
        id: "win-career",
        title: "Ouvrir Career & Education",
        subtitle: "Parcours et veille professionnelle",
        category: "Windows",
        action: () => openWindow("career-education", "Career & Education"),
      },
      {
        id: "win-osint",
        title: "Ouvrir OSINT Intelligence",
        subtitle: "Investigation et cartographie de données",
        category: "Windows",
        action: () => openWindow("osint", "OSINT Intelligence"),
      },
      {
        id: "win-agents",
        title: "Ouvrir Agents & Quotas",
        subtitle: "Gestion des agents autonomes et quotas",
        category: "Windows",
        action: () => openWindow("agents", "Agents & Quotas"),
      },
      {
        id: "win-connections",
        title: "Ouvrir Connexions CLIs",
        subtitle: "Statut des tunnels et sessions",
        category: "Windows",
        action: () => openWindow("connections", "Connexions CLIs"),
      },
      {
        id: "win-organizations",
        title: "Ouvrir Organizations (organisations)",
        subtitle: "Organisations, membres et rôles",
        category: "Windows",
        action: () => openWindow("organizations", "Organizations"),
      },
      {
        id: "win-mission-control",
        title: "Ouvrir Mission Control",
        subtitle: "Missions, planifications et état du moteur",
        category: "Windows",
        action: () => openWindow("mission-control", "Mission Control"),
      },
      {
        id: "win-observability",
        title: "Ouvrir Observability (observabilité)",
        subtitle: "Santé des services, erreurs récentes, recherche par correlationId",
        category: "Windows",
        action: () => openWindow("observability", "Observability"),
      },
      {
        id: "win-usage",
        title: "Ouvrir Usage & Quotas",
        subtitle: "Tokens observés, coûts estimés et fenêtres de quota",
        category: "Windows",
        action: () => openWindow("quota-forecast", "Usage & Quotas"),
      },
      {
        id: "win-mcp",
        title: "Ouvrir Serveurs MCP",
        subtitle: "Protocole Model Context",
        category: "Windows",
        action: () => openWindow("mcp", "Serveurs MCP"),
      },
      {
        id: "win-browser",
        title: "Ouvrir Navigateur Automatisé",
        subtitle: "Sessions de navigation pilotées",
        category: "Windows",
        action: () => openWindow("browser", "Navigateur Automatisé"),
      },
      {
        id: "win-visual",
        title: "Ouvrir Contrôle Visuel (Screenshots/VNC)",
        subtitle: "Supervision graphique en direct",
        category: "Windows",
        action: () => openWindow("visual-control", "Contrôle Visuel"),
      },
      {
        id: "win-workers",
        title: "Ouvrir Workers Locaux",
        subtitle: "Processus et machines distribuées",
        category: "Windows",
        action: () => openWindow("workers", "Workers Distribués"),
      },
      {
        id: "win-security",
        title: "Ouvrir Sécurité & Garde-fous",
        subtitle: "Audits et politiques d'accès",
        category: "Windows",
        action: () => openWindow("security", "Sécurité & Audit"),
      },
      {
        id: "win-logs",
        title: "Ouvrir Journaux Système",
        subtitle: "Logs structurés en temps réel",
        category: "Windows",
        action: () => openWindow("logs", "Journaux Système"),
      },
      {
        id: "win-marketplace",
        title: "Ouvrir Place de Marché",
        subtitle: "Extensions, outils et templates",
        category: "Windows",
        action: () => openWindow("marketplace", "Marketplace"),
      },
      {
        id: "win-notifications",
        title: "Ouvrir Notifications",
        subtitle: "Alertes et messages système",
        category: "Windows",
        action: () => openWindow("notifications", "Notifications"),
      },
      {
        id: "win-shortcuts",
        title: "Ouvrir Raccourcis Clavier (Keybindings)",
        subtitle: "Configuration des touches et raccourcis",
        category: "System",
        action: () => openWindow("shortcuts", "Raccourcis Clavier"),
      },
      {
        id: "win-preferences",
        title: "Ouvrir Préférences & Thèmes",
        subtitle: "Thèmes couleurs, mode sombre/clair, langue",
        category: "System",
        action: () => openWindow("preferences", "Préférences & Thèmes"),
      },
      {
        id: "win-settings",
        title: "Ouvrir Paramètres Globaux",
        subtitle: "Configuration générale et secrets",
        category: "System",
        action: () => openWindow("settings", "Paramètres"),
      },
    );

    // System Actions
    list.push(
      {
        id: "sys-fit-all",
        title: "Adapter la vue spatiale (Fit All)",
        subtitle: "Recentre la caméra sur toutes les fenêtres de l'espace",
        category: "System",
        shortcut: "Ctrl+0",
        action: () => fitAll(),
      },
      {
        id: "sys-reset-camera",
        title: "Réinitialiser la caméra (100% zoom)",
        subtitle: "Position d'origine 0,0",
        category: "System",
        shortcut: "Esc",
        action: () => resetCamera(),
      },
      {
        id: "sys-tile-grid",
        title: "Tiling : Grille automatique",
        subtitle: "Organise les fenêtres en grille Hyprland",
        category: "Layouts",
        action: () => tileWindows(activeSpace, "grid"),
      },
      {
        id: "sys-tile-split-h",
        title: "Tiling : Séparation horizontale",
        subtitle: "Colonnes côte à côte",
        category: "Layouts",
        action: () => tileWindows(activeSpace, "split-horizontal"),
      },
      {
        id: "sys-tile-split-v",
        title: "Tiling : Séparation verticale",
        subtitle: "Lignes empilées",
        category: "Layouts",
        action: () => tileWindows(activeSpace, "split-vertical"),
      },
      {
        id: "sys-default-reset",
        title: "Rétablir la disposition par défaut",
        subtitle: "Restaure toutes les fenêtres initiales de NEXUS",
        category: "System",
        action: () => resetToDefaultLayout(),
      },
    );

    return list;
  }, [
    activeSpace,
    setActiveSpace,
    openWindow,
    tileWindows,
    fitAll,
    resetCamera,
    resetToDefaultLayout,
  ]);

  return (
    <div className="spatial-os-root">
      {/* Top Status Bar (Omarchy Floating HUD) */}
      <header className="spatial-topbar">
        {/* Left: Logo & Space Switcher Pills */}
        <div className="spatial-topbar-left">
          <button
            type="button"
            className="spatial-logo"
            onClick={resetCamera}
            title="NEXUS Spatial OS — Réinitialiser caméra"
          >
            <NexusLogo size={20} style={{ marginRight: 6, flexShrink: 0 }} />
            <span>NEXUS SPATIAL OS</span>
          </button>

          {/* 5 Workspaces Pills */}
          <nav className="spatial-spaces-pills" aria-label="Espaces natifs">
            {(Object.keys(SPACE_CONFIGS) as NativeSpaceId[]).map((spaceId) => {
              const cfg = SPACE_CONFIGS[spaceId];
              const isActive = spaceId === activeSpace;
              return (
                <button
                  key={spaceId}
                  type="button"
                  className={`spatial-space-btn ${isActive ? "active" : ""}`}
                  onClick={() => setActiveSpace(spaceId)}
                  title={`${cfg.description} (${cfg.shortcut})`}
                >
                  <span className="spatial-space-key">{cfg.num}</span>
                  <span>{cfg.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Breadcrumb Trail */}
          <div className="spatial-breadcrumb">
            <span className="spatial-breadcrumb-sep">/</span>
            <span>{activeSpaceConfig.labelEn}</span>
            {focusedWin && (
              <>
                <span className="spatial-breadcrumb-sep">/</span>
                <span className="spatial-breadcrumb-active">{focusedWin.title}</span>
              </>
            )}
          </div>
        </div>

        {/* Center: Command Palette Trigger */}
        <div className="spatial-topbar-center">
          <button
            type="button"
            className="spatial-palette-trigger"
            onClick={() => setIsPaletteOpen(true)}
            title="Ouvrir la palette de commandes (Ctrl+K)"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>Rechercher commande, espace ou agent...</span>
            <span className="spatial-shortcut-badge">Ctrl+K</span>
          </button>
        </div>

        {/* Right: Camera Controls & Layout Mode */}
        <div className="spatial-topbar-right">
          {/* Camera Zoom & Navigation HUD */}
          <div className="spatial-camera-hud">
            <button
              type="button"
              className="spatial-hud-btn"
              title="Dézoomer"
              onClick={() =>
                setCamera((prev) => ({
                  ...prev,
                  zoom: Math.max(0.25, prev.zoom * 0.85),
                }))
              }
            >
              -
            </button>
            <span className="spatial-camera-zoom-val">{Math.round(camera.zoom * 100)}%</span>
            <button
              type="button"
              className="spatial-hud-btn"
              title="Zoomer"
              onClick={() =>
                setCamera((prev) => ({
                  ...prev,
                  zoom: Math.min(2.5, prev.zoom * 1.15),
                }))
              }
            >
              +
            </button>
            <button
              type="button"
              className="spatial-hud-btn"
              title="Ajuster la vue (Fit All)"
              onClick={fitAll}
            >
              ⛶
            </button>
            <button
              type="button"
              className="spatial-hud-btn"
              title="Réinitialiser la caméra"
              onClick={resetCamera}
            >
              ↺
            </button>
          </div>

          {/* Minimap Toggle */}
          <button
            type="button"
            className={`spatial-hud-btn ${showMinimap ? "active" : ""}`}
            style={{
              padding: "4px 8px",
              background: showMinimap ? "var(--sp-accent-dim)" : "transparent",
              color: showMinimap ? "var(--sp-accent)" : "var(--sp-text-muted)",
              border: "1px solid var(--sp-border-subtle)",
              borderRadius: "4px",
            }}
            onClick={() => setShowMinimap(!showMinimap)}
            title="Basculer la minicarte"
          >
            🗺
          </button>

          {/* Layout Mode Selector (Manual / Assist) */}
          <div className="spatial-mode-switcher">
            <button
              type="button"
              className={`spatial-mode-btn ${layoutMode === "manual" ? "active" : ""}`}
              onClick={() => setLayoutMode("manual")}
              title="Mode Manuel : contrôle total des fenêtres"
            >
              Manual
            </button>
            <button
              type="button"
              className={`spatial-mode-btn ${layoutMode === "assist" ? "active" : ""}`}
              onClick={() => setLayoutMode("assist")}
              title="Mode Assist : suggestions intelligentes d'agencement"
            >
              Assist
            </button>
          </div>

          {/* Switch to Classic Dashboard view if requested */}
          {onToggleClassicView && (
            <button
              type="button"
              className="spatial-hud-btn"
              style={{
                fontSize: "11px",
                border: "1px solid var(--sp-border-subtle)",
                borderRadius: "4px",
                padding: "3px 8px",
              }}
              onClick={onToggleClassicView}
              title="Basculer vers la vue classique Dashboard"
            >
              Vue Classique
            </button>
          )}
        </div>
      </header>

      {/* Assist Mode Recommendation Banner */}
      {layoutMode === "assist" && (
        <div className="spatial-assist-banner">
          <span>Mode Assist actif :</span>
          <input
            type="text"
            placeholder="Intention (ex: 'développer une fonctionnalité avec claude', 'superviser le dag')..."
            value={assistQuery}
            onChange={(e) => setAssistQuery(e.target.value)}
            style={{
              background: "rgba(0,0,0,0.5)",
              border: "1px solid var(--sp-border-subtle)",
              color: "var(--sp-text-main)",
              borderRadius: "4px",
              padding: "3px 8px",
              fontSize: "11px",
              width: "280px",
            }}
          />
          {assistRecommendation && (
            <>
              <span style={{ color: "var(--sp-accent)" }}>{assistRecommendation.title}</span>
              <button
                type="button"
                className="spatial-assist-btn"
                onClick={() => {
                  setActiveSpace(assistRecommendation.spaceId);
                  if (
                    assistRecommendation.presetId &&
                    PRESET_LAYOUTS[assistRecommendation.presetId]
                  ) {
                    tileWindows(assistRecommendation.spaceId, "grid");
                  }
                  setAssistQuery("");
                }}
              >
                {assistRecommendation.actionText}
              </button>
            </>
          )}
        </div>
      )}

      {/* Main Spatial Canvas Viewport */}
      <SpatialCanvas store={store} api={api} session={session} />

      {/* Bottom Status Bar (Keybindings & Status Hints) */}
      <footer className="spatial-bottombar">
        <div className="spatial-key-hints">
          <span className="spatial-key-hint">
            <span className="spatial-key-pill">Ctrl+K</span> Palette
          </span>
          <span className="spatial-key-hint">
            <span className="spatial-key-pill">Alt+1..5</span> Espaces
          </span>
          <span className="spatial-key-hint">
            <span className="spatial-key-pill">Alt+H/J/K/L</span> Focus Vim
          </span>
          <span className="spatial-key-hint">
            <span className="spatial-key-pill">Alt+Enter</span> Maximiser
          </span>
          <span className="spatial-key-hint">
            <span className="spatial-key-pill">Alt+F</span> Tiled/Float
          </span>
          <span className="spatial-key-hint">
            <span className="spatial-key-pill">Alt+Shift+S</span> Split
          </span>
          <span className="spatial-key-hint">
            <span className="spatial-key-pill">Esc</span> Reset Caméra
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span>
            {windows.length} panneau(x) · Espace {activeSpace.toUpperCase()}
          </span>
          <span
            style={{
              display: "inline-block",
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#10b981",
              boxShadow: "0 0 6px #10b981",
            }}
          />
        </div>
      </footer>

      {/* Command Palette Modal (Ctrl+K) */}
      <CommandPalette
        isOpen={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
        items={paletteItems}
      />
    </div>
  );
}
