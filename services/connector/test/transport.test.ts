import { connect } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ConnectionDetector,
  NodeProcessPort,
  ProviderRegistry,
  SafeCommandRunner,
  SystemClock,
} from "@nexus/connections";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequestAuthenticator } from "../src/auth.js";
import {
  DEFAULT_HTTP_LIMITS,
  startConnector,
  type ConnectorDispatcher,
  type ConnectorHttpLimits,
  type RunningConnector,
} from "../src/http.js";
import { connectorMethodSchema, type ConnectorParams } from "../src/protocol.js";
import { ConnectorServer } from "../src/server.js";
import { createTestClient } from "./client.js";

/**
 * Bounded transport behaviour.
 *
 * Every limit is injected, and small. A test that needed fifteen seconds to
 * show a fifteen-second timeout would be deleted by the first person in a
 * hurry, and a test that waits on a real timeout is the classic flaky one.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

let running: RunningConnector | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** A tool that takes long enough to still be running when the next request arrives. */
async function slowToolDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-transport-"));
  const path = join(dir, "fixture");
  await writeFile(path, '#!/bin/sh\nsleep 0.4\necho "fixture 1.2.3"\n', "utf8");
  await chmod(path, 0o755);
  return dir;
}

function connectorFor(options: { dir?: string; maxConcurrentExecutions?: number } = {}): {
  server: ConnectorServer;
  client: ReturnType<typeof createTestClient>;
} {
  const client = createTestClient();
  const detector = new ConnectionDetector({
    registry: new ProviderRegistry([
      {
        id: "fixture",
        displayName: "Fixture Tool",
        kind: "acp",
        platforms: ["linux", "darwin"],
        adapter: {
          provenance: "community",
          provenanceEvidence: "test fixture, not a real adapter",
        },
        detect: {
          command: { file: "fixture", args: ["--version"] },
          verification: "verified",
          interpret: (stdout) => {
            const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
            return version === undefined ? undefined : { version };
          },
        },
        actions: ["detect", "test"],
      },
    ]),
    runner: new SafeCommandRunner({
      process: new NodeProcessPort({ path: options.dir ?? "", platform: "linux" }),
      clock: new SystemClock(),
    }),
    clock: new SystemClock(),
    platform: "linux",
  });
  const server = new ConnectorServer({
    detector,
    authenticator: new RequestAuthenticator({
      clients: [{ clientId: client.clientId, publicKeys: [client.publicKey] }],
    }),
    ...(options.maxConcurrentExecutions === undefined
      ? {}
      : { maxConcurrentExecutions: options.maxConcurrentExecutions }),
  });
  return { server, client };
}

async function start(
  dispatcher: ConnectorDispatcher,
  limits: Partial<ConnectorHttpLimits> = {},
): Promise<number> {
  running = await startConnector({
    server: dispatcher,
    listen: { kind: "loopback", port: 0 },
    limits,
  });
  return "port" in running.address ? running.address.port : 0;
}

async function post(port: number, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${String(port)}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

posixOnly("a rejected handler cannot take the process down", () => {
  it("answers 500 with a fixed message and no exception detail", async () => {
    const secret = `sk-${randomBytes(24).toString("hex")}`;
    const port = await start({
      handle: () => Promise.reject(new Error(`exploded at /home/someone/.config with ${secret}`)),
    });

    const response = await post(port, { anything: true });
    const text = await response.text();

    expect(response.status).toBe(500);
    // Without the catch in the createServer callback this would be an unhandled
    // rejection, which by default ends the process — a denial-of-service hole
    // reachable with one malformed request.
    expect(text).not.toContain(secret);
    expect(text).not.toContain("exploded");
    expect(text).not.toContain("/home/someone");
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
  });

  it("keeps serving after one request blew up", async () => {
    let first = true;
    const port = await start({
      handle: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve({
          ok: true as const,
          protocolVersion: 1,
          requestId: randomUUID(),
          result: { status: "ok" },
        });
      },
    });

    expect((await post(port, {})).status).toBe(500);
    expect((await post(port, {})).status).toBe(200);
  });

  it("keeps an error response JSON, uncached and secret-free", async () => {
    const port = await start({ handle: () => Promise.reject(new Error("sk-should-not-appear")) });

    const response = await post(port, {});

    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).not.toContain("sk-should-not-appear");
  });
});

