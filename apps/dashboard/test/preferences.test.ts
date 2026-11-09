import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLOR_THEMES,
  applyColorTheme,
  initColorTheme,
  readColorTheme,
  type ColorThemeId,
} from "../src/lib/color-theme.js";

describe("NEXUS Preferences & Color Themes", () => {
  const storage = new Map<string, string>();
  const attributes = new Map<string, string>();
  const styleProperties = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    attributes.clear();
    styleProperties.clear();

    const mockDocumentElement = {
      setAttribute: (k: string, v: string) => attributes.set(k, v),
      getAttribute: (k: string) => attributes.get(k) ?? null,
      removeAttribute: (k: string) => attributes.delete(k),
      style: {
        setProperty: (k: string, v: string) => styleProperties.set(k, v),
        getPropertyValue: (k: string) => styleProperties.get(k) ?? "",
      },
    };

    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      },
      dispatchEvent: vi.fn(),
    });

    vi.stubGlobal("document", {
      documentElement: mockDocumentElement,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provides 7 curated themes with bilingual labels and distinct signals", () => {
    const themeIds: ColorThemeId[] = [
      "emerald",
      "cyan",
      "violet",
      "amber",
      "crimson",
      "blue",
      "graphite",
    ];

    expect(Object.keys(COLOR_THEMES).sort()).toEqual(themeIds.sort());

    for (const id of themeIds) {
      const config = COLOR_THEMES[id];
      expect(config.id).toBe(id);
      expect(config.nameFr).toBeTruthy();
      expect(config.nameEn).toBeTruthy();
      expect(config.signal).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(config.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("defaults to cyan when storage is empty", () => {
    expect(readColorTheme()).toBe("cyan");
  });

  it("persists theme choice to sessionStorage without using localStorage", () => {
    applyColorTheme("emerald");
    expect(storage.get("nexus.colorTheme")).toBe("emerald");
    expect(readColorTheme()).toBe("emerald");

    applyColorTheme("violet");
    expect(storage.get("nexus.colorTheme")).toBe("violet");
    expect(readColorTheme()).toBe("violet");
  });

  it("applies CSS custom properties and attributes to documentElement", () => {
    applyColorTheme("emerald");

    expect(attributes.get("data-color-theme")).toBe("emerald");
    // Per-mode palettes: color-themes.css maps them onto --nx-accent / --nx-signal.
    expect(styleProperties.get("--nx-theme-signal-dark")).toBe(COLOR_THEMES.emerald.dark.signal);
    expect(styleProperties.get("--nx-theme-signal-light")).toBe(COLOR_THEMES.emerald.light.signal);
    expect(styleProperties.get("--nx-theme-accent-dark")).toBe(COLOR_THEMES.emerald.dark.accent);
    expect(styleProperties.get("--nx-theme-accent-light")).toBe(COLOR_THEMES.emerald.light.accent);
    // The Spatial OS variables keep the brand signal.
    expect(styleProperties.get("--sp-accent")).toBe(COLOR_THEMES.emerald.signal);
    expect(styleProperties.get("--sp-border-active")).toBe(COLOR_THEMES.emerald.signal);
  });

  it("initializes theme before paint", () => {
    storage.set("nexus.colorTheme", "amber");
    const active = initColorTheme();
    expect(active).toBe("amber");
    expect(attributes.get("data-color-theme")).toBe("amber");
  });
  it("keeps every theme palette at WCAG AA (4.5:1) on its mode's surface ramp", () => {
    const luminance = (hex: string): number => {
      const channel = (offset: number): number => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    // Surfaces from @nexus/design tokens: canvas, surface, raised, active.
    const surfaces = {
      light: ["#f4f7fb", "#ffffff", "#e9eff7", "#e3ebf6"],
      dark: ["#080b11", "#0e131c", "#141b26", "#212b3b"],
    } as const;
    const onAccent = { light: "#ffffff", dark: "#04070e" } as const;

    for (const config of Object.values(COLOR_THEMES)) {
      for (const mode of ["light", "dark"] as const) {
        const palette = config[mode];
        for (const surface of surfaces[mode]) {
          for (const [name, color] of [
            ["accent", palette.accent],
            ["accentHover", palette.accentHover],
            ["signal", palette.signal],
          ] as const) {
            expect(
              contrast(color, surface),
              `${config.id}/${mode} ${name} ${color} on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
        expect(
          contrast(onAccent[mode], palette.accent),
          `${config.id}/${mode} text on accent fill`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
