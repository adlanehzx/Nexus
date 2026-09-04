import type { MessageView } from "@nexus/client-core";

/**
 * Fusion de l'historique et du direct.
 *
 * Deux sources décrivent la même conversation, et elles se recouvrent :
 *
 *  - le **REST** rend ce qui a été dit avant l'ouverture de la fenêtre ;
 *  - le **temps réel** rend ce qui arrive depuis.
 *
 * Elles se chevauchent toujours d'un message ou deux, parce que la requête
 * d'historique et l'ouverture de la socket ne sont pas simultanées. Concaténer
 * naïvement afficherait ce chevauchement en double — le défaut classique d'un
 * client de discussion, et celui qu'on remarque immédiatement.
 *
 * Deux règles suffisent :
 *
 *  1. **l'identifiant fait foi.** Deux entrées de même `id` sont un seul
 *     message.
 *  2. **le direct gagne.** Une entrée du flux porte l'état de streaming en
 *     cours ; l'historique, lui, ne connaît que du texte figé. Laisser
 *     l'historique écraser le direct ferait disparaître le curseur d'un message
 *     encore en train de s'écrire.
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
  // Le direct passe en second : il écrase, il n'est pas écrasé.
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
 * Tri chronologique stable.
 *
 * À horodatage égal — deux messages écrits dans la même milliseconde, ce qui
 * arrive quand le cœur répond aussitôt — l'identifiant tranche. Un tri
 * instable ferait sauter les deux messages d'une place à chaque rendu.
 */
function byTime(left: MessageView, right: MessageView): number {
  if (left.createdAt === right.createdAt) return left.id < right.id ? -1 : 1;
  return left.createdAt < right.createdAt ? -1 : 1;
}