posixOnly("body size is bounded twice", () => {
  it("refuses a declared length over the limit before reading anything", async () => {
    const { server } = connectorFor();
    const port = await start(server, { maxBodyBytes: 256 });

    // fetch sets content-length itself; the body is genuinely that long.
    const response = await post(port, { padding: "x".repeat(2_000) });

    expect(response.status).toBe(413);
  });

  it("refuses an oversized body that declared no length at all", async () => {
    const { server } = connectorFor();
    const port = await start(server, { maxBodyBytes: 256 });

    // Chunked encoding: there is no content-length to check, so only the
    // streaming limit stands between the connector and an unbounded read.
    const response = await fetch(`http://127.0.0.1:${String(port)}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Required by the fetch spec for a streaming body, and absent from the
      // DOM lib types this repository compiles against.
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          // Valid JSON on purpose. An invalid body would be refused for being
          // unparseable, and the test would pass with no size limit at all —
          // which is exactly what a mutation run revealed about the first
          // version of this test.
          controller.enqueue(new TextEncoder().encode(`{"padding":"${"x".repeat(4_000)}"}`));
          controller.close();
        },
      }),
    }).catch((error: unknown) => error);

    // The socket is destroyed mid-read, so a transport error is the usual
    // outcome. What must not happen is a 200: that would mean the oversized
    // body was read and dispatched.
    if (response instanceof Response) expect(response.status).not.toBe(200);
    else expect(response).toBeInstanceOf(Error);
  });

  it("refuses a body whose declared length is a lie", async () => {
    const { server } = connectorFor();
    const port = await start(server, { maxBodyBytes: 256 });

    // Declares 10 bytes, sends far more. A single check on the header would
    // wave this through.
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /rpc HTTP/1.1\r\nHost: localhost\r\n" +
            "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
        );
        // Valid JSON, so the only thing that can refuse it is its size.
        const payload = `{"padding":"${"x".repeat(4000)}"}`;
        socket.write(`${payload.length.toString(16)}\r\n${payload}\r\n`);
      });
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString("utf8")));
      socket.on("close", () => resolve(received));
      socket.on("error", () => resolve(received));
      setTimeout(() => {
        socket.destroy();
        resolve(received);
      }, 2_000);
    });

    // Either refused with a status, or the socket was torn down with no
    // response at all. A 200 would mean the oversized body was accepted.
    expect(outcome).not.toContain(" 200 ");
  });

  it("accepts a request comfortably inside the limit", async () => {
    const { server, client } = connectorFor();
    const port = await start(server, { maxBodyBytes: 64 * 1024 });

    expect((await post(port, client.sign({ method: "health" }))).status).toBe(200);
  });
});

posixOnly("time is bounded", () => {
  it("ships a bounded default for every limit", () => {
    // Guards the defaults themselves: a zero or a missing entry here would
    // silently mean "no limit" in production while every test passes, because
    // the tests inject their own.
    for (const [name, value] of Object.entries(DEFAULT_HTTP_LIMITS)) {
      expect(value, name).toBeGreaterThan(0);
      expect(Number.isFinite(value), name).toBe(true);
    }
    // And specifically that the resolution is finer than the timeouts it
    // applies, or the timeouts are aspirational.
    expect(DEFAULT_HTTP_LIMITS.connectionsCheckingIntervalMs).toBeLessThan(
      DEFAULT_HTTP_LIMITS.headersTimeoutMs,
    );
  });

  it("terminates a connection that sends headers and then stalls", async () => {
    const { server } = connectorFor();
    // The checking interval is what makes the timeout actually land quickly;
    // without it Node would only notice up to 30 seconds later.
    const port = await start(server, {
      headersTimeoutMs: 300,
      requestTimeoutMs: 400,
      connectionsCheckingIntervalMs: 100,
    });

    const outcome = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        // A request line and nothing more, forever.
        socket.write("POST /rpc HTTP/1.1\r\nHost: localhost\r\n");
      });
      let received = "";
      // The data listener is not decoration: without it the socket stays
      // paused, the server's response and FIN sit unread, and `close` never
      // arrives — which looks exactly like a server that failed to time out.
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(received));
      socket.on("error", () => resolve(received));
      // Generous relative to the 300 ms limit, still fast.
      setTimeout(() => {
        socket.destroy();
        resolve("TIMED OUT WAITING");
      }, 3_000);
    });

    // Node answers a stalled request with 408 and closes. Asserting on the
    // status is better evidence than "the socket shut" — it shows the timeout
    // fired rather than something else dropping the connection.
    expect(outcome).toContain("408");
  });

  it("terminates a connection that completes its headers and then stalls mid-body", async () => {
    const { server } = connectorFor();
    // Headers finish, so `headersTimeout` is satisfied and only
    // `requestTimeout` can end this. Without a separate test for it, the two
    // timeouts cover for each other and either could be removed unnoticed.
    const port = await start(server, {
      headersTimeoutMs: 2_000,
      requestTimeoutMs: 300,
      connectionsCheckingIntervalMs: 100,
    });

    const outcome = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /rpc HTTP/1.1\r\nHost: localhost\r\n" +
            "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n",
        );
        // Announces 100 bytes, sends 2, then goes quiet.
        socket.write("{}");
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(received));
      socket.on("error", () => resolve(received));
      setTimeout(() => {
        socket.destroy();
        resolve("TIMED OUT WAITING");
      }, 3_000);
    });

    expect(outcome).toContain("408");
  });
});

posixOnly("concurrent probe execution is bounded", () => {
  it("refuses a third probe while two are running", async () => {
    const dir = await slowToolDir();
    const { server, client } = connectorFor({ dir, maxConcurrentExecutions: 2 });
    const port = await start(server);

    const [a, b, c] = await Promise.all([
      post(port, client.sign({ method: "connection.detect", providerId: "fixture" })),
      post(port, client.sign({ method: "connection.detect", providerId: "fixture" })),
      post(port, client.sign({ method: "connection.detect", providerId: "fixture" })),
    ]);
    const bodies = await Promise.all([a.json(), b.json(), c.json()]);

    const refused = bodies.filter(
      (body) => (body as { error?: { code: string } }).error?.code === "capacity_exhausted",
    );
    expect(refused).toHaveLength(1);
  });

  it("does not count read-only methods against the limit", async () => {
    const { server, client } = connectorFor({ maxConcurrentExecutions: 1 });
    const port = await start(server);

    const responses = await Promise.all([
      post(port, client.sign({ method: "health" })),
      post(port, client.sign({ method: "capabilities" })),
      post(port, client.sign({ method: "connection.list" })),
    ]);
    const bodies = await Promise.all(responses.map(async (response) => response.json()));

    // These spawn nothing, so limiting them would protect nothing and make a
    // dashboard stutter.
    for (const body of bodies) expect(body).toMatchObject({ ok: true });
  });

  it("releases a slot even when a probe throws", async () => {
    // A counter that only decrements on success wedges the connector shut
    // after the first failure, which is the bug this kind of gate ships with.
    const { server, client } = connectorFor({ maxConcurrentExecutions: 1 });
    const port = await start(server);

    await post(port, client.sign({ method: "connection.detect", providerId: "nope" }));
    const after = await post(
      port,
      client.sign({ method: "connection.detect", providerId: "fixture" }),
    );

    expect(server.executing).toBe(0);
    expect(await after.json()).toMatchObject({ ok: true });
  });

  it("uses a stable code a client can branch on", async () => {
    const dir = await slowToolDir();
    const { server, client } = connectorFor({ dir, maxConcurrentExecutions: 1 });
    const port = await start(server);

    const [, second] = await Promise.all([
      post(port, client.sign({ method: "connection.test", providerId: "fixture" })),
      post(port, client.sign({ method: "connection.test", providerId: "fixture" })),
    ]);
    const body = (await second.json()) as { error?: { code: string; message: string } };

    expect(body.error?.code).toBe("capacity_exhausted");
    // Distinct from a generic failure, because the right response differs:
    // retry shortly, with nothing to fix.
    expect(body.error?.message).toMatch(/try again/i);
  });
});

posixOnly("the capacity gate sits behind authentication", () => {
  it("refuses an unsigned request for authentication, not for capacity", async () => {
    const dir = await slowToolDir();
    const { server, client } = connectorFor({ dir, maxConcurrentExecutions: 1 });
    const port = await start(server);

    // One real probe occupies the only slot, and an unsigned request arrives
    // while it runs.
    const occupied = post(
      port,
      client.sign({ method: "connection.detect", providerId: "fixture" }),
    );
    const unsigned = await post(port, {
      protocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString("hex"),
      clientId: "nobody",
      signature: "AAAA",
      params: { method: "connection.detect", providerId: "fixture" },
    });
    await occupied;
    const body = (await unsigned.json()) as { error?: { code: string } };

    // `capacity_exhausted` here would mean the gate ran first, which would let
    // an unauthenticated caller learn how busy the connector is — and would
    // make the limit bypassable by claiming a read-only method.
    expect(body.error?.code).toBe("authentication_failed");
  });

  it("does not let an unauthenticated request occupy a slot", async () => {
    const { server, client } = connectorFor({ maxConcurrentExecutions: 1 });
    const port = await start(server);

    await post(port, {
      protocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString("hex"),
      clientId: "nobody",
      signature: "AAAA",
      params: { method: "connection.detect", providerId: "fixture" },
    });

    expect(server.executing).toBe(0);
    const legitimate = await post(
      port,
      client.sign({ method: "connection.detect", providerId: "fixture" }),
    );
    expect(await legitimate.json()).toMatchObject({ ok: true });
  });
});

posixOnly("no method bypasses authentication", () => {
  it.each(connectorMethodSchema.options)("refuses an unsigned %s", async (method) => {
    const { server } = connectorFor();
    const port = await start(server);
    const params = (
      method === "connection.test" ? { method, providerId: "fixture" } : { method }
    ) as ConnectorParams;

    const response = await post(port, {
      protocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString("hex"),
      clientId: "nobody",
      signature: "AAAA",
      params,
    });
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };

    // Exhaustive over the method enum, so a read-only method added later
    // cannot quietly arrive outside the authentication path.
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("authentication_failed");
  });

  it("refuses even health without a signature", async () => {
    const { server } = connectorFor();
    const port = await start(server);

    const body = (await (await post(port, { params: { method: "health" } })).json()) as {
      ok: boolean;
    };

    expect(body.ok).toBe(false);
  });
});
