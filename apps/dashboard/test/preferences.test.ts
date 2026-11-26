import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPreference, initTheme, readPreference, resolveTheme } from "../src/lib/theme.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

describe("theme preference", () => {
  const storage = new Map<string, string>();
  const attributes = new Map<string, string>();
  let prefersDark = false;

  beforeEach(() => {
    storage.clear();
    attributes.clear();
    prefersDark = false;

    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      matchMedia: () => ({ matches: prefersDark }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        setAttribute: (key: string, value: string) => attributes.set(key, value),
        removeAttribute: (key: string) => attributes.delete(key),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the system until the user chooses", () => {
    expect(readPreference()).toBe("system");
    expect(initTheme()).toBe("system");
    expect(attributes.has("data-theme")).toBe(false);
  });

  it("writes an explicit choice on the document and keeps it for the tab session", () => {
    applyPreference("light");
    expect(attributes.get("data-theme")).toBe("light");
    expect(readPreference()).toBe("light");

    applyPreference("dark");
    expect(attributes.get("data-theme")).toBe("dark");
    expect(readPreference()).toBe("dark");
  });

  it("returns to the system setting without leaving anything behind", () => {
    applyPreference("dark");
    applyPreference("system");
    expect(attributes.has("data-theme")).toBe(false);
    expect(storage.size).toBe(0);
  });

  it("ignores a stored value it does not know", () => {
    storage.set("nexus.theme", "neon");
    expect(readPreference()).toBe("system");
  });

  it("resolves the system preference to the theme in effect", () => {
    expect(resolveTheme("system")).toBe("light");
    prefersDark = true;
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });
});

/**
 * One identity. The seven user-selectable accent themes were removed with the
 * move to Cadran; nothing may reintroduce a per-user accent palette.
 */
describe("single identity", () => {
  const files = sources(join(root, "src"));

  it("has no accent-theme module or attribute left", () => {
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      // `theme-rgb.ts` still lists the attribute in a MutationObserver filter; it
      // is deleted with the decorative canvas that uses it.
      if (file.endsWith("theme-rgb.ts")) continue;
      expect(code, file).not.toContain("data-color-theme");
      expect(code, file).not.toContain("--nx-theme-");
      expect(code, file).not.toContain("color-theme.js");
    }
  });

  it("loads the Cadran tokens and no display face from the old identity", () => {
    const css = files
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(file, "utf8"));
    expect(css.some((code) => code.includes("@nexus/design/cadran.css"))).toBe(true);
    for (const code of css) {
      expect(code).not.toContain("@nexus/design/tokens.css");
      expect(code).not.toMatch(/@font-face[^}]*(Orbitron|Rajdhani)/);
    }
  });
});
