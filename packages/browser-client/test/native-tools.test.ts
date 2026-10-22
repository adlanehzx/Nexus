import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserHarnessDriver } from "../src/index.js";
import {
  BrowserSecurityPolicy,
  BrowserSecurityError,
  HumanInterventionRequiredError,
  BrowserSessionManager,
  QuotaExceededError,
  createNativeBrowserTools,
} from "../src/index.js";
import type { ToolContext } from "@nexus/tools";

describe("BrowserSecurityPolicy", () => {
  it("allows public HTTP and HTTPS URLs", () => {
    const policy = new BrowserSecurityPolicy();
    expect(policy.assertUrlSafe("https://example.com").toString()).toBe("https://example.com/");
    expect(policy.assertUrlSafe("http://sub.domain.org/path?q=1").toString()).toBe(
      "http://sub.domain.org/path?q=1",
    );
  });

  it("strictly rejects unauthorized and dangerous protocols", () => {
    const policy = new BrowserSecurityPolicy();
    expect(() => policy.assertUrlSafe("file:///etc/passwd")).toThrowError(BrowserSecurityError);
    expect(() => policy.assertUrlSafe("chrome://inspect")).toThrowError(BrowserSecurityError);
    expect(() => policy.assertUrlSafe("javascript:alert(1)")).toThrowError(BrowserSecurityError);
    expect(() => policy.assertUrlSafe("data:text/html,test")).toThrowError(BrowserSecurityError);
  });

  it("blocks SSRF and private addresses by default", () => {
    const policy = new BrowserSecurityPolicy({ allowLocalhost: false });
    expect(() => policy.assertUrlSafe("http://127.0.0.1:8080")).toThrowError(BrowserSecurityError);
    expect(() => policy.assertUrlSafe("http://localhost:3000")).toThrowError(BrowserSecurityError);
    expect(() => policy.assertUrlSafe("http://169.254.169.254/latest/meta-data")).toThrowError(
      BrowserSecurityError,
    );
    expect(() => policy.assertUrlSafe("http://192.168.1.50")).toThrowError(BrowserSecurityError);
    expect(() => policy.assertUrlSafe("http://10.0.0.1")).toThrowError(BrowserSecurityError);
  });

  it("allows localhost when local/test mode is explicitly enabled", () => {
    const policy = new BrowserSecurityPolicy({ allowLocalhost: true });
    expect(policy.assertUrlSafe("http://127.0.0.1:8080").toString()).toBe("http://127.0.0.1:8080/");
  });

  it("prohibits downloading potentially dangerous executable files", () => {
    const policy = new BrowserSecurityPolicy();
    expect(() => policy.assertUrlSafe("https://example.com/installer.exe")).toThrowError(
      BrowserSecurityError,
    );
    expect(() => policy.assertUrlSafe("https://example.com/script.sh")).toThrowError(
      BrowserSecurityError,
    );
    expect(() => policy.assertUrlSafe("https://example.com/app.apk")).toThrowError(
      BrowserSecurityError,
    );
    expect(() => policy.assertUrlSafe("https://example.com/payload.bin")).toThrowError(
      BrowserSecurityError,
    );
  });

  it("detects pages requiring human intervention (CAPTCHA / MFA)", () => {
    const policy = new BrowserSecurityPolicy();
    const pageWithCaptcha = {
      url: "https://example.com/login",
      title: "Cloudflare Challenge | Verify you are human",
      w: 800,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 800,
      ph: 600,
    };
    const res = policy.detectHumanIntervention(pageWithCaptcha);
    expect(res.required).toBe(true);
    expect(res.reason).toContain("human verification");
  });
});

