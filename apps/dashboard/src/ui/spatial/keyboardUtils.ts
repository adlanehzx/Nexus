/**
 * NEXUS Spatial OS — Universal Keyboard Shortcuts Utility
 * Supports QWERTY, AZERTY, QWERTZ, Numpad, and browser/desktop environments.
 */

/**
 * Extracts a numeric digit (0-9) from a KeyboardEvent across all keyboard layouts.
 * Particularly handles French AZERTY where top-row unshifted keys are symbols (&, é, ", etc.)
 */
export function getDigitFromEvent(
  e: KeyboardEvent | { code?: string; key?: string; keyCode?: number },
): number | null {
  // 1. Physical key code (independent of layout / shift)
  if (typeof e.code === "string") {
    if (e.code.startsWith("Digit")) {
      const val = parseInt(e.code.replace("Digit", ""), 10);
      if (!isNaN(val) && val >= 0 && val <= 9) return val;
    }
    if (e.code.startsWith("Numpad")) {
      const val = parseInt(e.code.replace("Numpad", ""), 10);
      if (!isNaN(val) && val >= 0 && val <= 9) return val;
    }
  }

  // 2. Direct character check
  if (typeof e.key === "string") {
    if (/^[0-9]$/.test(e.key)) {
      return parseInt(e.key, 10);
    }

    // 3. French AZERTY unshifted key mappings
    const azertyMap: Record<string, number> = {
      "&": 1,
      é: 2,
      '"': 3,
      "'": 4,
      "(": 5,
      "-": 6,
      è: 7,
      _: 8,
      ç: 9,
      à: 0,
    };
    const mapped = azertyMap[e.key];
    if (mapped !== undefined) {
      return mapped;
    }
  }

  // 4. Fallback to standard key codes
  if (typeof e.keyCode === "number") {
    if (e.keyCode >= 48 && e.keyCode <= 57) {
      return e.keyCode - 48;
    }
    if (e.keyCode >= 96 && e.keyCode <= 105) {
      return e.keyCode - 96;
    }
  }

  return null;
}

/**
 * Checks if the user is currently editing a form element.
 */
export function isEditingText(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el as HTMLElement).isContentEditable
  );
}
