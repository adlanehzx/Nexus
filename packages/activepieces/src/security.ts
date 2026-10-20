/**
 * Mots-clés déclenchant obligatoirement une confirmation humaine avant exécution.
 */
const SENSITIVE_ACTION_PATTERNS = [
  /send[_-]?(message|email|mail|dm|notification|tweet|sms)/i,
  /post[_-]?(message|tweet|update|comment)/i,
  /create[_-]?(payment|charge|invoice|subscription|refund|order)/i,
  /charge/i,
  /delete/i,
  /remove/i,
  /purge/i,
  /drop/i,
  /revoke/i,
  /transfer/i,
];

const SENSITIVE_PIECES = ["stripe", "paypal", "slack", "discord", "gmail", "twitter", "x"];

/**
 * Évalue si une action SaaS Activepieces présente un risque externe ou financier
 * nécessitant une confirmation humaine obligatoire.
 */
export function isSensitiveSaaSAction(
  pieceName: string,
  actionName: string,
  input: Record<string, unknown>,
): boolean {
  if (input.isSensitive === true) return true;

  const normalizedPiece = pieceName.toLowerCase();
  const normalizedAction = actionName.toLowerCase();

  // Les pièces financières ou de diffusion publique sont sensibles par défaut sur les actions d'écriture
  if (SENSITIVE_PIECES.includes(normalizedPiece)) {
    if (
      normalizedAction.startsWith("create") ||
      normalizedAction.startsWith("send") ||
      normalizedAction.startsWith("post") ||
      normalizedAction.startsWith("delete") ||
      normalizedAction.startsWith("charge")
    ) {
      return true;
    }
  }

  // Vérification des motifs sensibles d'action
  return SENSITIVE_ACTION_PATTERNS.some((pattern) => pattern.test(normalizedAction));
}

/**
 * Génère un résumé clair et sécurisé destiné à la carte de confirmation utilisateur.
 */
export function summarizeSaaSAction(
  pieceName: string,
  actionName: string,
  input: Record<string, unknown>,
): string {
  const channel = typeof input.channel === "string" ? input.channel : undefined;
  const to = typeof input.to === "string" ? input.to : undefined;
  const amount =
    typeof input.amount === "string" || typeof input.amount === "number"
      ? String(input.amount)
      : undefined;

  if (pieceName === "slack" && channel) {
    return `Envoi d'un message Slack sur le canal « ${channel} »`;
  }
  if (pieceName === "discord" && channel) {
    return `Envoi d'un message Discord sur le salon « ${channel} »`;
  }
  if (pieceName === "stripe" && amount) {
    return `Exécution d'une transaction financière Stripe d'un montant de ${amount}`;
  }
  if (to) {
    return `Action ${pieceName}.${actionName} destinée à « ${to} »`;
  }

  return `Exécution de l'action SaaS externe « ${pieceName}.${actionName} »`;
}
