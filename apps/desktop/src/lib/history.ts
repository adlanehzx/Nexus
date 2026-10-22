import type { MessageView } from "@nexus/client-core";

/**
 * Merging history and live stream messages.
 *
 * Sourced from REST history and WebSocket real-time updates.
 * De-duplicates by ID and lets live stream override history entries.
 */

export interface HistoryMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  originClientDeviceId?: string | null;
}

export function mergeHistory(
  live: readonly MessageView[],
  history: readonly HistoryMessage[],
): MessageView[] {
  const merged = new Map<string, MessageView>();

  for (const message of history) merged.set(message.id, fromHistory(message));
  // Live stream comes second: it overwrites, it is not overwritten.
  for (const message of live) merged.set(message.id, message);

  return [...merged.values()].sort(byTime);
}

function fromHistory(message: HistoryMessage): MessageView {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    streaming: false,
    createdAt: message.createdAt,
    originClientDeviceId: message.originClientDeviceId ?? null,
  };
}

/**
 * Stable chronological sort.
 *
 * For equal timestamps — two messages written in the same millisecond, which
 * happens when the engine responds immediately — the identifier breaks ties.
 * An unstable sort would cause the two messages to swap places on each render.
 */
function byTime(left: MessageView, right: MessageView): number {
  if (left.createdAt === right.createdAt) return left.id < right.id ? -1 : 1;
  return left.createdAt < right.createdAt ? -1 : 1;
}
