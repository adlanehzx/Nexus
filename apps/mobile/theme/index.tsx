import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  type Palette,
  type RiskLevel,
  type ThemeName,
  fontSizes,
  palettes,
  radii,
  spacing,
  statusLabel,
  toLegacyColor,
} from "@nexus/design";

/**
 * Mobile theme.
 *
 * The colours, spacing and type sizes are the same objects the dashboard and
 * the desktop app render from — `@nexus/design` is the single source. This
 * module only does the two things that are specific to React Native: convert
 * the CSS colour syntax to a form the native colour parser accepts, and make
 * the active palette reactive, since a StyleSheet created at module scope can
 * never follow a theme change.
 *
 * The rule that falls out of that: no screen may build its styles at module
 * scope any more. `useThemedStyles(makeStyles)` is the replacement, and it
 * memoises per palette, so switching theme restyles the app without rebuilding
 * a StyleSheet on every render.
 */

export type { ThemeName, RiskLevel };

/** What a screen sees. Shaped like the palette, flattened for StyleSheet use. */
export interface Theme {
  readonly name: ThemeName;
  readonly color: {
    readonly background: string;
    readonly backgroundSunken: string;
    readonly surface: string;
    readonly surfaceRaised: string;
    readonly surfaceHover: string;
    readonly border: string;
    readonly borderStrong: string;
    readonly text: string;
    readonly textMuted: string;
    readonly textFaint: string;
    readonly textOnAccent: string;
    readonly accent: string;
    readonly accentMuted: string;
    /** Liveness: a task that is running, a reply being streamed. */
    readonly signal: string;
    readonly success: string;
    readonly successBg: string;
    readonly warning: string;
    readonly warningBg: string;
    readonly danger: string;
    readonly dangerBg: string;
    readonly scrim: string;
  };
  readonly risk: Readonly<Record<RiskLevel, string>>;
  /** Spacing step, in points. `space(4)` is one step of the shared scale. */
  space: (step: number) => number;
  readonly radius: typeof radii;
  readonly size: typeof fontSizes;
  /** The underlying palette, for anything the flattened shape does not cover. */
  readonly palette: Palette;
}

function buildTheme(name: ThemeName): Theme {
  const p = palettes[name];
  const rn = toLegacyColor;

  return {
    name,
    color: {
      background: rn(p.canvas),
      backgroundSunken: rn(p.canvasSunken),
      surface: rn(p.surface),
      surfaceRaised: rn(p.surfaceRaised),
      surfaceHover: rn(p.surfaceHover),
      border: rn(p.line),
      borderStrong: rn(p.lineStrong),
      text: rn(p.text),
      textMuted: rn(p.textMuted),
      textFaint: rn(p.textFaint),
      textOnAccent: rn(p.textOnAccent),
      accent: rn(p.accent),
      accentMuted: rn(p.accentMuted),
      signal: rn(p.signal),
      success: rn(p.ok.fg),
      successBg: rn(p.ok.bg),
      warning: rn(p.warn.fg),
      warningBg: rn(p.warn.bg),
      danger: rn(p.danger.fg),
      dangerBg: rn(p.danger.bg),
      scrim: rn(p.scrim),
    },
    risk: Object.fromEntries(
      Object.entries(p.risk).map(([level, value]) => [level, rn(value)]),
    ) as Record<RiskLevel, string>,
    space: (step: number) =>
      (spacing as Record<string, number | undefined>)[String(step)] ?? step * 4,
    radius: radii,
    size: fontSizes,
    palette: p,
  };
}

const THEMES: Readonly<Record<ThemeName, Theme>> = {
  dark: buildTheme("dark"),
  light: buildTheme("light"),
};

/**
 * Dark theme as a plain object.
 *
 * Only for code that runs outside the React tree — navigation options
 * evaluated before the provider mounts, and the two unit tests. Inside a
 * component, use `useTheme()`: this constant cannot follow the phone.
 */
export const theme = THEMES.dark;

/** "system" follows the phone; the other two override it. */
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "nexus.theme";

interface ThemeContextValue {
  readonly theme: Theme;
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: THEMES.dark,
  preference: "system",
  setPreference: () => undefined,
});

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Provides the active theme.
 *
 * Mounted once at the root. The stored preference is read asynchronously —
 * SecureStore has no synchronous API — so the first frame follows the phone;
 * for a user who has not overridden anything, which is the default, that first
 * frame is already correct and nothing changes underneath them.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [preference, setStoredPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(STORAGE_KEY)
      .then((stored) => {
        if (active && isPreference(stored)) setStoredPreference(stored);
      })
      .catch(() => {
        // Keychain unavailable: following the phone is a safe default.
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
    void SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => {
      // Not fatal: the choice still applies for this launch.
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const name: ThemeName =
      preference === "system" ? (system === "light" ? "light" : "dark") : preference;
    return { theme: THEMES[name], preference, setPreference };
  }, [preference, setPreference, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The active theme. */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

/** The preference and its setter, for the settings screen. */
export function useThemePreference(): {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
} {
  const { preference, setPreference } = useContext(ThemeContext);
  return { preference, setPreference };
}

/**
 * Build a StyleSheet from the active theme, memoised per theme.
 *
 * Replaces `const styles = StyleSheet.create({…})` at module scope, which
 * freezes the colours of whichever theme happened to be loaded first.
 */
export function useThemedStyles<T>(factory: (theme: Theme) => T): T {
  const active = useTheme();
  return useMemo(() => factory(active), [factory, active]);
}

/** Colour for a risk level, with a readable fallback. */
export function riskColor(level: string, active: Theme = theme): string {
  return (active.risk as Record<string, string | undefined>)[level] ?? active.color.textMuted;
}

/** Colour for a task status. In-flight work is marked live, not "in progress". */
export function statusColor(status: string, active: Theme = theme): string {
  switch (status) {
    case "running":
    case "pending":
      return active.color.signal;
    case "succeeded":
      return active.color.success;
    case "partial":
    case "waiting_for_confirmation":
      return active.color.warning;
    case "failed":
      return active.color.danger;
    case "cancelled":
      return active.color.textFaint;
    default:
      return active.color.accent;
  }
}

export { statusLabel };
