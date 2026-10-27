import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { paletteVariables, renderTokensCss } from "../src/css.js";
import {
  RISK_LEVELS,
  palettes,
  riskColor,
  statusColor,
  statusLabel,
  toLegacyColor,
} from "../src/tokens.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const part = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("tokens.css", () => {
  it("matches the committed stylesheet", () => {
    const committed = readFileSync(join(packageRoot, "tokens.css"), "utf8");
    expect(committed).toBe(renderTokensCss());
  });

  it("declares every palette value in both themes", () => {
    const light = Object.keys(paletteVariables(palettes.light));
    const dark = Object.keys(paletteVariables(palettes.dark));
    expect(dark).toStrictEqual(light);
  });

  it("resolves an explicit theme over the media query", () => {
    const css = renderTokensCss();
    const media = css.indexOf("@media (prefers-color-scheme: dark)");
    const explicit = css.indexOf(':root[data-theme="dark"]');
    expect(media).toBeGreaterThan(0);
    expect(explicit).toBeGreaterThan(media);
    expect(css).toContain(':root:not([data-theme="light"])');
  });
});

describe("contrast", () => {
  const cases = [
    ["dark", palettes.dark],
    ["light", palettes.light],
  ] as const;

  it.each(cases)("%s body text is AA on canvas and surface", (_name, palette) => {
    expect(contrast(palette.text, palette.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)("%s secondary text stays readable", (_name, palette) => {
    expect(contrast(palette.textMuted, palette.surface)).toBeGreaterThanOrEqual(4.5);
    // Tertiary text carries timestamps and placeholders: large-text AA is the floor.
    expect(contrast(palette.textFaint, palette.surface)).toBeGreaterThanOrEqual(3);
  });

  it.each(cases)("%s accent is usable as text and as a fill", (_name, palette) => {
    expect(contrast(palette.accent, palette.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(palette.textOnAccent, palette.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)("%s status foregrounds are AA on surface", (_name, palette) => {
    for (const tone of [palette.ok, palette.warn, palette.danger, palette.info, palette.neutral]) {
      expect(contrast(tone.fg, palette.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(cases)("%s risk hues stay distinguishable from the surface", (_name, palette) => {
    for (const level of RISK_LEVELS) {
      expect(contrast(palette.risk[level], palette.surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("status helpers", () => {
  it("marks in-flight work with the liveness colour, not a status hue", () => {
    expect(statusColor("running", palettes.dark)).toBe(palettes.dark.signal);
    expect(statusColor("pending", palettes.dark)).toBe(palettes.dark.signal);
  });

  it("maps terminal states to their tone", () => {
    expect(statusColor("succeeded", palettes.light)).toBe(palettes.light.ok.fg);
    expect(statusColor("failed", palettes.light)).toBe(palettes.light.danger.fg);
    expect(statusColor("cancelled", palettes.light)).toBe(palettes.light.neutral.fg);
  });

  it("falls back to neutral for an unknown risk level", () => {
    expect(riskColor("NOT_A_LEVEL", palettes.dark)).toBe(palettes.dark.neutral.fg);
    expect(riskColor("CRITICAL", palettes.light)).toBe(palettes.light.risk.CRITICAL);
  });

  it("keeps the existing status vocabulary", () => {
    expect(statusLabel("waiting_for_confirmation")).toBe("awaiting confirmation");
    expect(statusLabel("unheard-of")).toBe("unheard-of");
  });
});

describe("toLegacyColor", () => {
  it("rewrites CSS Color 4 syntax that React Native cannot parse", () => {
    expect(toLegacyColor("rgb(78 211 154 / 13%)")).toBe("rgba(78, 211, 154, 0.13)");
    expect(toLegacyColor("rgb(3 6 11 / 68%)")).toBe("rgba(3, 6, 11, 0.68)");
  });

  it("leaves hex and legacy forms alone", () => {
    expect(toLegacyColor("#5b9dff")).toBe("#5b9dff");
    expect(toLegacyColor("rgba(1, 2, 3, 0.5)")).toBe("rgba(1, 2, 3, 0.5)");
  });

  it("converts every palette value to something React Native accepts", () => {
    const parsable = /^(#[0-9a-f]{3,8}|rgba\(\d+, \d+, \d+, [\d.]+\))$/i;
    for (const palette of [palettes.dark, palettes.light]) {
      const colours = [
        palette.canvas,
        palette.canvasSunken,
        palette.surface,
        palette.surfaceRaised,
        palette.surfaceHover,
        palette.surfaceActive,
        palette.line,
        palette.lineStrong,
        palette.accentMuted,
        palette.accentLine,
        palette.signalMuted,
        palette.scrim,
        ...[palette.ok, palette.warn, palette.danger, palette.info, palette.neutral].flatMap(
          (tone) => [tone.fg, tone.bg, tone.line],
        ),
      ];
      for (const colour of colours) {
        expect(toLegacyColor(colour), colour).toMatch(parsable);
      }
    }
  });
});
