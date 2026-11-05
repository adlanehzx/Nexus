import { describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { normalizeServerUrl } from "../lib/server.js";

describe("normalizeServerUrl", () => {
  it("assumes https for a bare host", () => {
    expect(normalizeServerUrl(" nexus.example-tailnet.ts.net ")).toBe(
      "https://nexus.example-tailnet.ts.net",
    );
  });

  it("strips the trailing slash", () => {
    expect(normalizeServerUrl("https://nexus.example.com/")).toBe("https://nexus.example.com");
  });

  it("refuses plaintext to a remote host, with a reason a person can act on", () => {
    expect(() => normalizeServerUrl("http://192.168.1.20:3000")).toThrow(/must use https/);
  });

  it("allows plaintext to the local machine and the Android emulator host", () => {
    expect(normalizeServerUrl("http://10.0.2.2:3000")).toBe("http://10.0.2.2:3000");
    expect(normalizeServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("rejects an empty or malformed address", () => {
    expect(() => normalizeServerUrl("   ")).toThrow(/Enter/);
    expect(() => normalizeServerUrl("ftp://nexus")).toThrow(/valid server address/);
  });
});
