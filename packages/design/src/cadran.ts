/**
 * NEXUS Cadran — the identity of the redesigned web dashboard.
 *
 * Cadran lives beside "Signal" (`tokens.ts`) instead of replacing it. Signal is
 * imported at runtime by the mobile and desktop applications, which have not
 * been redesigned; changing its values would restyle them untested. The web
 * dashboard switches by importing `@nexus/design/cadran.css`. Because both
 * identities use the same `--nx-*` names, that import is the whole switch.
 *
 * Rules encoded here (see docs/design/03-design-system.md):
 *
 *  1. Graphite and one lamp. Radium is the only brand hue; every other colour
 *     is a state.
 *  2. `accent` is text-grade (focus, links, selection); `signal` is the lamp
 *     (bars, rails, activity marks) and is a graphic colour only — in the light
 *     theme it is 3.25:1 and must never carry text.
 *  3. Status fills are opaque mixes into the surface, so a badge keeps its
 *     measured contrast on a hovered or selected row.
 *  4. The contrast matrix in `test/cadran.test.ts` is part of the contract.
 */

import { bone, graphite, hue, radium } from "./primitives.js";
import {
  type Palette,
  type StatusTone,
  type ThemeName,
  palettes as signal,
  spacing,
} from "./tokens.js";

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const at = (offset: number): number => Number.parseInt(value.slice(offset, offset + 2), 16);
  return [at(0), at(2), at(4)];
}

