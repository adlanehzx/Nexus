import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cadranScaleVariables, renderCadranCss } from "../src/cadran-css.js";
import { SURFACES, fontSizes, mix, palettes, radii } from "../src/cadran.js";
import { paletteVariables, scaleVariables } from "../src/css.js";
import { RISK_LEVELS, palettes as signal } from "../src/tokens.js";

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

const themes = [
  ["dark", palettes.dark],
  ["light", palettes.light],
] as const;

const STATUSES = ["ok", "warn", "danger", "info", "neutral"] as const;

describe("cadran.css", () => {
  it("matches the committed stylesheet", () => {
    const committed = readFileSync(join(packageRoot, "cadran.css"), "utf8");
    expect(committed).toBe(renderCadranCss());
  });

  it("declares every palette value in both themes", () => {
    const light = Object.keys(paletteVariables(palettes.light));
    const dark = Object.keys(paletteVariables(palettes.dark));
    expect(dark).toStrictEqual(light);
  });

  it("resolves an explicit theme over the media query", () => {
    const css = renderCadranCss();
    const media = css.indexOf("@media (prefers-color-scheme: dark)");
    const explicit = css.indexOf(':root[data-theme="dark"]');
    expect(media).toBeGreaterThan(0);
    expect(explicit).toBeGreaterThan(media);
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it("defines every name the Signal stylesheet defines, so the import is the whole switch", () => {
    const css = renderCadranCss();
    const names = [
      ...Object.keys(scaleVariables()),
      ...Object.keys(paletteVariables(signal.dark)),
    ].filter((name) => name.startsWith("--nx-"));
    for (const name of names) expect(css, name).toContain(`${name}:`);
  });

  it("adds the two tokens Signal lacks", () => {
    const vars = paletteVariables(palettes.dark);
    expect(vars["--nx-line-control"]).toBe(palettes.dark.lineControl);
    expect(vars["--nx-focus"]).toBe(palettes.dark.focus);
    expect(paletteVariables(signal.dark)["--nx-line-control"]).toBeUndefined();
  });

  it("writes no raw colour outside the palette", () => {
    const scales = Object.values(cadranScaleVariables()).join(" ");
    expect(scales).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("cadran scales", () => {
  it("keeps the type scale to seven sizes, none under 11px", () => {
    const sizes = Object.values(fontSizes);
    expect(sizes).toHaveLength(7);
    expect(Math.min(...sizes)).toBe(11);
  });

  it("has no radius above 4px", () => {
    expect(Math.max(...Object.values(radii))).toBe(4);
  });

  it("shares the risk hues with Signal instead of copying them", () => {
    expect(palettes.dark.risk).toBe(signal.dark.risk);
    expect(palettes.light.risk).toBe(signal.light.risk);
  });
});

/**
 * The contrast matrix of docs/design/03-design-system.md §2.3.
 *
 * Every pair is measured against all seven surfaces of its theme, not the one
 * it usually sits on: a badge lands on a hovered row, faint text on a selected
 * one. A value change that breaks any pair fails here.
 */
describe("cadran contrast", () => {
  it.each(themes)("%s text passes on every surface", (_name, palette) => {
    for (const surface of SURFACES) {
      expect(contrast(palette.text, palette[surface]), surface).toBeGreaterThanOrEqual(7);
      expect(contrast(palette.textMuted, palette[surface]), surface).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.textFaint, palette[surface]), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)("%s accent is text-grade on every surface", (_name, palette) => {
    for (const surface of SURFACES) {
      expect(contrast(palette.accent, palette[surface]), surface).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.accentHover, palette[surface]), surface).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(palette.textOnAccent, palette.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.textOnAccent, palette.accentHover)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)("%s lamp, focus ring and control boundary reach 3:1", (_name, palette) => {
    for (const surface of SURFACES) {
      expect(contrast(palette.signal, palette[surface]), surface).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.focus, palette[surface]), surface).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.lineControl, palette[surface]), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(themes)(
    "%s status colours pass on every surface and on their own fill",
    (_n, palette) => {
      for (const status of STATUSES) {
        const tone = palette[status];
        for (const surface of SURFACES) {
          expect(
            contrast(tone.fg, palette[surface]),
            `${status}/${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(tone.fg, tone.bg), `${status} on its fill`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.text, tone.bg), `text on ${status} fill`).toBeGreaterThanOrEqual(7);
      }
    },
  );

  it.each(themes)("%s selected-row tint keeps text readable", (_name, palette) => {
    for (const base of [palette.surface, palette.canvas, palette.surfaceRaised]) {
      const tint = mix(palette.accent, base, 0.14);
      expect(contrast(palette.text, tint)).toBeGreaterThanOrEqual(7);
      expect(contrast(palette.textMuted, tint)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.accent, tint)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)("%s inverted primary button is readable, hover included", (_name, palette) => {
    expect(contrast(palette.canvas, palette.text)).toBeGreaterThanOrEqual(7);
    expect(contrast(palette.canvas, palette.textMuted)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)("%s risk hues are AA where they are shown", (_name, palette) => {
    for (const level of RISK_LEVELS) {
      for (const surface of ["canvas", "surface", "surfaceRaised", "surfaceHover"] as const) {
        expect(contrast(palette.risk[level], palette[surface]), level).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the light lamp brighter than the light accent, and off text duty", () => {
    expect(luminance(palettes.light.signal)).toBeGreaterThan(luminance(palettes.light.accent));
    // Documented limit: below text contrast on at least one surface, hence graphic only.
    const worst = Math.min(
      ...SURFACES.map((s) => contrast(palettes.light.signal, palettes.light[s])),
    );
    expect(worst).toBeLessThan(4.5);
  });
});
