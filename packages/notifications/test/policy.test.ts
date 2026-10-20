import { describe, expect, it } from "vitest";
import { isQuietHours, NotificationThrottler } from "../src/policy.js";
import type { QuietHoursConfig, NotificationMessage } from "../src/types.js";

describe("isQuietHours", () => {
  it("retourne toujours false quand la fonctionnalité est désactivée", () => {
    const config: QuietHoursConfig = {
      enabled: false,
      start: "22:00",
      end: "08:00",
      timezone: "UTC",
      allowUrgent: true,
    };
    const date = new Date("2026-10-20T23:30:00Z");
    expect(isQuietHours(date, config)).toBe(false);
  });

  it("gère correctement les plages de nuit franchissant minuit (22:00 à 08:00)", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "08:00",
      timezone: "UTC",
      allowUrgent: true,
    };

    // 23:30 UTC -> silencieux
    expect(isQuietHours(new Date("2026-10-20T23:30:00Z"), config)).toBe(true);

    // 04:15 UTC -> silencieux
    expect(isQuietHours(new Date("2026-10-20T04:15:00Z"), config)).toBe(true);

    // 08:00 UTC -> fin de la plage (non silencieux)
    expect(isQuietHours(new Date("2026-10-20T08:00:00Z"), config)).toBe(false);

    // 14:00 UTC -> plein jour (non silencieux)
    expect(isQuietHours(new Date("2026-10-20T14:00:00Z"), config)).toBe(false);
  });

  it("gère les plages au cours d'une même journée (01:00 à 05:00)", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "01:00",
      end: "05:00",
      timezone: "UTC",
      allowUrgent: true,
    };

    expect(isQuietHours(new Date("2026-10-20T00:30:00Z"), config)).toBe(false);
    expect(isQuietHours(new Date("2026-10-20T03:00:00Z"), config)).toBe(true);
    expect(isQuietHours(new Date("2026-10-20T05:30:00Z"), config)).toBe(false);
  });
});

describe("NotificationThrottler", () => {
  it("autorise immédiatement les notifications sans groupKey", () => {
    const throttler = new NotificationThrottler();
    const msg: NotificationMessage = {
      id: "1",
      title: "Titre",
      body: "Corps",
    };

    const res1 = throttler.evaluate(msg, 30, 1000);
    expect(res1.shouldSend).toBe(true);

    const res2 = throttler.evaluate(msg, 30, 2000);
    expect(res2.shouldSend).toBe(true);
  });

  it("agrège et filtre les notifications rapprochées sous la même clé", () => {
    const throttler = new NotificationThrottler();
    const msg: NotificationMessage = {
      id: "1",
      title: "Erreur tâche",
      body: "Échec 1",
      groupKey: "task-123-error",
    };

    // 1er appel à t=0 : envoyé
    const res1 = throttler.evaluate(msg, 30, 10_000);
    expect(res1.shouldSend).toBe(true);
    expect(res1.suppressedCount).toBe(0);

    // 2e appel à t=5s : filtré
    const res2 = throttler.evaluate(msg, 30, 15_000);
    expect(res2.shouldSend).toBe(false);
    expect(res2.suppressedCount).toBe(2);

    // 3e appel à t=10s : filtré
    const res3 = throttler.evaluate(msg, 30, 20_000);
    expect(res3.shouldSend).toBe(false);
    expect(res3.suppressedCount).toBe(3);

    // 4e appel à t=45s (> 30s après t=0) : envoyé avec le décompte des messages supprimés
    const res4 = throttler.evaluate(msg, 30, 45_000);
    expect(res4.shouldSend).toBe(true);
    expect(res4.suppressedCount).toBe(2);
  });
});
