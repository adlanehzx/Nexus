/**
 * Theme preference.
 *
 * Three states, not two. "system" is the default and the one most users keep:
 * the stylesheet already answers `prefers-color-scheme` on its own, so a
 * system user gets the right colours on the very first paint, with no
 * JavaScript involved and no flash. An explicit choice writes `data-theme` on
 * the document element, which overrides the media query in both directions.
 *
 * The preference is per-browser, not per-account: it describes the room the
 * screen is in, not the person signed into it, so it never goes to the server.
 *
 * It is kept in `sessionStorage`, not `localStorage`. The dashboard bans
 * permanent browser storage outright — `test/exposure.test.ts` asserts it — so
 * that an auth token can never end up surviving the tab that obtained it. A
 * colour preference is not a secret, but carving an exception into a security
 * invariant to persist one is a bad trade: "follow system" is the default and
 * needs no storage at all, and an explicit override lasting the tab session is
 * enough for the case it exists for, which is one screen in one bright room.
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "nexus.theme";

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** Read the stored preference. Falls back to "system" when storage is denied. */
export function readPreference(): ThemePreference {
  try {
    const stored: unknown = window.sessionStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    // Private window, or site data blocked. The media query still applies.
    return "system";
  }
}

/** Reflect a preference onto the document, and remember it. */
export function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);

  try {
    if (preference === "system") window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not fatal: the attribute is already set for this session.
  }
}

/**
 * Apply the stored preference.
 *
 * Called from `main.tsx` before the first render rather than from an effect,
 * so a user whose explicit choice differs from their system setting does not
 * see the other theme for a frame.
 */
export function initTheme(): ThemePreference {
  const preference = readPreference();
  applyPreference(preference);
  return preference;
}

/** The theme actually in effect right now, once the preference is resolved. */
export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