describe("BrowserSessionManager & Quotas", () => {
  let mockDriver: BrowserHarnessDriver;
  const createTabMock = vi.fn().mockResolvedValue("tab-123");
  const switchTabMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    createTabMock.mockClear();
    switchTabMock.mockClear();
    mockDriver = {
      createTab: createTabMock,
      switchTab: switchTabMock,
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
      extract: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      listTabs: vi.fn().mockResolvedValue([]),
      doctor: vi.fn(),
      cdpUrl: "http://127.0.0.1:19222",
    } as unknown as BrowserHarnessDriver;
  });

  it("allocates a new tab for a new session and reuses it", async () => {
    const manager = new BrowserSessionManager({
      driver: mockDriver,
      artifactsDirectory: "/tmp/nexus-test-artifacts",
    });

    const s1 = await manager.getOrCreateSession("session-A");
    expect(s1.targetId).toBe("tab-123");
    expect(createTabMock).toHaveBeenCalledTimes(1);

    // Reuse
    const s1Again = await manager.getOrCreateSession("session-A");
    expect(s1Again.targetId).toBe("tab-123");
    expect(switchTabMock).toHaveBeenCalledWith("tab-123");
    expect(createTabMock).toHaveBeenCalledTimes(1);
  });

  it("blocks session as soon as action quota is exceeded", async () => {
    const manager = new BrowserSessionManager({
      driver: mockDriver,
      defaultMaxActions: 3,
    });

    await manager.getOrCreateSession("mission-1");
    manager.recordAction("mission-1"); // 1
    manager.recordAction("mission-1"); // 2
    manager.recordAction("mission-1"); // 3

    expect(() => manager.recordAction("mission-1")).toThrowError(QuotaExceededError);
  });

  it("handles suspended state for human intervention", async () => {
    const manager = new BrowserSessionManager({ driver: mockDriver });
    await manager.getOrCreateSession("mission-2");

    manager.suspendForHumanIntervention(
      "mission-2",
      "Cloudflare Turnstile",
      "https://protected.test",
    );
    const session = manager.getSession("mission-2");
    expect(session?.waitingForHuman?.reason).toBe("Cloudflare Turnstile");

    manager.resumeAfterHumanIntervention("mission-2");
    expect(manager.getSession("mission-2")?.waitingForHuman).toBeUndefined();
  });
});

