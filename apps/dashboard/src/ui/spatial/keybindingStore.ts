/**
 * NEXUS Spatial OS — Keybinding Store & Configuration Registry
 * Allows full customization and persistence of keyboard shortcuts.
 */

import { getDigitFromEvent } from "./keyboardUtils.js";

export interface KeybindingDef {
  id: string;
  label: string;
  labelEn: string;
  category: "spaces" | "windows" | "navigation" | "system";
  defaultKeys: string;
  description: string;
}

export const DEFAULT_KEYBINDINGS: KeybindingDef[] = [
  // Spaces
  {
    id: "space-1",
    label: "Espace Command",
    labelEn: "Command Space",
    category: "spaces",
    defaultKeys: "Ctrl+1",
    description: "Assistant conversationnel, missions et santé système",
  },
  {
    id: "space-2",
    label: "Espace Mission",
    labelEn: "Mission Space",
    category: "spaces",
    defaultKeys: "Ctrl+2",
    description: "Orchestration interactive et graphes DAG",
  },
  {
    id: "space-3",
    label: "Espace Code",
    labelEn: "Code Space",
    category: "spaces",
    defaultKeys: "Ctrl+3",
    description: "Développement T3 Code, agents jumeaux et VCS",
  },
  {
    id: "space-4",
    label: "Espace Device",
    labelEn: "Device Space",
    category: "spaces",
    defaultKeys: "Ctrl+4",
    description: "Topologie des machines, workers et visual control",
  },
  {
    id: "space-5",
    label: "Espace Memory",
    labelEn: "Memory Space",
    category: "spaces",
    defaultKeys: "Ctrl+5",
    description: "Mémoire sémantique, connaissances et gouvernance",
  },

  // System & Camera
  {
    id: "fit-all",
    label: "Adapter la vue spatiale (Fit All)",
    labelEn: "Fit All Windows in View",
    category: "system",
    defaultKeys: "Ctrl+0",
    description: "Recentre la caméra sur toutes les fenêtres de l'espace",
  },
  {
    id: "reset-camera",
    label: "Réinitialiser la caméra (100%)",
    labelEn: "Reset Camera to 100%",
    category: "system",
    defaultKeys: "Escape",
    description: "Position d'origine 0,0 et zoom 100%",
  },
  {
    id: "zoom-in",
    label: "Zoom avant (+20%)",
    labelEn: "Zoom In (+20%)",
    category: "system",
    defaultKeys: "Ctrl+=",
    description: "Agrandit le plan spatial",
  },
  {
    id: "zoom-out",
    label: "Zoom arrière (-20%)",
    labelEn: "Zoom Out (-20%)",
    category: "system",
    defaultKeys: "Ctrl+-",
    description: "Dézoome pour vue panoramique",
  },
  {
    id: "command-palette",
    label: "Palette de commandes globale",
    labelEn: "Global Command Palette",
    category: "system",
    defaultKeys: "Ctrl+K",
    description: "Recherche instantanée d'espaces, modules et actions",
  },
  {
    id: "toggle-os",
    label: "Basculer Spatial / Classique",
    labelEn: "Toggle Spatial / Classic View",
    category: "system",
    defaultKeys: "Ctrl+Shift+O",
    description: "Alterne entre le Spatial OS et le Dashboard classique",
  },
  {
    id: "open-settings",
    label: "Ouvrir les Paramètres",
    labelEn: "Open Settings",
    category: "system",
    defaultKeys: "Ctrl+,",
    description: "Accès direct au panneau de configuration",
  },

  // Windows & Tiling
  {
    id: "toggle-maximize",
    label: "Agrandir / Plein écran fenêtre",
    labelEn: "Maximize Focused Window",
    category: "windows",
    defaultKeys: "Ctrl+Enter",
    description: "Maximise la fenêtre active sur l'espace",
  },
  {
    id: "close-window",
    label: "Fermer la fenêtre active",
    labelEn: "Close Active Window",
    category: "windows",
    defaultKeys: "Ctrl+W",
    description: "Ferme la fenêtre ciblée",
  },
  {
    id: "toggle-floating",
    label: "Basculer Flottant / Tuilé",
    labelEn: "Toggle Floating / Tiled Window",
    category: "windows",
    defaultKeys: "Ctrl+F",
    description: "Change le mode de positionnement de la fenêtre",
  },
  {
    id: "cycle-tiling",
    label: "Changer le mode de tuilage",
    labelEn: "Cycle Tiling Layout",
    category: "windows",
    defaultKeys: "Ctrl+Shift+S",
    description: "Grille, Split horizontal, Split vertical ou Cascade",
  },
  {
    id: "toggle-minimap",
    label: "Afficher / Masquer la Minimap",
    labelEn: "Toggle Radar Minimap",
    category: "navigation",
    defaultKeys: "Ctrl+M",
    description: "Bascule la visibilité de la carte radar en bas à droite",
  },
  {
    id: "cycle-window",
    label: "Fenêtre suivante",
    labelEn: "Focus Next Window",
    category: "navigation",
    defaultKeys: "Ctrl+Tab",
    description: "Passe à la fenêtre suivante de l'espace actif",
  },
];

