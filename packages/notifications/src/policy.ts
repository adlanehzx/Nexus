import type { QuietHoursConfig, NotificationMessage } from "./types.js";

/**
 * Determines whether a given timestamp falls within configured quiet hours.
 *
 * Handles:
 * 1. Timestamp conversion matching specified timezone (e.g. Europe/Paris).
 * 2. Midnight crossover ranges (e.g. start 22:00, end 08:00 next morning).
 * 3. Intra-day diurnal ranges (e.g. 13:00 to 14:00).
 */
export function isQuietHours(now: Date, config: QuietHoursConfig): boolean {
  if (!config.enabled) {
    return false;
  }

  // Extract hour and minute components in requested timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minutePart = parts.find((p) => p.type === "minute")?.value ?? "00";

  const currentMinutes = Number.parseInt(hourPart, 10) * 60 + Number.parseInt(minutePart, 10);

  const [startHour, startMinute] = config.start.split(":").map(Number);
  const [endHour, endMinute] = config.end.split(":").map(Number);

  const startMinutes = (startHour ?? 0) * 60 + (startMinute ?? 0);
  const endMinutes = (endHour ?? 0) * 60 + (endMinute ?? 0);

  if (startMinutes <= endMinutes) {
    // Single-day interval (e.g. 01:00 to 06:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Midnight-spanning interval (e.g. 22:00 to 08:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

interface GroupEntry {
  lastSentAt: number;
  count: number;
}

export interface ThrottleResult {
  shouldSend: boolean;
  suppressedCount: number;
}

/**
 * Rate-limiting and anti-flood regulator for grouped notifications.
 *
 * If multiple notifications arrive rapidly sharing the same `groupKey`
 * within the specified time window, only the first is delivered immediately,
 * preventing notification storms.
 */
export class NotificationThrottler {
  readonly #history = new Map<string, GroupEntry>();

  /**
   * Evaluates whether notification should be dispatched or throttled.
   */
  evaluate(message: NotificationMessage, windowSeconds: number, now = Date.now()): ThrottleResult {
    const key = message.groupKey;
    if (!key) {
      return { shouldSend: true, suppressedCount: 0 };
    }

    const windowMs = windowSeconds * 1000;
    const existing = this.#history.get(key);

    if (!existing || now - existing.lastSentAt >= windowMs) {
      const suppressed = existing ? existing.count - 1 : 0;
      this.#history.set(key, { lastSentAt: now, count: 1 });
      return { shouldSend: true, suppressedCount: Math.max(0, suppressed) };
    }

    existing.count += 1;
    return { shouldSend: false, suppressedCount: existing.count };
  }

  /**
   * Purges expired entries to release memory.
   */
  cleanup(now = Date.now(), maxAgeMs = 3600_000): void {
    for (const [key, entry] of this.#history.entries()) {
      if (now - entry.lastSentAt > maxAgeMs) {
        this.#history.delete(key);
      }
    }
  }

  clear(): void {
    this.#history.clear();
  }
}
