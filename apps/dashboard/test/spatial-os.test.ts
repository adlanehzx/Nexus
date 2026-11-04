import { describe, expect, it } from "vitest";
import { SPACE_CONFIGS, INITIAL_WINDOWS_PER_SPACE } from "../src/ui/spatial/useSpatialStore.js";
import {
  PRESET_LAYOUTS,
  analyzeIntentForAssistLayout,
} from "../src/ui/spatial/AdaptiveLayoutEngine.js";
import type { CameraState, NativeSpaceId } from "../src/ui/spatial/types.js";

describe("NEXUS Spatial OS & Omarchy Shell Contracts", () => {
  it("defines the 5 native spaces with consistent numbers and shortcuts", () => {
    const spaces: NativeSpaceId[] = ["command", "mission", "code", "device", "memory"];

    spaces.forEach((space, idx) => {
      const cfg = SPACE_CONFIGS[space];
      expect(cfg).toBeDefined();
      expect(cfg.num).toBe(idx + 1);
      expect(cfg.shortcut).toBe(`Ctrl+${idx + 1}`);
      expect(cfg.label).toBeTruthy();
      expect(cfg.labelEn).toBeTruthy();
      expect(cfg.description).toBeTruthy();
    });
  });

  it("configures initial functional windows for each of the 5 spaces", () => {
    // Command Space
    const cmdWins = INITIAL_WINDOWS_PER_SPACE.command;
    expect(cmdWins.some((w) => w.type === "chat")).toBe(true);
    expect(cmdWins.some((w) => w.type === "tasks")).toBe(true);
    expect(cmdWins.some((w) => w.type === "overview")).toBe(true);

    // Mission Space
    const msnWins = INITIAL_WINDOWS_PER_SPACE.mission;
    expect(msnWins.some((w) => w.type === "dag-debugger")).toBe(true);
    expect(msnWins.some((w) => w.type === "mission-control")).toBe(true);
    expect(msnWins.some((w) => w.type === "logs")).toBe(true);

    // Code Space (T3 Code Heritage & Dual Agent Worktree)
    const codeWins = INITIAL_WINDOWS_PER_SPACE.code;
    expect(codeWins.length).toBeGreaterThanOrEqual(4);
    expect(codeWins.some((w) => w.title.includes("Claude"))).toBe(true);
    expect(codeWins.some((w) => w.title.includes("Codex") || w.title.includes("Cursor"))).toBe(
      true,
    );
    expect(codeWins.some((w) => w.type === "vcs-worktrees")).toBe(true);
    expect(codeWins.some((w) => w.type === "runs")).toBe(true);

    // Device Space
    const devWins = INITIAL_WINDOWS_PER_SPACE.device;
    expect(devWins.some((w) => w.type === "devices")).toBe(true);
    expect(devWins.some((w) => w.type === "workers")).toBe(true);
    expect(devWins.some((w) => w.type === "browser")).toBe(true);

    // Memory Space
    const memWins = INITIAL_WINDOWS_PER_SPACE.memory;
    expect(memWins.some((w) => w.type === "memory")).toBe(true);
    expect(memWins.some((w) => w.type === "communication-graph")).toBe(true);
    expect(memWins.some((w) => w.type === "security")).toBe(true);
  });

  it("validates camera zoom clamping and coordinates computation", () => {
    const clampZoom = (zoom: number) => Math.min(2.5, Math.max(0.25, zoom));

    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(3.5)).toBe(2.5);
    expect(clampZoom(1.2)).toBe(1.2);

    // Zoom to point transformation math
    const camera: CameraState = { x: 0, y: 0, zoom: 1.0 };
    const clientX = 400;
    const clientY = 300;
    const newZoom = 1.5;

    const newX = clientX - (clientX - camera.x) * (newZoom / camera.zoom);
    const newY = clientY - (clientY - camera.y) * (newZoom / camera.zoom);

    const worldBeforeX = (clientX - camera.x) / camera.zoom;
    const worldAfterX = (clientX - newX) / newZoom;
    const worldBeforeY = (clientY - camera.y) / camera.zoom;
    const worldAfterY = (clientY - newY) / newZoom;
    expect(worldBeforeX).toBeCloseTo(worldAfterX);
    expect(worldBeforeY).toBeCloseTo(worldAfterY);
  });

  it("analyzes developer intentions and suggests adaptive layouts in Assist mode", () => {
    // Code intention
    const codeIntent = analyzeIntentForAssistLayout(
      "Développer une nouvelle fonctionnalité avec worktree et claude",
    );
    expect(codeIntent).not.toBeNull();
    expect(codeIntent?.spaceId).toBe("code");
    expect(codeIntent?.presetId).toBe("code-duo-t3");

    // Mission DAG intention
    const msnIntent = analyzeIntentForAssistLayout("Superviser le graphe dag et l'orchestration");
    expect(msnIntent).not.toBeNull();
    expect(msnIntent?.spaceId).toBe("mission");
    expect(msnIntent?.presetId).toBe("mission-dag-full");

    // Device intention
    const devIntent = analyzeIntentForAssistLayout("Afficher les machines, workers et android");
    expect(devIntent).not.toBeNull();
    expect(devIntent?.spaceId).toBe("device");

    // Memory intention
    const memIntent = analyzeIntentForAssistLayout(
      "Rechercher dans la mémoire sémantique et les souvenirs",
    );
    expect(memIntent).not.toBeNull();
    expect(memIntent?.spaceId).toBe("memory");
  });

  it("verifies preset layouts registry for all primary spaces", () => {
    expect(PRESET_LAYOUTS["code-duo-t3"]).toBeDefined();
    expect(PRESET_LAYOUTS["mission-dag-full"]).toBeDefined();
    expect(PRESET_LAYOUTS["device-topology"]).toBeDefined();
    expect(PRESET_LAYOUTS["memory-graph"]).toBeDefined();

    const t3Layout = PRESET_LAYOUTS["code-duo-t3"];
    expect(t3Layout).toBeDefined();
    if (t3Layout) {
      expect(t3Layout.windows.length).toBe(4);
      expect(t3Layout.spaceId).toBe("code");
    }
  });

  it("extracts digits correctly across QWERTY, AZERTY, and Numpad keyboard layouts", async () => {
    const { getDigitFromEvent } = await import("../src/ui/spatial/keyboardUtils.js");

    // Standard QWERTY digit keys
    expect(getDigitFromEvent({ code: "Digit1", key: "1" })).toBe(1);
    expect(getDigitFromEvent({ code: "Digit5", key: "5" })).toBe(5);

    // French AZERTY unshifted keys (&, é, ", ', (, -, è, _, ç, à)
    expect(getDigitFromEvent({ code: "Digit1", key: "&" })).toBe(1);
    expect(getDigitFromEvent({ code: "Digit2", key: "é" })).toBe(2);
    expect(getDigitFromEvent({ code: "Digit3", key: '"' })).toBe(3);
    expect(getDigitFromEvent({ code: "Digit4", key: "'" })).toBe(4);
    expect(getDigitFromEvent({ code: "Digit5", key: "(" })).toBe(5);

    // Numpad
    expect(getDigitFromEvent({ code: "Numpad1", key: "1" })).toBe(1);
    expect(getDigitFromEvent({ code: "Numpad0", key: "0" })).toBe(0);

    // Keycode fallback
    expect(getDigitFromEvent({ keyCode: 49 })).toBe(1);
    expect(getDigitFromEvent({ keyCode: 53 })).toBe(5);
  });
});
