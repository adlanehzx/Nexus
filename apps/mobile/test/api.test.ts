import { describe, expect, it, vi } from "vitest";
import { MobileApi } from "../lib/api.js";
import { ApiError, describeFailure, failureMessage } from "../lib/errors.js";

function transport(status: number, body: unknown) {
  const authorizedRequest = vi.fn(() => Promise.resolve({ status, body }));
  return {
    api: new MobileApi({ authorizedRequest }),
    authorizedRequest,
  };
}

describe("MobileApi", () => {
  it("unwraps { data } envelopes", async () => {
    const { api } = transport(200, { data: { paused: true, reason: null, since: null } });
    expect((await api.pauseState()).paused).toBe(true);
  });

  it("reads routes that answer bare objects", async () => {
    const { api } = transport(200, { providers: [{ id: "a" }] });
    expect(await api.providers()).toEqual([{ id: "a" }]);
  });

  it("encodes path segments", async () => {
    const { api, authorizedRequest } = transport(200, { data: {} });
    await api.reconnectMcp("a/b c");
    expect(authorizedRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/dashboard/mcp/servers/a%2Fb%20c/reconnect",
    });
  });

  it("gives agent runs a long deadline of their own", async () => {
    const { api, authorizedRequest } = transport(200, { data: { runId: "r" } });
    await api.runAgent("c", "hi");
    expect(authorizedRequest.mock.calls[0]).toEqual([
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
  });

  it("walks the history cursor oldest to newest", async () => {
    const authorizedRequest = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { data: [1], meta: { nextCursor: "n" } } })
      .mockResolvedValueOnce({ status: 200, body: { data: [2], meta: { nextCursor: null } } });
    const api = new MobileApi({ authorizedRequest });

    expect(await api.listAllMessages<number>("c")).toEqual({ items: [1, 2], truncated: false });
    expect(authorizedRequest.mock.calls[1]?.[0].path).toContain("cursor=n");
  });

  it("bounds the history walk and says so", async () => {
    const authorizedRequest = vi.fn(() =>
      Promise.resolve({ status: 200, body: { data: [1], meta: { nextCursor: "more" } } }),
    );
    const api = new MobileApi({ authorizedRequest });
    const result = await api.listAllMessages<number>("c");
    expect(result.truncated).toBe(true);
    expect(authorizedRequest).toHaveBeenCalledTimes(5);
  });

  it.each([
    [{ error: { code: "FORBIDDEN", message: "Admins only" } }, "Admins only", "FORBIDDEN"],
    [
      { code: "USAGE_TELEMETRY_UNAVAILABLE", message: "Not connected" },
      "Not connected",
      "USAGE_TELEMETRY_UNAVAILABLE",
    ],
    [null, "The request failed.", undefined],
  ])("throws the status and server message from %j", async (body, message, code) => {
    const { api } = transport(403, body);
    const error = await api.overview().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message, code });
  });
});

describe("describeFailure", () => {
  it.each([
    [new ApiError(401, "x"), "auth", false],
    [new ApiError(403, "x"), "forbidden", false],
    [new ApiError(404, "Resource not found.", "NOT_FOUND"), "notFound", false],
    [new ApiError(503, "x"), "unavailable", true],
    [new ApiError(500, "x"), "server", true],
    [new ApiError(400, "x"), "server", false],
    [Object.assign(new Error("x"), { code: "CLIENT_REQUEST_BLOCKED" }), "network", true],
    [Object.assign(new Error("x"), { name: "AbortError" }), "network", true],
    [Object.assign(new Error("x"), { code: "CLIENT_NOT_AUTHENTICATED" }), "auth", false],
    ["weird", "server", true],
  ])("%s", (cause, kind, retryable) => {
    expect(describeFailure(cause)).toMatchObject({ kind, retryable });
  });

  it("never leaks the transport's internal explanation in an action message", () => {
    const blocked = Object.assign(new Error("Unable to reach https://x. CSP blocked"), {
      code: "CLIENT_REQUEST_BLOCKED",
    });
    expect(failureMessage(blocked)).not.toMatch(/CSP/);
  });
});
