/**
 * Theme configuration.
 *
 * Dark by default: NEXUS is often used at night and on handheld mobile devices.
 * Risk colors match those in server logs — a HIGH must share the same hue everywhere,
 * avoiding confusion across screens.
 */
export const theme = {
  color: {
    background: "#070a10",
    surface: "#0d131d",
    surfaceRaised: "#121b28",
    border: "#26364a",
    text: "#edf5ff",
    textMuted: "#91a1b6",
    textFaint: "#64758a",
    accent: "#7de8ff",
    success: "#75e3ad",
    warning: "#ffcb6b",
    danger: "#ff7f8f",
  },
  risk: {
    SAFE: "#4ade80",
    LOW: "#60a5fa",
    MEDIUM: "#fbbf24",
    HIGH: "#fb923c",
    CRITICAL: "#f87171",
  } as Record<string, string>,
  space: (n: number) => n * 4,
  radius: { sm: 10, md: 16, lg: 24, pill: 999 },
} as const;

/** Color for a risk level, with readable fallback. */
export function riskColor(level: string): string {
  return theme.risk[level] ?? theme.color.textMuted;
}

/** Color for a task status. */
export function statusColor(status: string): string {
  switch (status) {
    case "succeeded":
      return theme.color.success;
    case "partial":
      return theme.color.warning;
    case "failed":
      return theme.color.danger;
    case "cancelled":
      return theme.color.textFaint;
    default:
      return theme.color.accent;
  }
}

/** Human-readable label for a task status. */
export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "queued",
    running: "running",
    waiting_for_confirmation: "awaiting confirmation",
    succeeded: "completed",
    partial: "partially completed",
    failed: "failed",
    cancelled: "cancelled",
  };
  return labels[status] ?? status;
}
