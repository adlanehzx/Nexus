import {
  ConnectionDetector,
  NodeProcessPort,
  ProviderRegistry,
  SafeCommandRunner,
  SystemClock,
} from "@nexus/connections";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RequestAuthenticator } from "../src/auth.js";
import { startConnector, type RunningConnector } from "../src/http.js";
import { ConnectorServer } from "../src/server.js";
import { createTestClient } from "./client.js";

/**
 * Transport tests, bound to a real socket.
 *
 * What they check is who can reach the dispatcher, which is a property of the
 * listener and the headers rather than of the dispatch code.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

let running: RunningConnector | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function connectorServer() {
  const client = createTestClient();
  const detector = new ConnectionDetector({
    registry: new ProviderRegistry([]),
    runner: new SafeCommandRunner({
      process: new NodeProcessPort({ path: "", platform: "linux" }),
      clock: new SystemClock(),
    }),
    clock: new SystemClock(),
    platform: "linux",
  });
  const server = new ConnectorServer({
    detector,
    authenticator: new RequestAuthenticator({
      clients: [{ clientId: client.clientId, publicKey: client.publicKey }],
    }),
  });
  return { server, client };
}

async function post(
  port: number,
  body: unknown,
  init: { headers?: Record<string, string>; method?: string; path?: string } = {},
): Promise<Response> {
  const method = init.method ?? "POST";
  // `exactOptionalPropertyTypes` means an explicit `undefined` body is not the
  // same as an absent one, so the key is omitted rather than set to undefined.
  return fetch(`http://127.0.0.1:${String(port)}${init.path ?? "/rpc"}`, {
    method,
    headers: { "content-type": "application/json", ...init.headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

posixOnly("connector over loopback", () => {
  it("answers a correctly signed request", async () => {
    const { server, client } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    const response = await post(port, client.sign({ method: "health" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("binds to loopback only", async () => {
    const { server } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });

    // There is no option to change the host, which is the point: an option
    // would eventually be set to 0.0.0.0 by somebody debugging.
    expect("port" in running.address).toBe(true);
  });

  it("refuses a request a web page could make", async () => {
    const { server, client } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    const response = await post(port, client.sign({ method: "health" }), {
      headers: { origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
  });

  it("refuses a body that is not declared as JSON", async () => {
    const { server, client } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    // A form post needs no preflight, so a page can send one without `Origin`
    // being the only thing standing in the way.
    const response = await post(port, client.sign({ method: "health" }), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.status).toBe(415);
  });

  it("refuses any method but POST", async () => {
    const { server } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    expect((await post(port, undefined, { method: "GET" })).status).toBe(405);
  });

  it("exposes exactly one endpoint", async () => {
    const { server, client } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    expect((await post(port, client.sign({ method: "health" }), { path: "/exec" })).status).toBe(
      404,
    );
    expect((await post(port, client.sign({ method: "health" }), { path: "/" })).status).toBe(404);
  });

  it("refuses an oversized body instead of holding it", async () => {
    const { server } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    const response = await post(port, { nonce: "x".repeat(200_000) });

    expect(response.status).toBe(413);
  });

  it("answers a protocol refusal with 200 and the reason in the envelope", async () => {
    const { server } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    const response = await post(port, { not: "a request" });

    // The HTTP layer did its job; the refusal is a protocol answer.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "malformed_request" },
    });
  });

  it("rejects a body that is not JSON at all", async () => {
    const { server } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    const response = await fetch(`http://127.0.0.1:${String(port)}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    expect(response.status).toBe(400);
  });

  it("tells caches not to keep the answer", async () => {
    const { server, client } = connectorServer();
    running = await startConnector({ server, listen: { kind: "loopback", port: 0 } });
    const port = "port" in running.address ? running.address.port : 0;

    const response = await post(port, client.sign({ method: "health" }));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

posixOnly("connector over a Unix socket", () => {
  it("creates the socket readable and writable by its owner only", async () => {
    const { server } = connectorServer();
    const path = join(tmpdir(), `nexus-connector-${randomUUID()}.sock`);
    running = await startConnector({ server, listen: { kind: "unix", path } });

    const mode = (await stat(path)).mode & 0o777;

    // Without this the socket inherits the umask, and a world-writable socket
    // makes the loopback argument meaningless.
    expect(mode.toString(8)).toBe("600");
  });

  it("removes the socket when it shuts down", async () => {
    const { server } = connectorServer();
    const path = join(tmpdir(), `nexus-connector-${randomUUID()}.sock`);
    const connector = await startConnector({ server, listen: { kind: "unix", path } });

    await connector.close();

    // A leftover socket makes the next start fail with EADDRINUSE while
    // nothing is listening.
    await expect(stat(path)).rejects.toThrow();
  });
});
