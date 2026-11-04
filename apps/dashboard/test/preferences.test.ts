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
    expect(styleProperties.get("--nx-signal")).toBe(COLOR_THEMES.emerald.signal);
    expect(styleProperties.get("--sp-accent")).toBe(COLOR_THEMES.emerald.signal);
    expect(styleProperties.get("--sp-border-active")).toBe(COLOR_THEMES.emerald.signal);
  });

  it("initializes theme before paint", () => {
    storage.set("nexus.colorTheme", "amber");
    const active = initColorTheme();
    expect(active).toBe("amber");
    expect(attributes.get("data-color-theme")).toBe("amber");
  });
});
