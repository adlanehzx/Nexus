/**
 * NEXUS Signal & Spatial OS — Dynamic Accent Color Themes.
 *
 * Allows users to choose their accent palette (Matrix Green, Cyber Cyan,
 * Neon Violet, Solar Amber, Cyber Crimson, Electric Blue, Minimal Graphite).
 *
 * Stored in sessionStorage in compliance with test/exposure.test.ts.
 */

export type ColorThemeId =
  "emerald" | "cyan" | "violet" | "amber" | "crimson" | "blue" | "graphite";

export interface ColorThemeConfig {
  id: ColorThemeId;
  nameEn: string;
  nameFr: string;
  descriptionEn: string;
  descriptionFr: string;
  primary: string;
  signal: string;
  signalMuted: string;
  accentGlow: string;
  previewGradient: string;
}

export const COLOR_THEMES: Record<ColorThemeId, ColorThemeConfig> = {
  emerald: {
    id: "emerald",
    nameEn: "Matrix Green / Emerald",
    nameFr: "Vert Matrix / Émeraude",
    descriptionEn: "Classic cyberpunk hacker green with high-contrast matrix glow.",
    descriptionFr: "Vert hacker cyberpunk classique avec éclat matrix contrasté.",
    primary: "#10b981",
    signal: "#00ff9d",
    signalMuted: "rgba(0, 255, 157, 0.14)",
    accentGlow: "rgba(0, 255, 157, 0.28)",
    previewGradient: "linear-gradient(135deg, #059669 0%, #00ff9d 100%)",
  },
  cyan: {
    id: "cyan",
    nameEn: "Cyber Cyan / Signal",
    nameFr: "Cyan Futuriste / Signal",
    descriptionEn: "High-tech electric cyan and sci-fi holographic blue.",
    descriptionFr: "Cyan électrique high-tech et bleu holographique sci-fi.",
    primary: "#00f0ff",
    signal: "#00f0ff",
    signalMuted: "rgba(0, 240, 255, 0.14)",
    accentGlow: "rgba(0, 240, 255, 0.28)",
    previewGradient: "linear-gradient(135deg, #0284c7 0%, #00f0ff 100%)",
  },
  violet: {
    id: "violet",
    nameEn: "Neon Violet / Amethyst",
    nameFr: "Violet Néon / Améthyste",
    descriptionEn: "Deep synthwave purple with neon ultraviolet highlights.",
    descriptionFr: "Pourpre synthwave profond avec reflets ultraviolets néon.",
    primary: "#a855f7",
    signal: "#b300ff",
    signalMuted: "rgba(179, 0, 255, 0.14)",
    accentGlow: "rgba(179, 0, 255, 0.28)",
    previewGradient: "linear-gradient(135deg, #7c3aed 0%, #d946ef 100%)",
  },
  amber: {
    id: "amber",
    nameEn: "Solar Amber / Gold",
    nameFr: "Ambre Solaire / Orange",
    descriptionEn: "Industrial warm amber inspired by vintage CRT monitors and warning signals.",
    descriptionFr: "Ambre industriel chaleureux inspiré des écrans CRT et signaux d'alerte.",
    primary: "#f59e0b",
    signal: "#ff9900",
    signalMuted: "rgba(255, 153, 0, 0.14)",
    accentGlow: "rgba(255, 153, 0, 0.28)",
    previewGradient: "linear-gradient(135deg, #d97706 0%, #fbbf24 100%)",
  },
  crimson: {
    id: "crimson",
    nameEn: "Cyber Crimson / Rose",
    nameFr: "Rose Cyberpunk / Rouge",
    descriptionEn: "Aggressive neon rose and high-voltage crimson alert hue.",
    descriptionFr: "Rose néon vif et teinte rouge crimson haute tension.",
    primary: "#ff0055",
    signal: "#ff2a6d",
    signalMuted: "rgba(255, 42, 109, 0.14)",
    accentGlow: "rgba(255, 42, 109, 0.28)",
    previewGradient: "linear-gradient(135deg, #e11d48 0%, #ff2a6d 100%)",
  },
  blue: {
    id: "blue",
    nameEn: "Electric Blue / Sapphire",
    nameFr: "Bleu Électrique / Sapphire",
    descriptionEn: "Professional royal blue with clean crisp contrast.",
    descriptionFr: "Bleu roi professionnel au contraste net et précis.",
    primary: "#3b82f6",
    signal: "#00b4d8",
    signalMuted: "rgba(59, 130, 246, 0.14)",
    accentGlow: "rgba(59, 130, 246, 0.28)",
    previewGradient: "linear-gradient(135deg, #1d4ed8 0%, #38bdf8 100%)",
  },
  graphite: {
    id: "graphite",
    nameEn: "Minimal Graphite / Titanium",
    nameFr: "Graphite Minimaliste / Titane",
    descriptionEn: "Understated stealth monochrome with titanium silver lines.",
    descriptionFr: "Monochrome sobre et furtif avec lignes argentées titane.",
    primary: "#94a3b8",
    signal: "#e2e8f0",
    signalMuted: "rgba(226, 232, 240, 0.14)",
    accentGlow: "rgba(226, 232, 240, 0.24)",
    previewGradient: "linear-gradient(135deg, #334155 0%, #cbd5e1 100%)",
  },
};

const STORAGE_KEY = "nexus.colorTheme";

export function readColorTheme(): ColorThemeId {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored && stored in COLOR_THEMES) {
      return stored as ColorThemeId;
    }
  } catch {
    // SessionStorage inaccessible
  }
  return "cyan";
}

export function applyColorTheme(themeId: ColorThemeId): void {
  const theme = COLOR_THEMES[themeId] ?? COLOR_THEMES.cyan;
  const root = document.documentElement;

  root.setAttribute("data-color-theme", theme.id);

  // Apply to standard NEXUS variables
  root.style.setProperty("--nx-signal", theme.signal);
  root.style.setProperty("--nx-signal-muted", theme.signalMuted);
  root.style.setProperty("--nx-accent", theme.primary);
  root.style.setProperty("--nx-accent-hover", theme.signal);

  // Apply to Omarchy Spatial OS variables
  root.style.setProperty("--sp-accent", theme.signal);
  root.style.setProperty("--sp-accent-glow", theme.accentGlow);
  root.style.setProperty("--sp-border-active", theme.signal);

  try {
    window.sessionStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // SessionStorage inaccessible
  }

  // Dispatch event so live listeners can update state
  window.dispatchEvent(new CustomEvent("nexus-color-theme-change", { detail: theme.id }));
}

export function initColorTheme(): ColorThemeId {
  const theme = readColorTheme();
  applyColorTheme(theme);
  return theme;
}
