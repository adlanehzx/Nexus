import { z } from "zod";

/**
 * Real-time protocol version. Carried by every envelope:
 * A client whose major version differs is closed with code 4400 rather than
 * receiving messages it could misinterpret.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Common envelope for all bidirectional WebSocket messages.
 *
 * `seq` is strictly monotonic per channel: enables stream resumption after network disconnects
 * (`subscribe { since }` replays missed entries from the backing stream).
 */
export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.iso.datetime(),
  /**
   * Correlates a response to the originating request.
   *
   * Distinct from `id` (which identifies *this* specific message): two successive responses
   * to the same request share the same `requestId` but have distinct `id` values.
   */
  requestId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative().optional(),
  channel: z.string().min(1).optional(),
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Application-level WebSocket close codes (4000-4999 application reserved range).
 * Clients reconnect with backoff except on PROTOCOL_MISMATCH and UNAUTHENTICATED.
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
