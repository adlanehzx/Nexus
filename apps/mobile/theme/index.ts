/**
 * Le thème.
 *
 * Sombre par défaut : NEXUS s'utilise beaucoup le soir et sur un téléphone tenu
 * à bout de bras. Les couleurs de risque sont les mêmes que dans les journaux du
 * serveur — un HIGH doit avoir la même teinte partout, sinon l'utilisateur
 * réapprend l'échelle à chaque écran.
 */
export const theme = {
  color: {
    background: "#0b0d12",
    surface: "#151922",
    surfaceRaised: "#1e2430",
    border: "#262d3a",
    text: "#f2f4f8",
    textMuted: "#98a2b3",
    textFaint: "#6b7280",
    accent: "#5b8cff",
    success: "#4ade80",
    warning: "#fbbf24",
    danger: "#f87171",
  },
  risk: {
    SAFE: "#4ade80",
    LOW: "#60a5fa",
    MEDIUM: "#fbbf24",
    HIGH: "#fb923c",
    CRITICAL: "#f87171",
  } as Record<string, string>,
  space: (n: number) => n * 4,
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
} as const;

/** Couleur d'un niveau de risque, avec un repli lisible. */
export function riskColor(level: string): string {
  return theme.risk[level] ?? theme.color.textMuted;
}

/** Couleur d'un état de tâche. */
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

/** Libellé français d'un état de tâche. */
export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "en attente",
    running: "en cours",
    waiting_for_confirmation: "attente de confirmation",
    succeeded: "terminée",
    partial: "partiellement terminée",
    failed: "échouée",
    cancelled: "annulée",
  };
  return labels[status] ?? status;
}
