/**
 * NEXUS Signal — design tokens.
 *
 * This module is the only place in the monorepo where a raw colour, radius,
 * duration or spacing value is allowed to exist. The dashboard and desktop
 * apps consume it as generated CSS custom properties (`tokens.css`); the
 * mobile app consumes the same objects directly, because React Native has no
 * CSS. One source, three renderers — a palette change cannot drift between
 * surfaces any more.
 *
 * Design rules encoded here, in order of precedence:
 *
 *  1. **Surfaces are a ramp, not a set.** Each theme defines six ordered
 *     elevations. Depth is expressed by moving along the ramp, never by a
 *     shadow in dense regions.
 *  2. **One accent, reserved for interaction.** `accent` means "you can act on
 *     this". Information uses the status family instead, so blue never has to
 *     mean both "clickable" and "informational" on the same screen.
 *  3. **`signal` marks what is live.** The second accent is used for the active
 *     rail, running state and streaming data — things that change on their own.
 *  4. **Status is never hue alone.** Every status carries a foreground, a tinted
 *     background and a line colour, so a badge stays legible with the hue
 *     removed; callers pair it with a glyph or a rail.
 *  5. **Risk hues are fixed across themes.** A HIGH in the server log, on the
 *     dashboard and on the phone must be recognisably the same colour; only
 *     lightness is adjusted so it stays readable on paper and on ink.
 */

/** Available themes. Dark is the default on every surface. */
export type ThemeName = "dark" | "light";

/** Severity levels emitted by the tool layer, ordered from benign to blocking. */
export const RISK_LEVELS = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** A status colour triplet: readable text, tinted fill, and a matching hairline. */
export interface StatusTone {
  /** Foreground, guaranteed ≥ 4.5:1 on `surface` of the same theme. */
  readonly fg: string;
  /** Tinted fill for chips and rails, low enough to keep `fg` readable on it. */
  readonly bg: string;
  /** Border for the same chip, one step stronger than `bg`. */
  readonly line: string;
}

/** The complete set of theme-dependent values. */
export interface Palette {
  /** Page background, the furthest-back plane. */
  readonly canvas: string;
  /** Recessed areas inside the page: code blocks, table bodies, wells. */
  readonly canvasSunken: string;
  /** Default card and panel background. */
  readonly surface: string;
  /** A card sitting on top of another card; also the sidebar. */
  readonly surfaceRaised: string;
  /** Hover feedback on an interactive surface. */
  readonly surfaceHover: string;
  /** Pressed or selected surface. */
  readonly surfaceActive: string;
  /** Floating layers: menus, modals, toasts. */
  readonly surfaceOverlay: string;
  /** Scrim behind a modal. */
  readonly scrim: string;

  /** Hairline between regions. */
  readonly line: string;
  /** Emphasised border: focused fields, selected cards, table headers. */
  readonly lineStrong: string;

  /** Primary reading colour. */
  readonly text: string;
  /** Secondary text: labels, descriptions, metadata. */
  readonly textMuted: string;
  /** Tertiary text: timestamps, disabled, placeholder. */
  readonly textFaint: string;
  /** Text placed on top of `accent`. */
  readonly textOnAccent: string;

  /** Interaction colour. Reserved for things the user can act on. */
  readonly accent: string;
  /** Accent under the pointer. */
  readonly accentHover: string;
  /** Tinted accent fill for selected rows and ghost buttons. */
  readonly accentMuted: string;
  /** Accent as a border. */
  readonly accentLine: string;

  /** Liveness colour: active rail, running task, streaming token. */
  readonly signal: string;
  /** Tinted liveness fill. */
  readonly signalMuted: string;

  /** Nominal, succeeded, healthy. */
  readonly ok: StatusTone;
  /** Degraded, pending confirmation, quota nearly exhausted. */
  readonly warn: StatusTone;
  /** Failed, revoked, blocked. */
  readonly danger: StatusTone;
  /** Neutral information, counts, inert metadata. */
  readonly info: StatusTone;
  /** Unknown or not applicable. */
  readonly neutral: StatusTone;

  /** Severity hues, shared with the server log vocabulary. */
  readonly risk: Readonly<Record<RiskLevel, string>>;

  /** Elevation for floating layers only. */
  readonly shadowOverlay: string;
  /** Elevation for small poppers. */
  readonly shadowPopover: string;

  /** Native form-control scheme, so date pickers and scrollbars follow. */
  readonly colorScheme: "dark" | "light";
}

/**
 * Dark theme — cool ink.
 *
 * The ramp is a single hue (220°) losing lightness, never neutral grey: a pure
 * grey next to the accent reads as a dead pixel field on an OLED panel, which
 * is what most of these screens are watched on at night.
 */
