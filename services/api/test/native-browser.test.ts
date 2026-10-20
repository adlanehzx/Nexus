import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHarnessDriver } from "@nexus/browser-client";
import { BrowserSessionManager } from "@nexus/browser-client";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

describe("Native Browser Tools & Dashboard Integration", () => {
  let harness: ApiHarness;
  let admin: Account;
  let mockDriver: BrowserHarnessDriver;
  let sessionManager: BrowserSessionManager;
  const doctorMock = vi.fn().mockResolvedValue({
    schema_version: 1,
    healthy: true,
    version: "0.1.13",
    install_mode: "pypi",
    chrome_running: true,
    daemon: { name: "default", alive: true, browser_ready: true },
  });

  beforeEach(async () => {
    doctorMock.mockClear();
    harness = await makeApi();
    admin = await createAccount(harness, "admin@nexus.test");

    mockDriver = {
      cdpUrl: "http://127.0.0.1:19222",
      doctor: doctorMock,
      createTab: vi.fn().mockResolvedValue("tab-target-1"),
      switchTab: vi.fn().mockResolvedValue(undefined),
      closeTab: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        w: 800,
        h: 600,
        sx: 0,
        sy: 0,
        pw: 800,
        ph: 600,
      }),
      screenshot: vi.fn().mockResolvedValue({ filePath: "/tmp/shot.png", format: "png" }),
      pageInfo: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        w: 800,
        h: 600,
        sx: 0,
        sy: 0,
        pw: 800,
        ph: 600,
      }),
      extract: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Domain",
        content: "Extracted markdown",
        format: "markdown",
        truncated: false,
      }),
      click: vi.fn().mockResolvedValue({
        clicked: true,
        target: "a",
        newUrl: "https://example.com/next",
        title: "Next",
      }),
      type: vi.fn().mockResolvedValue({
        typed: true,
        target: "input",
        length: 4,
      }),
      listTabs: vi.fn().mockResolvedValue([]),
    } as unknown as BrowserHarnessDriver;

    sessionManager = new BrowserSessionManager({
      driver: mockDriver,
      artifactsDirectory: "/tmp/test-browser-artifacts",
    });

    // Enregistrement des outils natifs dans le conteneur de services
    harness.services.setNativeBrowser(sessionManager);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("enregistre les 5 outils browser.* dans ToolRegistry", () => {
    const registry = harness.services.toolRegistry;
    const tools = registry.list();
    const browserToolNames = tools.map((t) => t.name).filter((n) => n.startsWith("browser."));

    expect(browserToolNames.sort()).toEqual([
      "browser.click",
      "browser.extract",
      "browser.navigate",
      "browser.screenshot",
      "browser.type",
    ]);
  });

  it("expose la santé du navigateur natif dans GET /api/v1/dashboard/browser", async () => {
    // Alloue une session active pour vérifier le décompte
    await sessionManager.getOrCreateSession("session-audit");

    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/browser",
      headers: admin.authorization,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.configured).toBe(true);
    expect(body.data.reachable).toBe(true);
    expect(body.data.detail).toContain("harness local connecté (1 session(s) active(s))");
    expect(body.data.health.chrome_running).toBe(true);
    expect(doctorMock).toHaveBeenCalled();
  });

  it("déréférence proprement les outils si le navigateur est désactivé", () => {
    const registry = harness.services.toolRegistry;
    harness.services.setNativeBrowser(undefined);

    const remaining = registry.list().filter((t) => t.name.startsWith("browser."));
    expect(remaining).toHaveLength(0);
  });
});
