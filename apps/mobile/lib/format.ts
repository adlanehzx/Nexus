/** Display helpers shared by the screens. */

export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return "never";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "unknown";

  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 0) return formatFuture(-minutes);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
}

function formatFuture(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 1_440) return `in ${Math.round(minutes / 60)}h`;
  return `in ${Math.round(minutes / 1_440)}d`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function formatMegabytes(mb: number | null): string {
  if (mb === null) return "—";
  return mb >= 1_024 ? `${(mb / 1_024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export type Tone = "ok" | "live" | "warn" | "bad" | "muted";

/** Maps the many status vocabularies of the core onto what a badge can show. */
export function statusTone(status: string): Tone {
  switch (status.toLowerCase()) {
    case "online":
    case "ok":
    case "ready":
    case "connected":
    case "available":
    case "authenticated":
    case "trusted":
    case "succeeded":
    case "completed":
    case "active":
      return "ok";
    case "running":
    case "pending":
    case "queued":
    case "claimed":
    case "submitted":
    case "connecting":
      return "live";
    case "degraded":
    case "partial":
    case "paused":
    case "cooldown":
    case "waiting_for_confirmation":
    case "waiting_market_data":
    case "unconfigured":
    case "auth_required":
    case "authentication_required":
    case "expired":
    case "unauthenticated":
      return "warn";
    case "failed":
    case "error":
    case "down":
    case "revoked":
    case "quota_exhausted":
      return "bad";
    default:
      return "muted";
  }
}

export function humanize(value: string): string {
  const words = value.replace(/[_.-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A mission's progress, from the state the core reports for each of its tasks. */
export function missionProgress(tasks: readonly { state: string }[]): {
  done: number;
  total: number;
  percent: number;
} {
  const finished = new Set(["succeeded", "completed", "failed", "cancelled", "skipped"]);
  const done = tasks.filter((task) => finished.has(task.state.toLowerCase())).length;
  return {
    done,
    total: tasks.length,
    percent: tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100),
  };
}

/** Result or error JSON the core stores as text: shown readably, never thrown on. */
export function readableJson(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object") {
      const { message, text, summary, response } = parsed as Record<string, unknown>;
      for (const candidate of [response, text, summary, message]) {
        if (typeof candidate === "string" && candidate.length > 0) return candidate;
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}
