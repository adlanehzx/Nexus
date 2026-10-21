/**
 * Keywords triggering mandatory human confirmation before execution.
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
 * Assesses whether an Activepieces SaaS action poses external or financial risks
 * requiring mandatory human confirmation.
 */
export function isSensitiveSaaSAction(
  pieceName: string,
  actionName: string,
  input: Record<string, unknown>,
): boolean {
  if (input.isSensitive === true) return true;

  const normalizedPiece = pieceName.toLowerCase();
  const normalizedAction = actionName.toLowerCase();

  // Financial and public broadcasting pieces are sensitive by default on write/send actions
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

  // Sensitive action pattern matching
  return SENSITIVE_ACTION_PATTERNS.some((pattern) => pattern.test(normalizedAction));
}

/**
 * Generates a concise, secure human confirmation summary.
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
    return `Send Slack message to channel "${channel}"`;
  }
  if (pieceName === "discord" && channel) {
    return `Send Discord message to channel "${channel}"`;
  }
  if (pieceName === "stripe" && amount) {
    return `Execute Stripe financial transaction for ${amount}`;
  }
  if (to) {
    return `Action ${pieceName}.${actionName} targeting "${to}"`;
  }

  return `Execute external SaaS action "${pieceName}.${actionName}"`;
}
