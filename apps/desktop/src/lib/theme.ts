/**
 * Theme preference.
 *
 * Mirrors the dashboard's control — light / system / dark, with "system" as
 * the default so the app follows the desktop environment unless told not to.
 * The colours themselves come from @nexus/design; this module only decides
 * which of the two palettes the document is in.
 *
 * Unlike the dashboard, the preference is stored in `localStorage`: a desktop
 * window is reopened rather than reloaded, and the Tauri shell holds no auth
 * token in web storage — credentials live in the OS keyring (`shells.ts`).
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "nexus.theme";

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** Read the stored preference, defaulting to following the system. */
export function readPreference(): ThemePreference {
  try {
    const stored: unknown = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Reflect a preference onto the document, and remember it. */
export function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);

  try {
    if (preference === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not fatal: the attribute is already set for this window.
  }
}

/** Apply the stored preference before the first render, to avoid a flash. */
export function initTheme(): void {
  applyPreference(readPreference());
}
