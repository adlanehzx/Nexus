/**
 * Cadran — tier 1 primitives.
 *
 * Raw values, named for what they are. This module is imported by `cadran.ts`
 * and by nothing else: it is not exported from the package index and is never
 * emitted as CSS, so no screen can reach a raw colour by accident. A component
 * uses a semantic token (`--nx-surface`), never `graphite[900]`.
 */

/** Neutral ramp, with a trace of green so it reads as instrument glass, not grey. */
export const graphite = {
  0: "#ffffff",
  25: "#f8f8f4",
  50: "#efefea",
  75: "#eaeae4",
  100: "#e5e5df",
  150: "#dfdfd8",
  200: "#d9d9d1",
  300: "#c2c2b8",
  450: "#787870",
  500: "#767b76",
  550: "#5c5e57",
  600: "#55584f",
  650: "#4d4f49",
  700: "#383c38",
  750: "#282b28",
  800: "#262926",
  825: "#1f211f",
  850: "#1b1d1b",
  875: "#181a18",
  890: "#141513",
  900: "#121312",
  950: "#0c0d0c",
  975: "#070807",
} as const;

/** Bone: the text colours of the dark theme. */
export const bone = {
  100: "#e8e9e3",
  300: "#a9aba3",
  400: "#9b9e96",
  450: "#93968e",
} as const;

/** Radium: the one lamp. Light steps for dark surfaces, deep steps for light ones. */
export const radium = {
  200: "#d8f57e",
  300: "#c6ee4f",
  600: "#5e8500",
  700: "#476100",
  800: "#374c00",
  950: "#10140a",
} as const;

/** Status hues: one luminous step for the dark theme, one deep step for the light. */
export const hue = {
  green: { 300: "#4fd1a5", 700: "#056b56" },
  amber: { 300: "#f2b544", 700: "#805200" },
  red: { 300: "#ff7a70", 700: "#ae241c" },
  blue: { 300: "#8cb8e0", 700: "#285e94" },
} as const;
