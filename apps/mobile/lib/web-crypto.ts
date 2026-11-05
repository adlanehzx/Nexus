import { getRandomValues } from "expo-crypto";

/**
 * Gives Hermes the Web Crypto source `@nexus/shared` requires for its identifiers.
 *
 * Hermes has no `globalThis.crypto`, so every `uuidv7()` throws, and the realtime
 * handshake is the first thing to need one. `expo-crypto` draws from the platform's
 * secure generator. There is deliberately no `Math.random` fallback.
 */
export function installWebCrypto(target: object = globalThis): void {
  const holder = target as { crypto?: { getRandomValues?: unknown } };
  if (holder.crypto?.getRandomValues !== undefined) return;
  holder.crypto = { ...holder.crypto, getRandomValues };
}

installWebCrypto();
