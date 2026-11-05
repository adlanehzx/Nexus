import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { isAllowedSocketOrigin } from "../src/ws/socket-origin.js";
import { makeApi, type ApiHarness } from "./harness.js";

const allowedOrigins = ["https://dashboard.example.test"];
const check = (origin: string | undefined, host: string | undefined) =>
  isAllowedSocketOrigin({ origin, host, allowedOrigins });

describe("isAllowedSocketOrigin", () => {
  it("accepts a missing origin and a listed origin", () => {
    expect(check(undefined, "api.example.test")).toBe(true);
    expect(check("https://dashboard.example.test", "api.example.test")).toBe(true);
  });

  it("accepts the server's own address, as React Native sends it", () => {
    expect(check("http://10.0.2.2:3000", "10.0.2.2:3000")).toBe(true);
    expect(check("https://api.example.test", "api.example.test")).toBe(true);
    expect(check("http://api.example.test", "api.example.test")).toBe(true);
    expect(check("https://api.example.test:443", "api.example.test:443")).toBe(true);
    expect(check("https://API.example.test", "api.example.test")).toBe(true);
    expect(check("http://[::1]:3000", "[::1]:3000")).toBe(true);
  });

  it("rejects a foreign origin", () => {
    expect(check("https://evil.example.test", "api.example.test")).toBe(false);
    expect(check("http://api.example.test.evil.test", "api.example.test")).toBe(false);
    expect(check("http://evil.test@api.example.test", "evil.test")).toBe(false);
  });

  it("rejects the same host on another port", () => {
    expect(check("http://localhost:5173", "localhost:3000")).toBe(false);
    expect(check("http://api.example.test:8080", "api.example.test")).toBe(false);
    expect(check("http://api.example.test:443", "api.example.test")).toBe(false);
    expect(check("https://api.example.test", "api.example.test:80")).toBe(false);
  });

  it("rejects when a proxy rewrote Host, until the public address is listed", () => {
    expect(check("https://nexus.example.test", "api-internal:3000")).toBe(false);
    expect(
      isAllowedSocketOrigin({
        origin: "https://nexus.example.test",
        host: "api-internal:3000",
        allowedOrigins: ["https://nexus.example.test"],
      }),
    ).toBe(true);
  });

  it("rejects malformed values and origins without a web scheme", () => {
    expect(check("null", "api.example.test")).toBe(false);
    expect(check("not a url", "api.example.test")).toBe(false);
    expect(check("file://api.example.test", "api.example.test")).toBe(false);
    expect(check("http://api.example.test", undefined)).toBe(false);
    expect(check("http://api.example.test", "")).toBe(false);
    expect(check("http://api.example.test", "api.example.test/path")).toBe(false);
    expect(check("http://api.example.test", "user@api.example.test")).toBe(false);
  });
});

describe("/ws/client over a real socket", () => {
  let harness: ApiHarness;
  let host: string;

  beforeAll(async () => {
    harness = await makeApi();
    const address = await harness.app.listen({ host: "127.0.0.1", port: 0 });
    host = new URL(address).host;
  });

  afterAll(async () => {
    await harness.close();
  });

  const connect = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}/ws/client`, { headers });
      socket.once("open", () => {
        socket.close();
        resolve(101);
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      socket.once("error", reject);
    });

  it("opens for the server's own origin, as Android sends it", async () => {
    expect(await connect({ origin: `http://${host}` })).toBe(101);
  });

  it("refuses a foreign origin", async () => {
    expect(await connect({ origin: "https://evil.example.test" })).toBe(403);
  });

  it("does not let X-Forwarded-Host vouch for a foreign origin", async () => {
    expect(
      await connect({
        origin: "https://evil.example.test",
        "x-forwarded-host": "evil.example.test",
      }),
    ).toBe(403);
  });
});