describe("createNativeBrowserTools", () => {
  let mockDriver: BrowserHarnessDriver;
  let manager: BrowserSessionManager;
  let mockContext: ToolContext;

  const navigateMock = vi.fn().mockResolvedValue({
    url: "https://example.com",
    title: "Example Domain",
    w: 800,
    h: 600,
    sx: 0,
    sy: 0,
    pw: 800,
    ph: 600,
  });
  const extractMock = vi.fn().mockResolvedValue({
    url: "https://example.com",
    title: "Example Domain",
    content: "Welcome to Example Domain",
    format: "markdown",
    truncated: false,
  });
  const typeMock = vi.fn().mockResolvedValue({
    typed: true,
    target: "input#q",
    length: 5,
  });

  beforeEach(() => {
    navigateMock.mockClear();
    extractMock.mockClear();
    typeMock.mockClear();

    mockDriver = {
      createTab: vi.fn().mockResolvedValue("tab-abc"),
      switchTab: vi.fn().mockResolvedValue(undefined),
      closeTab: vi.fn().mockResolvedValue(undefined),
      navigate: navigateMock,
      screenshot: vi.fn().mockResolvedValue({ filePath: "/tmp/fake-shot.png", format: "png" }),
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
      extract: extractMock,
      click: vi.fn().mockResolvedValue({
        clicked: true,
        target: "a.more-info",
        newUrl: "https://iana.org",
        title: "IANA",
      }),
      type: typeMock,
      listTabs: vi.fn().mockResolvedValue([]),
      doctor: vi.fn(),
      cdpUrl: "http://127.0.0.1:19222",
    } as unknown as BrowserHarnessDriver;

    manager = new BrowserSessionManager({
      driver: mockDriver,
      artifactsDirectory: "/tmp/nexus-test-artifacts",
    });

    // Mock saveScreenshotArtifact to avoid writing to disk in this test
    vi.spyOn(manager, "saveScreenshotArtifact").mockResolvedValue({
      id: "art-12345",
      sessionId: "run-test",
      type: "screenshot",
      filePath: "/tmp/art.png",
      fileName: "shot.png",
      createdAt: new Date().toISOString(),
      url: "https://example.com",
      title: "Example Domain",
    });

    mockContext = {
      runId: "run-test",
      userId: "user-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      signal: new AbortController().signal,
      idempotencyKey: "idem-1",
      attempt: 1,
      onProgress: vi.fn(),
    };
  });

  it("provides all 5 native tools with correct permissions and risk levels", () => {
    const tools = createNativeBrowserTools({ sessionManager: manager });
    expect(tools.map((t) => t.name)).toEqual([
      "browser.navigate",
      "browser.extract",
      "browser.click",
      "browser.type",
      "browser.screenshot",
    ]);

    const navigate = tools.find((t) => t.name === "browser.navigate")!;
    expect(navigate.riskLevel).toBe("SAFE");
    expect(navigate.requiredPermissions).toEqual(["browser.navigate"]);

    const click = tools.find((t) => t.name === "browser.click")!;
    expect(click.riskLevel).toBe("MEDIUM");
    expect(click.requiredPermissions).toEqual(["browser.interact"]);
  });

  it("executes browser.navigate successfully", async () => {
    const tools = createNativeBrowserTools({ sessionManager: manager });
    const navigate = tools.find((t) => t.name === "browser.navigate")!;

    const res = await navigate.execute({ url: "https://example.com" }, mockContext);
    expect(res).toEqual({
      url: "https://example.com",
      title: "Example Domain",
      status: "loaded",
      screenshotArtifactId: "art-12345",
    });
    expect(navigateMock).toHaveBeenCalledWith("https://example.com");
  });

  it("intercepts insecure URLs in browser.navigate", async () => {
    const tools = createNativeBrowserTools({ sessionManager: manager });
    const navigate = tools.find((t) => t.name === "browser.navigate")!;

    await expect(navigate.execute({ url: "file:///etc/shadow" }, mockContext)).rejects.toThrowError(
      BrowserSecurityError,
    );
  });

  it("executes browser.extract in read-only mode", async () => {
    const tools = createNativeBrowserTools({ sessionManager: manager });
    const extract = tools.find((t) => t.name === "browser.extract")!;

    const res = await extract.execute({ format: "markdown", maxCharacters: 5000 }, mockContext);
    expect(res).toEqual({
      url: "https://example.com",
      title: "Example Domain",
      content: "Welcome to Example Domain",
      format: "markdown",
      truncated: false,
    });
    expect(extractMock).toHaveBeenCalledWith({
      selector: undefined,
      format: "markdown",
      maxChars: 5000,
    });
  });

  it("executes browser.click and browser.type", async () => {
    const tools = createNativeBrowserTools({ sessionManager: manager });
    const click = tools.find((t) => t.name === "browser.click")!;
    const type = tools.find((t) => t.name === "browser.type")!;

    const clickRes = await click.execute({ target: "a.more-info", waitLoad: true }, mockContext);
    expect(clickRes).toEqual({
      clicked: true,
      target: "a.more-info",
      newUrl: "https://iana.org",
      title: "IANA",
      screenshotArtifactId: "art-12345",
    });

    const typeRes = await type.execute(
      { target: "input#q", text: "nexus agent", submit: true, clear: true },
      mockContext,
    );
    expect(typeRes).toEqual({
      typed: true,
      target: "input#q",
      length: 5,
    });
    expect(typeMock).toHaveBeenCalledWith("input#q", "nexus agent", {
      submit: true,
      clear: true,
    });
  });

  it("throws HumanInterventionRequiredError if a CAPTCHA challenge is detected", async () => {
    const tools = createNativeBrowserTools({ sessionManager: manager });
    const navigate = tools.find((t) => t.name === "browser.navigate")!;

    vi.spyOn(mockDriver, "navigate").mockResolvedValueOnce({
      url: "https://cloudflare.com/challenge",
      title: "Just a moment... Cloudflare Challenge",
      w: 800,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 800,
      ph: 600,
    });

    await expect(
      navigate.execute({ url: "https://cloudflare.com/challenge" }, mockContext),
    ).rejects.toThrowError(HumanInterventionRequiredError);
  });
});
