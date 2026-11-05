import { randomUUID } from "expo-crypto";

/** A unique idempotency key, from the platform's secure generator. */
export function newIdempotencyKey(): string {
  return randomUUID();
}
