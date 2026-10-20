import type { QuietHoursConfig, NotificationMessage } from "./types.js";

/**
 * Détermine si une date donnée se situe dans la plage silencieuse configurée.
 *
 * Gère correctement :
 * 1. La conversion d'horodatage selon le fuseau horaire spécifié (ex: Europe/Paris).
 * 2. Le chevauchement de minuit (ex: début 22:00, fin 08:00 le lendemain).
 * 3. Les plages diurnes intra-journalières (ex: 13:00 à 14:00).
 */
export function isQuietHours(now: Date, config: QuietHoursConfig): boolean {
  if (!config.enabled) {
    return false;
  }

  // Extraction de l'heure et des minutes dans le fuseau demandé
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
    // Plage au cours de la même journée (ex: 01:00 à 06:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Plage chevauchant minuit (ex: 22:00 à 08:00)
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
 * Régulateur de flux anti-inondation pour notifications regroupées.
 *
 * Si plusieurs notifications arrivent rapidement avec le même `groupKey`
 * dans la fenêtre temporelle spécifiée, seule la première est transmise immédiatement,
 * évitant de submerger l'utilisateur de vibrations ou de bannières desktop.
 */
export class NotificationThrottler {
  readonly #history = new Map<string, GroupEntry>();

  /**
   * Évalue si la notification doit être envoyée ou filtrée par regroupement.
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
   * Nettoie les entrées expirées pour libérer la mémoire.
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
