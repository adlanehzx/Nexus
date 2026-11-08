import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { DashboardApi, createSession, type ProviderAccountDto } from "../src/lib/api.js";
import {
  IconPause,
  IconPlay,
  IconPower,
  IconSnowflake,
  IconStop,
  IconCheck,
  IconWarning,
} from "../src/ui/icons.js";

const mockAccount: ProviderAccountDto = {
  id: "claude-dev-1",
  provider: "claude",
  name: "Claude 3.5 Sonnet Main",
  profileKey: "claude-primary",
  priority: 1,
  enabled: true,
  sessionDir: "/tmp/session-dir",
  env: {},
  authStatus: "authenticated",
  lastCheckedAt: null,
  cooldown: {
    active: false,
    until: null,
    reason: null,
  },
  quotas: {
    remaining5hPercent: 85,
    remainingWeekPercent: 90,
    resets5hAt: null,
    resetsWeekAt: null,
    exhausted: false,
  },
  reliability: {
    score: 0.98,
    totalRuns: 120,
    successCount: 118,
    failureCount: 2,
    consecutiveFailures: 0,
    lastErrorCategory: null,
    lastErrorAt: null,
  },
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Lot 6.2: Per-Agent Pause & Emergency Stop Controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("DashboardApi Account Control Endpoints", () => {
    it("calls POST /api/v1/orchestrator/accounts/:id/enable with correct path and returns updated account", async () => {
      let requestedUrl = "";
      let requestedMethod = "";

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
          const parsed = new URL(String(url));
          if (parsed.pathname === "/api/v1/auth/login") {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    user: { id: "u-1", email: "admin@nexus.test", role: "ADMIN" },
                    tokens: { accessToken: "tok-abc", refreshToken: "tok-ref" },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          if (parsed.pathname === "/api/v1/orchestrator/accounts/claude-dev-1/enable") {
            requestedUrl = parsed.pathname;
            requestedMethod = init?.method ?? "GET";
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    ...mockAccount,
                    enabled: true,
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          return Promise.reject(new Error(`Unexpected route: ${parsed.pathname}`));
        }),
      );

      const session = createSession("http://localhost:3000");
      await session.login("admin@nexus.test", "Password123!");
      const api = new DashboardApi(session);

      const result = await api.enableProviderAccount("claude-dev-1");
      expect(requestedUrl).toBe("/api/v1/orchestrator/accounts/claude-dev-1/enable");
      expect(requestedMethod).toBe("POST");
      expect(result.id).toBe("claude-dev-1");
      expect(result.enabled).toBe(true);
    });

    it("calls POST /api/v1/orchestrator/accounts/:id/disable with correct path and returns updated account", async () => {
      let requestedUrl = "";
      let requestedMethod = "";

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
          const parsed = new URL(String(url));
          if (parsed.pathname === "/api/v1/auth/login") {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    user: { id: "u-1", email: "admin@nexus.test", role: "ADMIN" },
                    tokens: { accessToken: "tok-abc", refreshToken: "tok-ref" },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          if (parsed.pathname === "/api/v1/orchestrator/accounts/claude-dev-1/disable") {
            requestedUrl = parsed.pathname;
            requestedMethod = init?.method ?? "GET";
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    ...mockAccount,
                    enabled: false,
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          return Promise.reject(new Error(`Unexpected route: ${parsed.pathname}`));
        }),
      );

      const session = createSession("http://localhost:3000");
      await session.login("admin@nexus.test", "Password123!");
      const api = new DashboardApi(session);

      const result = await api.disableProviderAccount("claude-dev-1");
      expect(requestedUrl).toBe("/api/v1/orchestrator/accounts/claude-dev-1/disable");
      expect(requestedMethod).toBe("POST");
      expect(result.id).toBe("claude-dev-1");
      expect(result.enabled).toBe(false);
    });

    it("encodes special characters in account ID for enable and disable endpoints", async () => {
      const requestedUrls: string[] = [];

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string | URL) => {
          const parsed = new URL(String(url));
          if (parsed.pathname === "/api/v1/auth/login") {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    user: { id: "u-1", email: "admin@nexus.test", role: "ADMIN" },
                    tokens: { accessToken: "tok-abc", refreshToken: "tok-ref" },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          requestedUrls.push(parsed.pathname);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: { ...mockAccount, id: "acc%2Fsub%201" },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }),
      );

      const session = createSession("http://localhost:3000");
      await session.login("admin@nexus.test", "Password123!");
      const api = new DashboardApi(session);

      await api.enableProviderAccount("acc/sub 1");
      await api.disableProviderAccount("acc/sub 1");

      expect(requestedUrls[0]).toBe("/api/v1/orchestrator/accounts/acc%2Fsub%201/enable");
      expect(requestedUrls[1]).toBe("/api/v1/orchestrator/accounts/acc%2Fsub%201/disable");
    });

    it("sends emergency cooldown payload via toggleProviderAccountCooldown", async () => {
      let capturedBody: unknown = null;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
          const parsed = new URL(String(url));
          if (parsed.pathname === "/api/v1/auth/login") {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    user: { id: "u-1", email: "admin@nexus.test", role: "ADMIN" },
                    tokens: { accessToken: "tok-abc", refreshToken: "tok-ref" },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          if (parsed.pathname === "/api/v1/orchestrator/accounts/claude-dev-1/cooldown") {
            capturedBody = JSON.parse(init?.body as string);
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    ...mockAccount,
                    cooldown: {
                      active: true,
                      until: new Date(Date.now() + 86400000).toISOString(),
                      reason: "Emergency Stop: Kill switch activated by operator",
                    },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          return Promise.reject(new Error(`Unexpected route: ${parsed.pathname}`));
        }),
      );

      const session = createSession("http://localhost:3000");
      await session.login("admin@nexus.test", "Password123!");
      const api = new DashboardApi(session);

      const result = await api.toggleProviderAccountCooldown(
        "claude-dev-1",
        true,
        86400,
        "Emergency Stop: Kill switch activated by operator",
      );

      expect(capturedBody).toEqual({
        active: true,
        durationSeconds: 86400,
        reason: "Emergency Stop: Kill switch activated by operator",
      });
      expect(result.cooldown.active).toBe(true);
      expect(result.cooldown.reason).toContain("Emergency Stop");
    });
  });

  describe("Pure Vector SVG Icons", () => {
    it("renders IconPause as a pure SVG element without emojis", () => {
      const markup = renderToStaticMarkup(React.createElement(IconPause, { size: 18 }));
      expect(markup).toContain("<svg");
      expect(markup).toContain('class="cyber-svg-icon"');
      expect(markup).toContain('width="18"');
      expect(markup).toContain("<rect");
      expect(markup).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it("renders IconPlay as a pure SVG element without emojis", () => {
      const markup = renderToStaticMarkup(React.createElement(IconPlay, { size: 16 }));
      expect(markup).toContain("<svg");
      expect(markup).toContain('class="cyber-svg-icon"');
      expect(markup).toContain("<polygon");
      expect(markup).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it("renders IconPower as a pure SVG element without emojis", () => {
      const markup = renderToStaticMarkup(
        React.createElement(IconPower, { size: 14, color: "#ef4444" }),
      );
      expect(markup).toContain("<svg");
      expect(markup).toContain('stroke="#ef4444"');
      expect(markup).toContain("<line");
      expect(markup).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it("renders IconSnowflake as a pure SVG element without emojis", () => {
      const markup = renderToStaticMarkup(React.createElement(IconSnowflake, { size: 20 }));
      expect(markup).toContain("<svg");
      expect(markup).toContain("<line");
      expect(markup).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it("renders IconStop, IconCheck, and IconWarning as pure SVG elements", () => {
      for (const Icon of [IconStop, IconCheck, IconWarning]) {
        const markup = renderToStaticMarkup(React.createElement(Icon, { size: 16 }));
        expect(markup).toContain("<svg");
        expect(markup).toContain('class="cyber-svg-icon"');
        expect(markup).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
      }
    });
  });

  describe("Strict Zero Unicode Emojis Contract", () => {
    it("ensures providers.tsx contains zero Unicode emojis", () => {
      const providersPath = resolve(__dirname, "../src/ui/sections/providers.tsx");
      const content = readFileSync(providersPath, "utf8");

      const emojiRegex =
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA70}-\u{1FAFF}]/u;

      const matches = content.match(new RegExp(emojiRegex, "gu"));
      expect(matches).toBeNull();
    });

    it("ensures icons.tsx contains zero Unicode emojis", () => {
      const iconsPath = resolve(__dirname, "../src/ui/icons.tsx");
      const content = readFileSync(iconsPath, "utf8");

      const emojiRegex =
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA70}-\u{1FAFF}]/u;

      const matches = content.match(new RegExp(emojiRegex, "gu"));
      expect(matches).toBeNull();
    });
  });

  describe("Providers Section Contract Checks", () => {
    const providersPath = resolve(__dirname, "../src/ui/sections/providers.tsx");
    const content = readFileSync(providersPath, "utf8");

    it("declares the Per-Agent Controls & Emergency Stop panel", () => {
      expect(content).toContain('data-testid="agent-emergency-controls-panel"');
      expect(content).toContain("Per-Agent Controls & Emergency Stop");
    });

    it("includes per-agent enable and disable toggle capabilities", () => {
      expect(content).toContain("api.enableProviderAccount");
      expect(content).toContain("api.disableProviderAccount");
      expect(content).toContain("agent-toggle-enable-");
    });

    it("includes per-agent emergency stop (kill switch) and reset controls", () => {
      expect(content).toContain("agent-emergency-kill-");
      expect(content).toContain("agent-reset-emergency-");
      expect(content).toContain("Emergency Stop: Kill switch activated by operator");
    });

    it("includes global emergency stop (kill all agents) control", () => {
      expect(content).toContain('data-testid="global-kill-switch-btn"');
      expect(content).toContain("handleEmergencyKillAll");
    });

    it("includes per-agent cooldown management controls and panel", () => {
      expect(content).toContain("agent-clear-cooldown-");
      expect(content).toContain("agent-cooldown-options-");
      expect(content).toContain("agent-cooldown-panel-");
      expect(content).toContain("api.toggleProviderAccountCooldown");
    });

    it("renders visual status badges with custom pure SVG icons and data attributes", () => {
      expect(content).toContain('data-status="enabled"');
      expect(content).toContain('data-status="disabled"');
      expect(content).toContain('data-status="emergency-stop"');
      expect(content).toContain('data-status="cooldown-active"');
      expect(content).toContain('data-status="no-cooldown"');
      expect(content).toContain("agent-status-badges-");
    });
  });

  describe("API Wiring Allowlist Integrity", () => {
    it("verifies enable and disable routes have been removed from docs/api-wiring-allowlist.json", () => {
      const allowlistPath = resolve(__dirname, "../../../docs/api-wiring-allowlist.json");
      const allowlistContent = readFileSync(allowlistPath, "utf8");
      const allowlist = JSON.parse(allowlistContent) as { route: string; reason: string }[];

      const enableEntry = allowlist.find((e) =>
        e.route.includes("/api/v1/orchestrator/accounts/:p/enable"),
      );
      const disableEntry = allowlist.find((e) =>
        e.route.includes("/api/v1/orchestrator/accounts/:p/disable"),
      );

      expect(enableEntry).toBeUndefined();
      expect(disableEntry).toBeUndefined();
    });
  });
});
