/**
 * `Buffer`, reduced to what NEXUS requires on Android.
 *
 * `uuidv7()` in `@nexus/shared` calls `Buffer.from(bytes).toString("hex")`.
 * This is the only usage on the Android worker path — verified by tracing
 * imports from `src/main.ts`.
 *
 * Rather than embedding the complete `buffer` implementation (an extra dependency,
 * forty kilobytes, and surface area to maintain), we provide exactly the two
 * functions used. Missing functions throw and will be spotted immediately.
 */

function toHex(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) {
    text += bytes[index].toString(16).padStart(2, "0");
  }
  return text;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes) {
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];

    output += ALPHABET[a >> 2];
    output += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? "=" : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? "=" : ALPHABET[c & 0x3f];
  }

  return output;
}

class NexusBuffer extends Uint8Array {
  toString(encoding) {
    if (encoding === "hex") return toHex(this);
    if (encoding === "base64") return toBase64(this);
    if (encoding === "utf8" || encoding === undefined) {
      return String.fromCharCode.apply(null, Array.from(this));
    }
    throw new Error(`Buffer.toString: encoding "${String(encoding)}" not supported`);
  }
}

const Buffer = {
  from(source, encoding) {
    if (typeof source === "string") {
      if (encoding !== undefined && encoding !== "utf8") {
        throw new Error(`Buffer.from: encoding "${encoding}" not supported`);
      }
      const bytes = new NexusBuffer(source.length);
      for (let index = 0; index < source.length; index += 1) {
        bytes[index] = source.charCodeAt(index) & 0xff;
      }
      return bytes;
    }

    const view = new NexusBuffer(source.length ?? source.byteLength);
    view.set(source);
    return view;
  },

  alloc(size) {
    return new NexusBuffer(size);
  },

  isBuffer(value) {
    return value instanceof NexusBuffer;
  },
};

module.exports = { Buffer, NexusBuffer };
