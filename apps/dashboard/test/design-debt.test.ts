import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Design-debt ratchet.
 *
 * The dashboard is being migrated to the Cadran design system
 * (docs/design/03-design-system.md §10). Until that is finished, the old debt is
 * still here — but it may only go down. Each number below is the count measured
 * when it was last lowered; the test fails if the code exceeds it.
 *
 * When a change removes debt, lower the matching number in the same change.
 * Never raise one: write the component with tokens and a stylesheet instead.
 *
 * One inline style stays legal and is not counted: handing a dynamic value to a
 * stylesheet through a custom property, `style={{ "--nx-value": percent }}`.
 */
const BASELINE = {
  /** `style={{ … }}` objects in components. */
  inlineStyles: 1302,
  /** Hex colour literals in components. */
  hexInComponents: 246,
  /** `rgb()` / `rgba()` literals in components. */
  rgbInComponents: 28,
  /** `window.confirm`, `window.prompt`, `window.alert` and their `globalThis` forms. */
  nativeDialogs: 16,
  /** Hex colour literals in stylesheets. */
  hexInStylesheets: 180,
  /** `rgb()` / `rgba()` literals in stylesheets. */
  rgbInStylesheets: 250,
  /** Blurred shadows, text shadows, backdrop filters, gradients and keyframes in the main stylesheet. */
  effectsInThemeCss: 5,
} as const;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Source text without block or line comments, so prose about colours is not counted. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

const files = walk(src);
const components = files.filter((file) => file.endsWith(".tsx")).map(code);
const stylesheets = files.filter((file) => file.endsWith(".css"));

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const RGB = /rgba?\(\s*\d/g;

function sum(texts: readonly string[], pattern: RegExp): number {
  return texts.reduce((total, text) => total + count(text, pattern), 0);
}

function measure(): Record<keyof typeof BASELINE, number> {
  const css = stylesheets.map(code);
  const theme = code(join(src, "ui", "theme.css"));
  return {
    // Every inline style object except the custom-property hand-off.
    inlineStyles: sum(components, /style=\{\{(?!\s*["']--nx-)/g),
    hexInComponents: sum(components, HEX),
    rgbInComponents: sum(components, RGB),
    nativeDialogs: sum(components, /\b(?:window|globalThis)\.(?:confirm|prompt|alert)\(/g),
    hexInStylesheets: sum(css, HEX),
    rgbInStylesheets: sum(css, RGB),
    effectsInThemeCss:
      count(theme, /text-shadow\s*:/g) +
      count(theme, /backdrop-filter\s*:/g) +
      count(theme, /(?:linear|radial|conic)-gradient\(/g) +
      count(theme, /@keyframes\s/g),
  };
}

describe("design debt only goes down", () => {
  const measured = measure();

  it.each(Object.keys(BASELINE) as (keyof typeof BASELINE)[])("%s", (key) => {
    expect(
      measured[key],
      `${key} rose to ${String(measured[key])} (limit ${String(BASELINE[key])}). ` +
        "Use design tokens and a stylesheet; see docs/design/03-design-system.md §10.2.",
    ).toBeLessThanOrEqual(BASELINE[key]);
  });

  it("is lowered when debt is removed", () => {
    // A limit left far above the real count stops protecting anything.
    for (const key of Object.keys(BASELINE) as (keyof typeof BASELINE)[]) {
      expect(
        BASELINE[key] - measured[key],
        `${key} is now ${String(measured[key])}: lower its limit from ${String(BASELINE[key])}.`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it("keeps the main stylesheet free of blurred shadows", () => {
    const theme = code(join(src, "ui", "theme.css"));
    const blurred = [...theme.matchAll(/box-shadow\s*:([^;]*);/g)]
      .flatMap((match) => (match[1] ?? "").split(/,(?![^(]*\))/))
      .map((layer) => layer.trim().replace(/^inset\s+/, ""))
      .filter((layer) =>
        /^-?[\d.]+\w*\s+-?[\d.]+\w*\s+(?!0(?:px)?(?:\s|$))-?[\d.]+\w*/.test(layer),
      );
    expect(blurred, relative(root, join(src, "ui", "theme.css"))).toStrictEqual([]);
  });
});
