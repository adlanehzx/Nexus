import {
  reduce,
  type ClientAction,
  type ClientState,
  type MessageView,
  type NotificationView,
} from "@nexus/client-core";

/**
 * Mobile extension of the client-core reducer.
 *
 * The shared store models the live event stream. It has no notion of history,
 * because the channel replays nothing: what happened while the phone was in a
 * tunnel exists only on the server. The two actions added here merge what REST
 * returns into that state, so screens read one source. Everything else is
 * delegated unchanged.
 */

export type MobileAction =
  | ClientAction
  /** Replaces the timeline with a conversation's server history, keeping what is still in flight. */
  | { kind: "hydrateMessages"; messages: MessageView[] }
  | { kind: "clearMessages" }
  /** Withdraws a message the core refused, so it does not read as sent. */
  | { kind: "removeMessage"; messageId: string }
  | { kind: "hydrateNotifications"; notifications: NotificationView[] };

export function reduceMobile(state: ClientState, action: MobileAction): ClientState {
  switch (action.kind) {
    case "hydrateMessages":
      return { ...state, messages: mergeMessages(state.messages, action.messages) };
    case "clearMessages":
      return { ...state, messages: [], toolCalls: [], confirmations: [] };
    case "removeMessage":
      return {
        ...state,
        messages: state.messages.filter((message) => message.id !== action.messageId),
      };
    case "hydrateNotifications":
      return {
        ...state,
        notifications: mergeNotifications(state.notifications, action.notifications),
      };
    default:
      return reduce(state, action);
  }
}

/** Prefix of a message shown before the server has acknowledged it. */
export const LOCAL_MESSAGE_PREFIX = "local-";

/**
 * Server history wins, except for what it cannot know yet.
 *
 * - A message still streaming stays: its deltas have not all been persisted.
 * - An optimistic user message stays until the server holds the same text; once
 *   it does, keeping both would show the message twice.
 */
export function mergeMessages(current: MessageView[], history: MessageView[]): MessageView[] {
  const known = new Set(history.map((message) => message.id));
  const unmatched = new Map<string, number>();
  for (const message of history) {
    const key = `${message.role}\u0000${message.content}`;
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }

  const pending = current.filter((message) => {
    if (known.has(message.id)) return false;
    if (message.streaming) return true;
    if (!message.id.startsWith(LOCAL_MESSAGE_PREFIX)) return false;

    const key = `${message.role}\u0000${message.content}`;
    const remaining = unmatched.get(key) ?? 0;
    if (remaining === 0) return true;
    unmatched.set(key, remaining - 1);
    return false;
  });

  return [...history, ...pending];
}

/** Newest first. An event received during the fetch survives it; a read mark is never undone. */
export function mergeNotifications(
  current: NotificationView[],
  history: NotificationView[],
): NotificationView[] {
  const byId = new Map(current.map((notification) => [notification.id, notification]));
  for (const notification of history) {
    const local = byId.get(notification.id);
    byId.set(notification.id, {
      ...notification,
      readAt: notification.readAt ?? local?.readAt ?? null,
    });
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** How a message from the composer reaches the core. Each maps to one real route. */
export type SendMode =
  /** Conversation with the general agent: `POST /agent-core/runs`. */
  | "chat"
  /** An action to plan and run on the fleet: `POST /tasks/instruct`. */
  | "action"
  /** Multi-agent work: `POST /orchestrator/messages`. */
  | "mission";

export const TASK_INSTRUCTION_MAX_CHARS = 2_000;

/** Why this mode cannot send right now, or `undefined` when it can. */
export function sendBlocker(
  mode: SendMode,
  context: { online: boolean; realtime: boolean; devicePending: boolean },
): string | undefined {
  if (!context.online) return "You are offline.";
  if (mode === "action") {
    if (context.devicePending) return "Approve this device before running actions.";
    if (!context.realtime) return "Actions need the live connection to NEXUS.";
  }
  return undefined;
}
