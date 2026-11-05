import { describe, expect, it, vi } from "vitest";

const secure = vi.hoisted(() =>
  vi.fn(<T extends Uint8Array>(into: T): T => {
    into.fill(7);
    return into;
  }),
);

vi.mock("expo-crypto", () => ({ getRandomValues: secure }));

import { uuidv7 } from "../../../packages/shared/src/ids.js";
import { installWebCrypto } from "../lib/web-crypto.js";

describe("installWebCrypto", () => {
  it("provides the platform's generator when the engine has none", () => {
    const hermes: { crypto?: { getRandomValues?: unknown } } = {};
    installWebCrypto(hermes);
    expect(hermes.crypto?.getRandomValues).toBe(secure);
  });

  it("keeps a generator the engine already has", () => {
    const native = () => undefined;
    const browser = { crypto: { getRandomValues: native } };
    installWebCrypto(browser);
    expect(browser.crypto.getRandomValues).toBe(native);
  });

  it("makes shared identifiers work on an engine without Web Crypto", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    try {
      expect(() => uuidv7()).toThrow(/cryptographic randomness/);
      installWebCrypto();
      expect(uuidv7()).toMatch(/^[0-9a-f-]{36}$/);
      expect(secure).toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }
  });
});