const dark: Palette = {
  canvas: "#080b11",
  canvasSunken: "#05070b",
  surface: "#0e131c",
  surfaceRaised: "#141b26",
  surfaceHover: "#1a2230",
  surfaceActive: "#212b3b",
  surfaceOverlay: "#161e2a",
  scrim: "rgb(3 6 11 / 68%)",

  line: "rgb(146 172 206 / 14%)",
  lineStrong: "rgb(146 172 206 / 28%)",

  text: "#e9eefa",
  textMuted: "#95a3ba",
  textFaint: "#6a788e",
  textOnAccent: "#04070e",

  accent: "#5b9dff",
  accentHover: "#7cb0ff",
  accentMuted: "rgb(91 157 255 / 14%)",
  accentLine: "rgb(91 157 255 / 42%)",

  signal: "#49dcd8",
  signalMuted: "rgb(73 220 216 / 14%)",

  ok: { fg: "#4ed39a", bg: "rgb(78 211 154 / 13%)", line: "rgb(78 211 154 / 34%)" },
  warn: { fg: "#f0b64e", bg: "rgb(240 182 78 / 13%)", line: "rgb(240 182 78 / 34%)" },
  danger: { fg: "#ff7b86", bg: "rgb(255 123 134 / 13%)", line: "rgb(255 123 134 / 36%)" },
  info: { fg: "#78b4ff", bg: "rgb(120 180 255 / 13%)", line: "rgb(120 180 255 / 32%)" },
  neutral: { fg: "#8d9bb1", bg: "rgb(141 155 177 / 12%)", line: "rgb(141 155 177 / 26%)" },

  risk: {
    SAFE: "#4ed39a",
    LOW: "#6fb5ff",
    MEDIUM: "#f0b64e",
    HIGH: "#ff9d57",
    CRITICAL: "#ff6f7d",
  },

  shadowOverlay: "0 24px 64px -16px rgb(0 0 0 / 68%)",
  shadowPopover: "0 10px 28px -10px rgb(0 0 0 / 56%)",

  colorScheme: "dark",
};

/**
 * Light theme — cool paper.
 *
 * Not a mathematical inversion of the dark ramp: inverting puts the brightest
 * surface at the back, which makes cards sink instead of lift. Here the canvas
 * is tinted and cards are pure white, so the ramp still rises toward the user.
 * Accents and status foregrounds are darkened independently to hold ≥ 4.5:1 on
 * white — the dark-theme values would all fail there.
 */
const light: Palette = {
  canvas: "#f4f7fb",
  canvasSunken: "#e9eff7",
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  surfaceHover: "#eef3fa",
  surfaceActive: "#e3ebf6",
  surfaceOverlay: "#ffffff",
  scrim: "rgb(15 27 45 / 38%)",

  line: "rgb(17 38 70 / 13%)",
  lineStrong: "rgb(17 38 70 / 26%)",

  text: "#0d1826",
  textMuted: "#4e5d75",
  textFaint: "#6c7c95",
  textOnAccent: "#ffffff",

  accent: "#1f5fd0",
  accentHover: "#174bab",
  accentMuted: "rgb(31 95 208 / 10%)",
  accentLine: "rgb(31 95 208 / 38%)",

  signal: "#0d7f87",
  signalMuted: "rgb(13 127 135 / 12%)",

  ok: { fg: "#0b7247", bg: "rgb(11 114 71 / 10%)", line: "rgb(11 114 71 / 28%)" },
  warn: { fg: "#8a5a00", bg: "rgb(138 90 0 / 10%)", line: "rgb(138 90 0 / 26%)" },
  danger: { fg: "#b82436", bg: "rgb(184 36 54 / 9%)", line: "rgb(184 36 54 / 26%)" },
  info: { fg: "#1a5cb8", bg: "rgb(26 92 184 / 9%)", line: "rgb(26 92 184 / 26%)" },
  neutral: { fg: "#51607a", bg: "rgb(81 96 122 / 10%)", line: "rgb(81 96 122 / 24%)" },

  risk: {
    SAFE: "#0b7247",
    LOW: "#1a5cb8",
    MEDIUM: "#8a5a00",
    HIGH: "#a44a06",
    CRITICAL: "#b82436",
  },

  shadowOverlay: "0 24px 56px -18px rgb(15 33 62 / 22%)",
  shadowPopover: "0 10px 24px -10px rgb(15 33 62 / 18%)",

  colorScheme: "light",
};

/** Both palettes, keyed by theme name. */
export const palettes: Readonly<Record<ThemeName, Palette>> = { dark, light };

/** The default palette. Dark: these screens are watched at night. */
export const defaultTheme: ThemeName = "dark";

/**
 * Scales are declared as numbers and projected to CSS lengths.
 *
 * React Native rejects `"10px"` — it wants `10` — and CSS wants the unit, so
 * one of the two renderers has to convert. Declaring the number as the source
 * means neither one owns the value: `space` below is derived, never typed out
 * a second time, and the two platforms cannot drift by a pixel.
 */
