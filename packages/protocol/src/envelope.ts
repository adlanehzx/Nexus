import { z } from "zod";

/**
 * Version du protocole temps réel. Toute enveloppe la porte : un client dont la
 * version majeure diffère est fermé avec le code 4400 plutôt que de recevoir des
 * messages qu'il interprétera de travers.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Enveloppe commune à tous les messages WebSocket, dans les deux sens.
 *
 * `seq` est monotone par canal : c'est lui qui rend le flux reprenable après une
 * coupure réseau (`subscribe { since }` rejoue ce qui manque depuis le Redis Stream).
 */
export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.iso.datetime(),
  /**
   * Corrèle une réponse à la demande qui l'a provoquée.
   *
   * Distinct de `id`, qui identifie *ce* message : deux réponses successives à
   * la même demande ont des `id` différents et le même `requestId`. Sans lui, un
   * client qui a trois requêtes en vol ne sait pas laquelle vient d'aboutir.
   */
  requestId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative().optional(),
  channel: z.string().min(1).optional(),
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Codes de fermeture applicatifs (plage 4000–4999 réservée aux applications).
 * Le client reconnecte avec backoff sauf sur PROTOCOL_MISMATCH et UNAUTHENTICATED.
 */
export const WsCloseCode = {
  PROTOCOL_MISMATCH: 4400,
  UNAUTHENTICATED: 4401,
  FORBIDDEN_CHANNEL: 4403,
  AUTH_TIMEOUT: 4408,
  RATE_LIMITED: 4429,
  INTERNAL_ERROR: 4500,
} as const;

export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode];
