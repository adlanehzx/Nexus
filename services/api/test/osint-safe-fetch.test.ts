/* eslint-disable @typescript-eslint/require-await --
   Test doubles implement async/Promise-returning interfaces without awaiting and use loose fetch mocks. */
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  resolveAny: vi.fn(),
}));
vi.mock("node:https", () => ({
  request: (_options: unknown, callback: (response: unknown) => void) => {
    transport.calls++;
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () =>
      callback({
        statusCode: 302,
        headers: { location: "https://127.0.0.1/private" },
        resume: () => undefined,
      });
    return request;
  },
}));
import { fetchOsintPublicText } from "../src/services/osint-service.js";

it("revalidates registry redirects and refuses a private redirect before a second HTTP request", async () => {
  await expect(fetchOsintPublicText("https://rdap.org/domain/example.org")).rejects.toThrow();
  expect(transport.calls).toBe(1);
});