function toPx<K extends string>(scale: Readonly<Record<K, number>>): Readonly<Record<K, string>> {
  return Object.fromEntries(
    Object.entries(scale).map(([key, value]) => [key, `${String(value)}px`]),
  ) as Record<K, string>;
}

/**
 * Spacing scale, 4 px base.
 *
 * Supervision screens are dense; the scale stops being linear above step 6 so
 * that section rhythm stays distinguishable from component padding.
 */
export const spacing = {
  "0": 0,
  "1": 2,
  "2": 4,
  "3": 6,
  "4": 8,
  "5": 12,
  "6": 16,
  "7": 20,
  "8": 24,
  "9": 32,
  "10": 40,
  "11": 56,
  "12": 72,
} as const;

/** Corner radii. `pill` is for chips and toggles only. */
export const radii = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/** Font sizes, in points on mobile and pixels on the web. */
export const fontSizes = {
  "3xs": 10,
  "2xs": 11,
  xs: 12,
  sm: 13,
  md: 14,
  lg: 16,
  xl: 20,
  "2xl": 26,
  "3xl": 34,
} as const;

/** The spacing scale as CSS lengths. */
export const space = toPx(spacing);

/** The radius scale as CSS lengths. */
export const radius = toPx(radii);

/**
 * Type scale.
 *
 * Two families only. `mono` is not decorative: every number, identifier, hash
 * and duration in the product renders in it with tabular figures, so columns
 * line up and a changing value does not reflow its neighbours.
 */
export const font = {
  sans: '"Inter var", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  size: toPx(fontSizes),
  weight: { regular: "400", medium: "500", semibold: "600", bold: "700" },
  leading: { tight: "1.2", snug: "1.35", normal: "1.5", relaxed: "1.65" },
  tracking: { tight: "-0.011em", normal: "0", wide: "0.04em", caps: "0.09em" },
} as const;

/** Motion. Nothing here is decorative; these are feedback latencies. */
export const motion = {
  instant: "90ms",
  fast: "140ms",
  normal: "220ms",
  slow: "380ms",
  ease: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

/** Fixed layout measurements shared by the web shells. */
export const layout = {
  sidebar: "248px",
  sidebarCollapsed: "60px",
  header: "64px",
  contentMax: "1480px",
  readingMax: "72ch",
  /** Width of the active-state rail. The system's signature element. */
  rail: "2px",
} as const;

/** Stacking order. Declared centrally so overlays cannot fight each other. */
export const zIndex = {
  base: "0",
  rail: "1",
  sticky: "10",
  header: "20",
  drawer: "30",
  overlay: "40",
  toast: "50",
} as const;

/** Resolve a risk level to its hue in the given palette. */
export function riskColor(level: string, palette: Palette = dark): string {
  return (palette.risk as Record<string, string | undefined>)[level] ?? palette.neutral.fg;
}

/** Resolve a task status to the status tone that represents it. */
export function statusTone(status: string, palette: Palette = dark): StatusTone {
  switch (status) {
    case "succeeded":
      return palette.ok;
    case "partial":
    case "waiting_for_confirmation":
      return palette.warn;
    case "failed":
      return palette.danger;
    case "cancelled":
      return palette.neutral;
    default:
      return palette.info;
  }
}

/** Resolve a task status to a single foreground colour. */
export function statusColor(status: string, palette: Palette = dark): string {
  if (status === "running" || status === "pending") return palette.signal;
  return statusTone(status, palette).fg;
}

/** Human-readable label for a task status. */
export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "queued",
    running: "running",
    waiting_for_confirmation: "awaiting confirmation",
    succeeded: "completed",
    partial: "partially completed",
    failed: "failed",
    cancelled: "cancelled",
  };
  return labels[status] ?? status;
}

/**
 * Convert a token colour to the legacy `rgba()` form.
 *
 * The palette is written in CSS Color 4 syntax — `rgb(78 211 154 / 13%)` —
 * which every browser understands and React Native does not: its colour
 * parser silently fails on the space-separated form, and the view ends up
 * transparent. Rather than keeping a second set of colours for mobile, which
 * is exactly the drift this package exists to prevent, mobile passes each
 * value through here.
 *
 * Hex and already-legacy values are returned untouched.
 */
export function toLegacyColor(value: string): string {
  const match =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?)\s*)?\)$/.exec(
      value.trim(),
    );
  if (match === null) return value;

  const [, red = "0", green = "0", blue = "0", rawAlpha, percent] = match;
  if (rawAlpha === undefined) return `rgba(${red}, ${green}, ${blue}, 1)`;

  const alpha = percent === "%" ? Number(rawAlpha) / 100 : Number(rawAlpha);
  return `rgba(${red}, ${green}, ${blue}, ${String(Number(alpha.toFixed(4)))})`;
}
