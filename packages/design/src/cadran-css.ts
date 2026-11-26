/**
 * CSS projection of the Cadran identity.
 *
 * Emits the same `--nx-*` names as `renderTokensCss`, so a web app moves from
 * Signal to Cadran by importing `cadran.css` in place of `tokens.css`. The
 * committed file is checked against this generator by `test/cadran.test.ts`.
 */

import {
  components,
  deprecated,
  font,
  fontSizes,
  layout,
  motion,
  palettes,
  radii,
  typeRoles,
} from "./cadran.js";
import { paletteVariables } from "./css.js";
import { spacing, zIndex } from "./tokens.js";

const PREFIX = "--nx";

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function px(value: number): string {
  return `${String(value)}px`;
}

/** Theme-independent custom properties: scales, type, motion, layout, components. */
export function cadranScaleVariables(): Record<string, string> {
  const vars: Record<string, string> = {
    [`${PREFIX}-font-sans`]: font.sans,
    [`${PREFIX}-font-mono`]: font.mono,
    [`${PREFIX}-font-display`]: font.display,
  };

  for (const [key, value] of Object.entries(spacing)) vars[`${PREFIX}-space-${key}`] = px(value);
  for (const [key, value] of Object.entries(radii)) vars[`${PREFIX}-radius-${key}`] = px(value);
  for (const [key, value] of Object.entries(fontSizes)) vars[`${PREFIX}-size-${key}`] = px(value);
  for (const [key, value] of Object.entries(font.weight)) vars[`${PREFIX}-weight-${key}`] = value;
  for (const [key, value] of Object.entries(font.leading)) vars[`${PREFIX}-leading-${key}`] = value;
  for (const [key, value] of Object.entries(font.tracking)) {
    vars[`${PREFIX}-tracking-${key}`] = value;
  }
  for (const [key, value] of Object.entries(typeRoles)) vars[`${PREFIX}-type-${key}`] = value;
  for (const [key, value] of Object.entries(motion)) vars[`${PREFIX}-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(layout)) vars[`${PREFIX}-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(zIndex)) vars[`${PREFIX}-z-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(components)) vars[`${PREFIX}-${kebab(key)}`] = value;

  return vars;
}

/** The names legacy rules still read, each pointed at its Cadran replacement. */
export function cadranDeprecatedVariables(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(deprecated).map(([key, value]) => [`${PREFIX}-${key}`, value]),
  );
}

function declarations(vars: Record<string, string>, indent: string): string {
  return Object.entries(vars)
    .map(([name, value]) => `${indent}${name}: ${value};`)
    .join("\n");
}

/**
 * Render the Cadran stylesheet.
 *
 * Same three theme states as Signal, in the order a browser resolves them:
 * light on bare `:root`, dark under `prefers-color-scheme: dark` unless the
 * document opted into light, and an explicit `data-theme` that always wins.
 */
export function renderCadranCss(): string {
  const header = [
    "/*",
    " * NEXUS Cadran — design tokens of the web dashboard.",
    " *",
    " * GENERATED FILE. Do not edit by hand: run `pnpm --filter @nexus/design build`.",
    " * The source of truth is packages/design/src/cadran.ts. A test fails if this",
    " * file and that module disagree, or if a colour pair falls under WCAG AA.",
    " */",
    "",
  ].join("\n");

  const light = paletteVariables(palettes.light);
  const dark = paletteVariables(palettes.dark);

  const sections = [
    [
      ":root {",
      declarations(cadranScaleVariables(), "  "),
      "",
      "  /* Deprecated: read by legacy rules only, removed with the last of them. */",
      declarations(cadranDeprecatedVariables(), "  "),
      "",
      declarations(light, "  "),
      "}",
    ].join("\n"),
    [
      "@media (prefers-color-scheme: dark) {",
      '  :root:not([data-theme="light"]) {',
      declarations(dark, "    "),
      "  }",
      "}",
    ].join("\n"),
    [':root[data-theme="dark"] {', declarations(dark, "  "), "}"].join("\n"),
  ];

  return `${header}\n${sections.join("\n\n")}\n`;
}
