/**
 * NEXUS Signal — the design system shared by every NEXUS front end.
 *
 * Import tokens from here in TypeScript (mobile, desktop window chrome); import
 * `@nexus/design/tokens.css` in a web app to get the same values as CSS custom
 * properties.
 */

export {
  RISK_LEVELS,
  defaultTheme,
  font,
  fontSizes,
  layout,
  motion,
  palettes,
  radii,
  radius,
  riskColor,
  space,
  spacing,
  statusColor,
  statusLabel,
  statusTone,
  toLegacyColor,
  zIndex,
} from "./tokens.js";
export type { Palette, RiskLevel, StatusTone, ThemeName } from "./tokens.js";
export { paletteStyleAttribute, paletteVariables, renderTokensCss, scaleVariables } from "./css.js";
export { cadran, mix as mixColour } from "./cadran.js";
export type { CadranPalette } from "./cadran.js";
export { cadranScaleVariables, renderCadranCss } from "./cadran-css.js";
