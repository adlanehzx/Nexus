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
