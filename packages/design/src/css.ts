/**
 * CSS projection of the design tokens.
 *
 * The web apps never import the TypeScript tokens at runtime: they consume the
 * custom properties emitted here, committed as `tokens.css`. The committed file
 * is checked against this generator by a test, so the stylesheet cannot drift
 * away from the values the mobile app uses.
 */

import {
  type Palette,
  type ThemeName,
  font,
  layout,
  motion,
  palettes,
  radius,
  space,
  zIndex,
} from "./tokens.js";

/** Prefix for every custom property, so app-local variables stay telling apart. */
const PREFIX = "--nx";

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Theme-dependent custom properties for one palette.
 *
 * Exported because the desktop app also needs them to paint its native window
 * chrome, which is set from JavaScript rather than from a stylesheet.
 */
export function paletteVariables(palette: Palette): Record<string, string> {
  const vars: Record<string, string> = {
    "color-scheme": palette.colorScheme,

    [`${PREFIX}-canvas`]: palette.canvas,
    [`${PREFIX}-canvas-sunken`]: palette.canvasSunken,
    [`${PREFIX}-surface`]: palette.surface,
    [`${PREFIX}-surface-raised`]: palette.surfaceRaised,
    [`${PREFIX}-surface-hover`]: palette.surfaceHover,
    [`${PREFIX}-surface-active`]: palette.surfaceActive,
    [`${PREFIX}-surface-overlay`]: palette.surfaceOverlay,
    [`${PREFIX}-scrim`]: palette.scrim,

    [`${PREFIX}-line`]: palette.line,
    [`${PREFIX}-line-strong`]: palette.lineStrong,

    [`${PREFIX}-text`]: palette.text,
    [`${PREFIX}-text-muted`]: palette.textMuted,
    [`${PREFIX}-text-faint`]: palette.textFaint,
    [`${PREFIX}-text-on-accent`]: palette.textOnAccent,

    [`${PREFIX}-accent`]: palette.accent,
    [`${PREFIX}-accent-hover`]: palette.accentHover,
    [`${PREFIX}-accent-muted`]: palette.accentMuted,
    [`${PREFIX}-accent-line`]: palette.accentLine,

    [`${PREFIX}-signal`]: palette.signal,
    [`${PREFIX}-signal-muted`]: palette.signalMuted,

    [`${PREFIX}-shadow-overlay`]: palette.shadowOverlay,
    [`${PREFIX}-shadow-popover`]: palette.shadowPopover,
  };

  for (const name of ["ok", "warn", "danger", "info", "neutral"] as const) {
    const tone = palette[name];
    vars[`${PREFIX}-${name}`] = tone.fg;
    vars[`${PREFIX}-${name}-bg`] = tone.bg;
    vars[`${PREFIX}-${name}-line`] = tone.line;
  }

  for (const [level, value] of Object.entries(palette.risk)) {
    vars[`${PREFIX}-risk-${level.toLowerCase()}`] = value;
  }

  return vars;
}

/** Theme-independent custom properties: scales, type, motion, layout. */
export function scaleVariables(): Record<string, string> {
  const vars: Record<string, string> = {
    [`${PREFIX}-font-sans`]: font.sans,
    [`${PREFIX}-font-mono`]: font.mono,
  };

  for (const [key, value] of Object.entries(space)) vars[`${PREFIX}-space-${key}`] = value;
  for (const [key, value] of Object.entries(radius)) vars[`${PREFIX}-radius-${key}`] = value;
  for (const [key, value] of Object.entries(font.size)) vars[`${PREFIX}-size-${key}`] = value;
  for (const [key, value] of Object.entries(font.weight)) vars[`${PREFIX}-weight-${key}`] = value;
  for (const [key, value] of Object.entries(font.leading)) vars[`${PREFIX}-leading-${key}`] = value;
  for (const [key, value] of Object.entries(font.tracking)) {
    vars[`${PREFIX}-tracking-${key}`] = value;
  }
  for (const [key, value] of Object.entries(motion)) vars[`${PREFIX}-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(layout)) vars[`${PREFIX}-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(zIndex)) vars[`${PREFIX}-z-${kebab(key)}`] = value;

  return vars;
}

function block(selector: string, vars: Record<string, string>, indent = "  "): string {
  const body = Object.entries(vars)
    .map(([name, value]) => `${indent}  ${name}: ${value};`)
    .join("\n");
  return `${indent}${selector} {\n${body}\n${indent}}`;
}

/**
 * Render the full stylesheet.
 *
 * Three theme states are supported, in the order a browser resolves them:
 * the light palette is the unconditional baseline, the dark palette applies
 * under `prefers-color-scheme: dark` unless the document opted into light, and
 * an explicit `data-theme` on the root always wins. Declaring light on bare
 * `:root` is what makes an explicit `data-theme="light"` work inside a dark
 * media query without repeating the whole palette.
 */
export function renderTokensCss(): string {
  const header = [
    "/*",
    " * NEXUS Signal — design tokens.",
    " *",
    " * GENERATED FILE. Do not edit by hand: run `pnpm --filter @nexus/design build`.",
    " * The source of truth is packages/design/src/tokens.ts, which the mobile app",
    " * imports directly. A test fails if this file and that module disagree.",
    " */",
    "",
  ].join("\n");

  const light = paletteVariables(palettes.light);
  const dark = paletteVariables(palettes.dark);

  const sections = [
    `:root {\n${Object.entries({ ...scaleVariables(), ...light })
      .map(([name, value]) => `  ${name}: ${value};`)
      .join("\n")}\n}`,
    `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', dark)}\n}`,
    `${block(':root[data-theme="dark"]', dark, "")}`,
  ];

  return `${header}\n${sections.join("\n\n")}\n`;
}

/** Inline `style` attribute value for one theme, used by the desktop shell. */
export function paletteStyleAttribute(theme: ThemeName): string {
  return Object.entries(paletteVariables(palettes[theme]))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}
