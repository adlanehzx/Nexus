import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  getKeybinding,
  saveUserKeybinding,
  resetAllKeybindings,
  eventMatchesShortcut,
} from "../src/ui/spatial/keybindingStore.js";

describe("keybindingStore", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
        clear: () => storage.clear(),
      },
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provides comprehensive default keybindings", () => {
    expect(DEFAULT_KEYBINDINGS.length).toBeGreaterThanOrEqual(15);
    const space1 = DEFAULT_KEYBINDINGS.find((k) => k.id === "space-1");
    expect(space1?.defaultKeys).toBe("Ctrl+1");

    const fitAll = DEFAULT_KEYBINDINGS.find((k) => k.id === "fit-all");
    expect(fitAll?.defaultKeys).toBe("Ctrl+0");
  });

  it("matches keyboard events accurately", () => {
    // Ctrl+1
    const eventCtrl1 = {
      key: "1",
      code: "Digit1",
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    } as KeyboardEvent;
    expect(eventMatchesShortcut(eventCtrl1, "Ctrl+1")).toBe(true);
    expect(eventMatchesShortcut(eventCtrl1, "Ctrl+2")).toBe(false);

    // AZERTY Ctrl+&
    const eventAzerty1 = {
      key: "&",
      code: "Digit1",
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    } as KeyboardEvent;
    expect(eventMatchesShortcut(eventAzerty1, "Ctrl+1")).toBe(true);

    // Ctrl+Shift+O
    const eventCombo = {
      key: "O",
      code: "KeyO",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    } as KeyboardEvent;
    expect(eventMatchesShortcut(eventCombo, "Ctrl+Shift+O")).toBe(true);
    expect(eventMatchesShortcut(eventCombo, "Ctrl+O")).toBe(false);

    // Escape
    const eventEsc = {
      key: "Escape",
      code: "Escape",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    } as KeyboardEvent;
    expect(eventMatchesShortcut(eventEsc, "Escape")).toBe(true);
  });

  it("persists custom keybindings in sessionStorage", () => {
    expect(getKeybinding("space-1")).toBe("Ctrl+1");

    saveUserKeybinding("space-1", "Alt+F1");
    expect(getKeybinding("space-1")).toBe("Alt+F1");

    resetAllKeybindings();
    expect(getKeybinding("space-1")).toBe("Ctrl+1");
  });
});
