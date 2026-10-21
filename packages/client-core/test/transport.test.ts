import { describe, expect, it } from "vitest";
import {
  InsecureBackendUrlError,
  backendHttpUrl,
  clientSocketUrl,
  isLocalHost,
} from "../src/transport.js";

/**
 * Backend URL validation tests.
 */

describe("backend URL", () => {
  it("accepts https and normalizes trailing slash", () => {
    expect(backendHttpUrl("https://nexus.example.com")).toBe("https://nexus.example.com");
    expect(backendHttpUrl("https://nexus.example.com/")).toBe("https://nexus.example.com");
  });

  it("rejects remote plaintext URL", () => {
    expect(() => backendHttpUrl("http://nexus.example.com")).toThrow(InsecureBackendUrlError);
    expect(() => backendHttpUrl("http://192.168.1.20:3000")).toThrow(InsecureBackendUrlError);
  });

  it("allows localhost and emulator loopback", () => {
    expect(backendHttpUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(backendHttpUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(backendHttpUrl("http://10.0.2.2:3000")).toBe("http://10.0.2.2:3000");

    expect(isLocalHost("LOCALHOST")).toBe(true);
    expect(isLocalHost("nexus.example.com")).toBe(false);
  });

  it("rejects non-URL strings or unexpected protocols", () => {
    expect(() => backendHttpUrl("nexus.example.com")).toThrow(InsecureBackendUrlError);
    expect(() => backendHttpUrl("file:///etc/passwd")).toThrow(InsecureBackendUrlError);
    expect(() => backendHttpUrl("javascript:alert(1)")).toThrow(InsecureBackendUrlError);
  });

  it("includes offending URL in error message without leaking secrets", () => {
    try {
      backendHttpUrl("http://nexus.example.com");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("http://nexus.example.com");
    }
  });
});

describe("real-time socket URL", () => {
  it("derives wss from https", () => {
    expect(clientSocketUrl("https://nexus.example.com")).toBe("wss://nexus.example.com/ws/client");
  });

  it("derives ws from localhost", () => {
    expect(clientSocketUrl("http://localhost:3000")).toBe("ws://localhost:3000/ws/client");
  });

  it("rejects remote plaintext websocket URL", () => {
    expect(() => clientSocketUrl("http://nexus.example.com")).toThrow(InsecureBackendUrlError);
  });

  it("does not duplicate channel path if already present", () => {
    expect(clientSocketUrl("https://nexus.example.com/ws/client")).toBe(
      "wss://nexus.example.com/ws/client",
    );
  });
});