const STORAGE_KEY = "nexus.keybindings.custom";

export function loadUserKeybindings(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveUserKeybinding(id: string, keys: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = loadUserKeybindings();
    current[id] = keys.trim();
    window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
    window.dispatchEvent?.(new CustomEvent("nexus:keybindings-updated"));
  } catch {
    // Storage unavailable
  }
}

export function resetAllKeybindings(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.removeItem(STORAGE_KEY);
    window.dispatchEvent?.(new CustomEvent("nexus:keybindings-updated"));
  } catch {
    // Storage unavailable
  }
}

export function getKeybinding(id: string): string {
  const custom = loadUserKeybindings();
  if (custom[id]) return custom[id];
  const def = DEFAULT_KEYBINDINGS.find((k) => k.id === id);
  return def?.defaultKeys ?? "";
}

/**
 * Checks if a KeyboardEvent matches a normalized shortcut string (e.g. "Ctrl+Shift+O" or "Ctrl+1").
 */
export function eventMatchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+").map((p) => p.trim().toLowerCase());

  const needCtrl = parts.includes("ctrl");
  const needAlt = parts.includes("alt");
  const needShift = parts.includes("shift");

  const hasCtrl = e.ctrlKey || e.metaKey;
  const hasAlt = e.altKey;
  const hasShift = e.shiftKey;

  if (needCtrl !== hasCtrl) return false;
  if (needAlt !== hasAlt) return false;

  const keyPart = parts.find((p) => !["ctrl", "alt", "shift", "meta", "cmd", "super"].includes(p));
  if (!keyPart) return false;

  // For digits, AZERTY or Caps-Lock may have shiftKey active, so only enforce needShift if not a digit
  const isDigitKey = /^[0-9]$/.test(keyPart);
  if (!isDigitKey && needShift !== hasShift) return false;

  // Single digit check (handles AZERTY, QWERTY, Numpad)
  if (/^[0-9]$/.test(keyPart)) {
    const d = getDigitFromEvent(e);
    return d !== null && d === parseInt(keyPart, 10);
  }

  // Special named keys
  if (keyPart === "enter") return e.key === "Enter";
  if (keyPart === "escape" || keyPart === "esc") return e.key === "Escape";
  if (keyPart === "tab") return e.key === "Tab";
  if (keyPart === "backspace") return e.key === "Backspace";
  if (keyPart === ",") return e.key === ",";
  if (keyPart === "=" || keyPart === "+")
    return e.key === "=" || e.key === "+" || e.code === "Equal";
  if (keyPart === "-") return e.key === "-" || e.code === "Minus";

  // Alpha key check
  return e.key.toLowerCase() === keyPart.toLowerCase();
}
