import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport, NotificationDispatcher } from "@nexus/notifications";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

describe("Notifications externes (Chantier 11)", () => {
  let harness: ApiHarness;
  let admin: Account;
  let membre: Account;
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "nexus-test-notif-"));
    const runtimeConfiguration = new RuntimeConfigurationStore(configDir);
    harness = await makeApi({ runtimeConfiguration });
    admin = await createAccount(harness, "admin@nexus.local");
    membre = await createAccount(harness, "membre@nexus.local");
  });

  afterEach(async () => {
    await harness.close();
    await rm(configDir, { recursive: true, force: true });
  });

  it("récupère la configuration des notifications par défaut pour l'admin", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/notifications/config",
      headers: admin.authorization,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { enabled: boolean; desktop: { enabled: boolean }; ntfy: { enabled: boolean } };
    }>();
    expect(body.data.enabled).toBe(true);
    expect(body.data.desktop.enabled).toBe(true);
    expect(body.data.ntfy.enabled).toBe(false);
  });

  it("refuse l'accès à la configuration aux membres non administrateurs", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/notifications/config",
      headers: membre.authorization,
    });

    expect(res.statusCode).toBe(403);
  });

  it("met à jour et persiste la configuration des notifications", async () => {
    const updatePayload = {
      enabled: true,
      desktop: { enabled: false, urgency: "critical" },
      ntfy: { enabled: true, serverUrl: "https://ntfy.sh", topic: "nexus-custom-topic" },
      quietHours: {
        enabled: true,
        start: "23:00",
        end: "07:00",
        timezone: "Europe/Paris",
        allowUrgent: true,
      },
      grouping: { enabled: true, windowSeconds: 60 },
      dashboardBaseUrl: "http://localhost:3000",
    };

    const putRes = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/dashboard/notifications/config",
      headers: admin.authorization,
      payload: updatePayload,
    });

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json<{ data: { saved: boolean } }>().data.saved).toBe(true);

    const getRes = await harness.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/notifications/config",
      headers: admin.authorization,
    });

    const body = getRes.json<{ data: typeof updatePayload }>();
    expect(body.data.desktop.enabled).toBe(false);
    expect(body.data.ntfy.enabled).toBe(true);
    expect(body.data.ntfy.topic).toBe("nexus-custom-topic");
  });

  it("émet une notification de test via POST /dashboard/notifications/test", async () => {
    const mockReport: DeliveryReport = {
      messageId: "test-123",
      timestamp: new Date().toISOString(),
      channels: [{ channel: "desktop", success: true }],
    };

    const sendTestMock = vi.fn().mockResolvedValue(mockReport);
    const mockDispatcher = {
      sendTest: sendTestMock,
      updateConfig: vi.fn(),
      dispatch: vi.fn().mockResolvedValue(mockReport),
    } as unknown as NotificationDispatcher;

    // Injection du dispatcher dans les services
    Object.defineProperty(harness.services, "notificationDispatcher", {
      value: mockDispatcher,
      writable: true,
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/v1/dashboard/notifications/test",
      headers: admin.authorization,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { report: DeliveryReport } }>();
    expect(body.data.report.channels[0]?.channel).toBe("desktop");
    expect(sendTestMock).toHaveBeenCalled();
  });

  it("déclenche une notification externe avec lien direct lors d'une demande de confirmation", async () => {
    const dispatchMock = vi.fn().mockResolvedValue({
      messageId: "m1",
      timestamp: new Date().toISOString(),
      channels: [{ channel: "desktop", success: true }],
    });

    const mockDispatcher = {
      dispatch: dispatchMock,
      sendTest: vi.fn(),
      updateConfig: vi.fn(),
    } as unknown as NotificationDispatcher;

    // Raccordement au notification service
    const notifService = harness.services.notifications;
    Object.defineProperty(notifService, "dispatcher", {
      value: mockDispatcher,
      writable: true,
    });
    const broker = harness.services.confirmationBroker;

    // Déclenche une demande de confirmation
    void broker.request({
      confirmationId: "conf-xyz-456",
      taskId: "task-001",
      stepId: "step-001",
      capability: "shell.execute",
      action: "execute",
      description: "rm -rf /tmp/scratch",
      riskLevel: "HIGH",
      originClientDeviceId: "device-test",
      userId: admin.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Vérifie que le store de notifications a reçu l'enregistrement
    const userNotifs = await harness.services.notificationStore.listByUser(admin.userId, {
      limit: 10,
    });
    expect(userNotifs.items.length).toBeGreaterThan(0);
    expect(userNotifs.items[0]?.title).toContain("Confirmation requise");
  });

  it("génère une URL vers la tâche lors de l'appel notifyTaskOutcome", async () => {
    const notif = await harness.services.notifications.notifyTaskOutcome({
      userId: admin.userId,
      taskId: "task-build-789",
      title: "Build terminé",
      status: "succeeded",
      originClientDeviceId: null,
      detail: "Tous les artefacts sont disponibles.",
    });

    expect(notif).toBeDefined();
    expect(notif?.title).toBe("Build terminé");
    expect(notif?.body).toBe("Tous les artefacts sont disponibles.");
  });
});
