import { describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../src/dispatcher.js";
import type { NotificationMessage, NotificationsConfig } from "../src/types.js";

describe("NotificationDispatcher", () => {
  const baseConfig: NotificationsConfig = {
    enabled: true,
    desktop: { enabled: false, urgency: "normal" },
    ntfy: {
      enabled: true,
      serverUrl: "https://ntfy.sh",
      topic: "nexus-test",
      tokenRef: "vault://nexus/ntfy-token",
    },
    webhook: {
      enabled: true,
      url: "https://webhook.site/test",
      format: "generic",
    },
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "08:00",
      timezone: "UTC",
      allowUrgent: true,
    },
    grouping: {
      enabled: true,
      windowSeconds: 30,
    },
    dashboardBaseUrl: "http://localhost:3000",
  };

  it("ignore tout quand le dispatcher est désactivé globalement", async () => {
    const dispatcher = new NotificationDispatcher({
      config: { ...baseConfig, enabled: false },
    });

    const report = await dispatcher.dispatch({
      id: "1",
      title: "Test",
      body: "Corps",
    });

    expect(report.channels).toHaveLength(1);
    expect(report.channels[0]?.skippedReason).toContain("désactivé globalement");
  });

  it("bloque les notifications ordinaires pendant les plages silencieuses mais laisse passer les urgentes", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const dispatcher = new NotificationDispatcher({
      config: {
        ...baseConfig,
        quietHours: {
          enabled: true,
          start: "22:00",
          end: "08:00",
          timezone: "UTC",
          allowUrgent: true,
        },
      },
      fetchFn: mockFetch,
    });

    const midnight = new Date("2026-10-20T23:30:00Z");

    // 1. Notification normale -> bloquée
    const report1 = await dispatcher.dispatch(
      {
        id: "msg-normal",
        title: "Info",
        body: "Message ordinaire",
        priority: "low",
      },
      midnight,
    );
    expect(report1.channels[0]?.skippedReason).toContain("plage silencieuse active");

    // 2. Notification urgente -> autorisée
    const report2 = await dispatcher.dispatch(
      {
        id: "msg-urgent",
        title: "Action critique requise",
        body: "Confirmation humaine requise",
        priority: "urgent",
      },
      midnight,
    );
    expect(report2.channels[0]?.success).toBe(true);
  });

  it("résout le jeton depuis le coffre et dispatche vers ntfy et webhook", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders.push(init.headers as Record<string, string>);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const resolveSecret = vi.fn().mockImplementation((ref) => {
      if (ref === "vault://nexus/ntfy-token") return Promise.resolve("secret-ntfy-key");
      return Promise.resolve(undefined);
    });

    const dispatcher = new NotificationDispatcher({
      config: baseConfig,
      resolveSecret,
      fetchFn: mockFetch,
    });

    const msg: NotificationMessage = {
      id: "dispatch-1",
      title: "Mission achevée",
      body: "Analyse terminée avec 5 citations.",
      priority: "default",
    };

    const report = await dispatcher.dispatch(msg);

    expect(report.channels).toHaveLength(2); // ntfy et webhook
    expect(report.channels.every((c) => c.success)).toBe(true);
    expect(resolveSecret).toHaveBeenCalledWith("vault://nexus/ntfy-token");
    expect(capturedHeaders.some((h) => h.Authorization === "Bearer secret-ntfy-key")).toBe(true);
  });

  it("envoie une notification de test via sendTest()", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const dispatcher = new NotificationDispatcher({
      config: baseConfig,
      fetchFn: mockFetch,
    });

    const report = await dispatcher.sendTest();
    expect(report.channels.length).toBeGreaterThanOrEqual(1);
    expect(report.channels.every((c) => c.success)).toBe(true);
  });
});
