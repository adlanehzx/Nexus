import { describe, expect, it, vi } from "vitest";
import { DesktopChannel } from "../src/channels/desktop.js";
import { NtfyChannel } from "../src/channels/ntfy.js";
import { WebhookChannel } from "../src/channels/webhook.js";
import type { NotificationMessage } from "../src/types.js";

describe("DesktopChannel", () => {
  it("respecte l'état désactivé", async () => {
    const channel = new DesktopChannel({ config: { enabled: false, urgency: "normal" } });
    const res = await channel.send({ id: "1", title: "Test", body: "Corps" });
    expect(res.success).toBe(false);
    expect(res.skippedReason).toContain("désactivé");
  });

  it("gère gracieusement l'absence de notify-send", async () => {
    const channel = new DesktopChannel({
      config: { enabled: true, urgency: "normal" },
      executablePath: "/non/existent/notify-send",
    });
    const res = await channel.send({ id: "1", title: "Test", body: "Corps" });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });
});

describe("NtfyChannel", () => {
  it("envoie une requête HTTP POST avec les bons en-têtes et priorité", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetch = vi.fn().mockImplementation((url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = String(init.body);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const channel = new NtfyChannel({
      config: {
        enabled: true,
        serverUrl: "https://ntfy.sh",
        topic: "nexus-test-topic",
      },
      token: "secret-token",
      fetchFn: mockFetch,
    });

    const msg: NotificationMessage = {
      id: "ntfy-1",
      title: "Confirmation requise",
      body: "L'agent Codex demande validation pour bash.",
      priority: "urgent",
      url: "http://localhost:3000/dashboard/confirmations/123",
      actionTitle: "Valider",
      tags: ["tool", "security"],
    };

    const res = await channel.send(msg);

    expect(res.success).toBe(true);
    expect(capturedUrl).toBe("https://ntfy.sh/nexus-test-topic");
    expect(capturedHeaders.Title).toBe("Confirmation requise");
    expect(capturedHeaders.Priority).toBe("5");
    expect(capturedHeaders.Authorization).toBe("Bearer secret-token");
    expect(capturedHeaders.Click).toBe("http://localhost:3000/dashboard/confirmations/123");
    expect(capturedHeaders.Actions).toBe(
      "view, Valider, http://localhost:3000/dashboard/confirmations/123",
    );
    expect(capturedHeaders.Tags).toContain("nexus,tool,security,warning");
    expect(capturedBody).toContain("L'agent Codex");
  });

  it("gère les erreurs HTTP reçues de ntfy", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const channel = new NtfyChannel({
      config: { enabled: true, serverUrl: "https://ntfy.sh", topic: "private" },
      fetchFn: mockFetch,
    });

    const res = await channel.send({ id: "1", title: "Test", body: "Body" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("401");
  });
});

describe("WebhookChannel", () => {
  it("formate correctement les embeds Discord", async () => {
    let capturedPayload: Record<string, unknown> = {};

    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      capturedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const channel = new WebhookChannel({
      config: {
        enabled: true,
        url: "https://discord.com/api/webhooks/123/xyz",
        format: "discord",
      },
      fetchFn: mockFetch,
    });

    const res = await channel.send({
      id: "d1",
      title: "Tâche échouée",
      body: "Timeout sur la compilation",
      priority: "high",
      url: "http://localhost:3000/tasks/1",
    });

    expect(res.success).toBe(true);
    const embeds = capturedPayload.embeds as Record<string, unknown>[];
    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.title).toBe("Tâche échouée");
    expect(embeds[0]?.color).toBe(0xe74c3c); // Rouge pour high
    expect(embeds[0]?.url).toBe("http://localhost:3000/tasks/1");
  });

  it("formate correctement les messages Telegram HTML", async () => {
    let capturedPayload: Record<string, unknown> = {};

    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      capturedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const channel = new WebhookChannel({
      config: {
        enabled: true,
        url: "https://api.telegram.org/bot123/sendMessage",
        format: "telegram",
      },
      fetchFn: mockFetch,
    });

    const res = await channel.send({
      id: "t1",
      title: "Alerte <Sécurité>",
      body: "Contenu avec & caractères",
      url: "http://localhost:3000/check",
      actionTitle: "Voir",
    });

    expect(res.success).toBe(true);
    expect(capturedPayload.parse_mode).toBe("HTML");
    const text = capturedPayload.text as string;
    expect(text).toContain("<b>Alerte &lt;Sécurité&gt;</b>");
    expect(text).toContain("Contenu avec &amp; caractères");
    expect(text).toContain('<a href="http://localhost:3000/check">Voir</a>');
  });
});