/** Opaque mix of `colour` into `base`: `ratio` of the first, the rest of the second. */
export function mix(colour: string, base: string, ratio: number): string {
  const top = channels(colour);
  const bottom = channels(base);
  const out = top.map((value, index) =>
    Math.round(value * ratio + (bottom[index] ?? 0) * (1 - ratio)),
  );
  return `#${out.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** `colour` at `percent` opacity, in the CSS Color 4 form the Signal palette uses. */
function alpha(colour: string, percent: number): string {
  const [red, green, blue] = channels(colour);
  return `rgb(${String(red)} ${String(green)} ${String(blue)} / ${String(percent)}%)`;
}

/** A status triplet whose fill and line are opaque mixes into the surface. */
function tone(fg: string, surface: string): StatusTone {
  return { fg, bg: mix(fg, surface, 0.13), line: mix(fg, surface, 0.32) };
}

/** A Cadran palette: the Signal shape with the two optional keys made mandatory. */
export type CadranPalette = Palette & { readonly lineControl: string; readonly focus: string };

/** Dark theme — the reference. */
const dark: CadranPalette = {
  canvas: graphite[950],
  canvasSunken: graphite[975],
  surface: graphite[900],
  surfaceRaised: graphite[875],
  surfaceHover: graphite[825],
  surfaceActive: graphite[750],
  surfaceOverlay: graphite[850],
  scrim: "rgb(7 8 7 / 72%)",

  line: graphite[800],
  lineStrong: graphite[700],
  lineControl: graphite[500],

  text: bone[100],
  textMuted: bone[300],
  textFaint: bone[450],
  textOnAccent: radium[950],

  accent: radium[300],
  accentHover: radium[200],
  accentMuted: alpha(radium[300], 14),
  accentLine: alpha(radium[300], 40),

  signal: radium[300],
  signalMuted: mix(radium[300], graphite[900], 0.14),
  focus: radium[300],

  ok: tone(hue.green[300], graphite[900]),
  warn: tone(hue.amber[300], graphite[900]),
  danger: tone(hue.red[300], graphite[900]),
  info: tone(hue.blue[300], graphite[900]),
  neutral: tone(bone[400], graphite[900]),

  // Shared with the server log vocabulary: imported, never copied.
  risk: signal.dark.risk,

  // Cadran has no elevation. The names stay so existing rules resolve.
  shadowOverlay: "none",
  shadowPopover: "none",

  colorScheme: "dark",
};

/** Light theme — passes the same matrix; dark stays the one designed first. */
const light: CadranPalette = {
  canvas: graphite[50],
  canvasSunken: graphite[100],
  surface: graphite[25],
  surfaceRaised: graphite[0],
  surfaceHover: graphite[75],
  surfaceActive: graphite[150],
  surfaceOverlay: graphite[0],
  scrim: "rgb(20 21 19 / 40%)",

  line: graphite[200],
  lineStrong: graphite[300],
  lineControl: graphite[450],

  text: graphite[890],
  textMuted: graphite[650],
  textFaint: graphite[550],
  textOnAccent: graphite[0],

  accent: radium[700],
  accentHover: radium[800],
  accentMuted: alpha(radium[700], 14),
  accentLine: alpha(radium[700], 40),

  // Brighter than the accent on purpose: a lamp has to look lit on paper.
  signal: radium[600],
  signalMuted: mix(radium[600], graphite[25], 0.14),
  focus: radium[700],

  ok: tone(hue.green[700], graphite[25]),
  warn: tone(hue.amber[700], graphite[25]),
  danger: tone(hue.red[700], graphite[25]),
  info: tone(hue.blue[700], graphite[25]),
  neutral: tone(graphite[600], graphite[25]),

  risk: signal.light.risk,

  shadowOverlay: "none",
  shadowPopover: "none",

  colorScheme: "light",
};

export const palettes: Readonly<Record<ThemeName, CadranPalette>> = { dark, light };

/** The seven surfaces of a theme, in ramp order. The contrast matrix walks them. */
export const SURFACES = [
  "canvas",
  "canvasSunken",
  "surface",
  "surfaceRaised",
  "surfaceHover",
  "surfaceActive",
  "surfaceOverlay",
] as const satisfies readonly (keyof Palette)[];

/** Corner radii. Nothing is round. */
export const radii = { xs: 0, sm: 2, md: 3, lg: 4 } as const;

/** Seven sizes, down from the twenty-nine the old interface rendered. */
export const fontSizes = { "2xs": 11, xs: 12, sm: 13, md: 14, lg: 18, xl: 22, "2xl": 28 } as const;

const SANS =
  '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

export const font = {
  sans: SANS,
  mono: MONO,
  display: SANS,
  weight: { regular: "400", medium: "500", semibold: "600" },
  leading: { tight: "1.2", snug: "1.35", normal: "1.5", relaxed: "1.65" },
  tracking: { tight: "-0.012em", normal: "0", wide: "0.04em", caps: "0.08em" },
} as const;

/**
 * Type roles. Components use a role, never a raw size: `font: var(--nx-type-label)`.
 * Each value is a complete `font` shorthand.
 */
export const typeRoles = {
  display: `500 28px/34px ${SANS}`,
  kpi: `500 22px/26px ${MONO}`,
  title: `600 18px/24px ${SANS}`,
  heading: `600 14px/20px ${SANS}`,
  read: `400 14px/23px ${SANS}`,
  body: `400 13px/20px ${SANS}`,
  small: `400 12px/17px ${SANS}`,
  data: `400 12px/18px ${MONO}`,
  label: `500 11px/14px ${MONO}`,
} as const;

/** An instrument answers at once: lamps switch, overlays arrive in under 200 ms. */
export const motion = {
  instant: "0ms",
  fast: "80ms",
  normal: "120ms",
  slow: "180ms",
  ease: "cubic-bezier(0, 0, 0.2, 1)",
  blink: "1s steps(1) infinite",
} as const;

/**
 * Layout measurements.
 *
 * `sidebar` and `header` keep the values the current shell was built with. They
 * become 240px and 38px in the change that replaces that shell; moving them
 * earlier would squash a header that still holds a title and a description.
 */
export const layout = {
  sidebar: "248px",
  sidebarCollapsed: "60px",
  inspector: "360px",
  header: "64px",
  statusbar: "26px",
  contentMax: "1480px",
  readingMax: "72ch",
  rail: "2px",
} as const;

/** Tier 3. A token exists here only when two components must agree. */
export const components = {
  controlHeight: "28px",
  controlHeightSm: "24px",
  rowHeight: "30px",
  cardPadding: "12px",
  cardRadius: "2px",
  targetMin: "24px",
  buttonPrimaryBg: "var(--nx-text)",
  buttonPrimaryFg: "var(--nx-canvas)",
  buttonPrimaryBgHover: "var(--nx-text-muted)",
  focusRing: "2px solid var(--nx-focus)",
  iconStroke: "1.5",
  iconCap: "square",
  iconJoin: "miter",
  lampSize: "7px",
  meterSegment: "5px",
  meterGap: "2px",
} as const;

/**
 * Names the old stylesheets still use. Each resolves to its Cadran replacement
 * so nothing renders under 11px or with a pill from the first day; the block is
 * deleted with the last rule that reads it.
 */
export const deprecated = {
  "size-3xs": "11px",
  "size-3xl": "28px",
  "radius-xl": "4px",
  "radius-pill": "0px",
  "weight-bold": "600",
  "ease-out": "cubic-bezier(0, 0, 0.2, 1)",
} as const;

/** The spacing scale is shared with Signal, unchanged. */
export { spacing };

export const cadran = {
  palettes,
  radii,
  fontSizes,
  font,
  typeRoles,
  motion,
  layout,
  components,
  spacing,
} as const;
