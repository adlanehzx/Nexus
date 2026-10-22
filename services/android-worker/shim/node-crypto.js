/**
 * `node:crypto`, for React Native.
 *
 * ## Why this file exists
 *
 * `@nexus/shared` — shared by core, Windows worker, and this worker —
 * constructs its IDs with `uuidv7()`, which calls `randomFillSync` from
 * `node:crypto`. The JavaScript engine on Android lacks this module and
 * `crypto.getRandomValues`. Without this file, the package cannot load.
 *
 * Shared code should not need platform-specific Android knowledge.
 * Adapting on the Android side is the appropriate role of an adaptation layer.
 *
 * ## Randomness is real
 *
 * `secureRandomBase64` relies on `java.security.SecureRandom`. **No `Math.random`**:
 * its sequence is predictable from a few observations, and these bytes become
 * request IDs sent over the wire.
 *
 * ## What is not implemented
 *
 * Everything else — encryption, key derivation, `createHash`. These functions
 * throw rather than returning approximate results.
 */
const { NativeModules } = require("react-native");

const BYTES_PER_CALL = 256;

let pool = new Uint8Array(0);
let cursor = 0;

/** Refills pool from Android generator. */
function refillPool(minimum) {
  const native = NativeModules.NexusWorker;
  if (native === undefined || native === null) {
    throw new Error(
      "NexusWorker: native module missing, no cryptographic randomness source available",
    );
  }

  const size = Math.max(minimum, BYTES_PER_CALL);
  const base64 = native.secureRandomBase64(size);
  pool = decodeBase64(base64);
  cursor = 0;
}

/**
 * Decodes base64 without `Buffer` or `atob`.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(text) {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const output = new Uint8Array(Math.floor((clean.length * 3) / 4));

  let written = 0;
  let buffer = 0;
  let bits = 0;

  for (let index = 0; index < clean.length; index += 1) {
    buffer = (buffer << 6) | ALPHABET.indexOf(clean[index]);
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      output[written++] = (buffer >> bits) & 0xff;
    }
  }

  return output.subarray(0, written);
}

/**
 * Fills a byte view with cryptographic randomness.
 *
 * Same signature as Node: the view is filled in place and returned.
 */
function randomFillSync(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

  for (let index = 0; index < bytes.length; index += 1) {
    if (cursor >= pool.length) refillPool(bytes.length - index);
    bytes[index] = pool[cursor++];
  }

  return view;
}

/** Browser standard alias, same source. */
function getRandomValues(view) {
  return randomFillSync(view);
}

/** UUID v4, RFC 9562 compliant. */
function randomUUID() {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [];
  for (let index = 0; index < 16; index += 1) {
    hex.push(bytes[index].toString(16).padStart(2, "0"));
  }

  const text = hex.join("");
  return [
    text.slice(0, 8),
    text.slice(8, 12),
    text.slice(12, 16),
    text.slice(16, 20),
    text.slice(20, 32),
  ].join("-");
}

/**
 * Unimplemented functions fail loudly.
 */
function notImplemented(name) {
  return () => {
    throw new Error(
      `node:crypto.${name} is not available on Android. ` +
        "Device signing uses the keystore, not this function.",
    );
  };
}

module.exports = {
  randomFillSync,
  randomUUID,
  getRandomValues,
  createHash: notImplemented("createHash"),
  createHmac: notImplemented("createHmac"),
  createSign: notImplemented("createSign"),
  createVerify: notImplemented("createVerify"),
  timingSafeEqual: notImplemented("timingSafeEqual"),
  default: { randomFillSync, randomUUID, getRandomValues },
};
