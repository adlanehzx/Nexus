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

/**
 * Accent values for one display mode.
 *
 * A single neon value cannot serve both modes: the saturated colour that reads
 * well on a near-black canvas fails WCAG AA as text on a white card, and the
 * deep colour that reads on white disappears on the dark canvas. Each theme
 * therefore carries one palette per mode; every value is at least 4.5:1 against
 * the NEXUS surface ramp of its mode.
 */
export interface ColorThemeModePalette {
  /** Interactive accent: links, focus rings, filled buttons. */
  accent: string;
  accentHover: string;
  /** Live / selected "signal": eyebrows, the rail, active tabs. */
  signal: string;
}

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
  light: ColorThemeModePalette;
  dark: ColorThemeModePalette;
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
    light: { accent: "#047857", accentHover: "#065f46", signal: "#03725a" },
    dark: { accent: "#34d399", accentHover: "#6ee7b7", signal: "#2dffa8" },
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
    light: { accent: "#0c6a85", accentHover: "#0a566d", signal: "#0b7285" },
    dark: { accent: "#22d3ee", accentHover: "#67e8f9", signal: "#2ee6ff" },
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
    light: { accent: "#7e22ce", accentHover: "#6b21a8", signal: "#7a1fd1" },
    dark: { accent: "#c084fc", accentHover: "#d8b4fe", signal: "#cf8bff" },
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
    light: { accent: "#9a4608", accentHover: "#7c3a05", signal: "#8f5200" },
    dark: { accent: "#fbbf24", accentHover: "#fcd34d", signal: "#ffb020" },
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
    light: { accent: "#be123c", accentHover: "#9f1239", signal: "#c4124a" },
    dark: { accent: "#fb7185", accentHover: "#fda4af", signal: "#ff5c8a" },
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
    light: { accent: "#1d4ed8", accentHover: "#1e40af", signal: "#0369a1" },
    dark: { accent: "#60a5fa", accentHover: "#93c5fd", signal: "#38bdf8" },
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
    light: { accent: "#475569", accentHover: "#334155", signal: "#3b4658" },
    dark: { accent: "#cbd5e1", accentHover: "#e2e8f0", signal: "#e2e8f0" },
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

  // Per-mode palettes. `color-themes.css` maps these onto --nx-accent / --nx-signal
  // according to the active light/dark mode, so a theme switch needs no JS when the
  // user flips the colour scheme.
  for (const mode of ["light", "dark"] as const) {
    const palette = theme[mode];
    root.style.setProperty(`--nx-theme-accent-${mode}`, palette.accent);
    root.style.setProperty(`--nx-theme-accent-hover-${mode}`, palette.accentHover);
    root.style.setProperty(`--nx-theme-signal-${mode}`, palette.signal);
  }

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
