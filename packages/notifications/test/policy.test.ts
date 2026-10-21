import { describe, expect, it } from "vitest";
import { isQuietHours, NotificationThrottler } from "../src/policy.js";
import type { QuietHoursConfig, NotificationMessage } from "../src/types.js";

describe("isQuietHours", () => {
  it("always returns false when feature is disabled", () => {
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

  it("correctly handles nighttime ranges crossing midnight (22:00 to 08:00)", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "08:00",
      timezone: "UTC",
      allowUrgent: true,
    };

    // 23:30 UTC -> quiet
    expect(isQuietHours(new Date("2026-10-20T23:30:00Z"), config)).toBe(true);

    // 04:15 UTC -> quiet
    expect(isQuietHours(new Date("2026-10-20T04:15:00Z"), config)).toBe(true);

    // 08:00 UTC -> end of range (not quiet)
    expect(isQuietHours(new Date("2026-10-20T08:00:00Z"), config)).toBe(false);

    // 14:00 UTC -> daytime (not quiet)
    expect(isQuietHours(new Date("2026-10-20T14:00:00Z"), config)).toBe(false);
  });

  it("handles ranges within the same day (01:00 to 05:00)", () => {
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
  it("immediately allows notifications without groupKey", () => {
    const throttler = new NotificationThrottler();
    const msg: NotificationMessage = {
      id: "1",
      title: "Title",
      body: "Body",
    };

    const res1 = throttler.evaluate(msg, 30, 1000);
    expect(res1.shouldSend).toBe(true);

    const res2 = throttler.evaluate(msg, 30, 2000);
    expect(res2.shouldSend).toBe(true);
  });

  it("aggregates and throttles closely-spaced notifications sharing same groupKey", () => {
    const throttler = new NotificationThrottler();
    const msg: NotificationMessage = {
      id: "1",
      title: "Task error",
      body: "Failure 1",
      groupKey: "task-123-error",
    };

    // 1st call at t=0: sent
    const res1 = throttler.evaluate(msg, 30, 10_000);
    expect(res1.shouldSend).toBe(true);
    expect(res1.suppressedCount).toBe(0);

    // 2nd call at t=5s: throttled
    const res2 = throttler.evaluate(msg, 30, 15_000);
    expect(res2.shouldSend).toBe(false);
    expect(res2.suppressedCount).toBe(2);

    // 3rd call at t=10s: throttled
    const res3 = throttler.evaluate(msg, 30, 20_000);
    expect(res3.shouldSend).toBe(false);
    expect(res3.suppressedCount).toBe(3);

    // 4th call at t=45s (> 30s after t=0): sent with count of suppressed messages
    const res4 = throttler.evaluate(msg, 30, 45_000);
    expect(res4.shouldSend).toBe(true);
    expect(res4.suppressedCount).toBe(2);
  });
});
