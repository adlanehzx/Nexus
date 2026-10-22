import { randomUUID } from "node:crypto";
import {
  ConnectionDetector,
  NodeProcessPort,
  ProviderRegistry,
  SafeCommandRunner,
  SystemClock,
  type ProviderDefinition,
} from "@nexus/connections";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NonceStore, RequestAuthenticator } from "../src/auth.js";
import {
  canonicalJson,
  canonicalRequestBytes,
  connectorMethodSchema,
  connectorRequestSchema,
} from "../src/protocol.js";
import { ConnectorServer, type ConnectorAuditEvent } from "../src/server.js";
import { createTestClient } from "./client.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

async function fakeToolDir(output = 'echo "fixture 1.2.3"'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-connector-"));
  const path = join(dir, "fixture");
  await writeFile(path, `#!/bin/sh\n${output}\n`, "utf8");
  await chmod(path, 0o755);
  return dir;
}

const FIXTURE_PROVIDER: ProviderDefinition = {
  id: "fixture",
  displayName: "Fixture Tool",
  kind: "acp",
  platforms: ["linux", "darwin", "win32"],
  adapter: { provenance: "community", provenanceEvidence: "test fixture, not a real adapter" },
  detect: {
    command: { file: "fixture", args: ["--version"] },
    verification: "verified",
    interpret: (stdout) => {
      const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
      return version === undefined ? undefined : { version };
    },
  },
  actions: ["detect", "test"],
};

interface Harness {
  server: ConnectorServer;
  audit: ConnectorAuditEvent[];
  client: ReturnType<typeof createTestClient>;
  now: () => number;
}

async function harness(
  options: { dir?: string; now?: () => number; acceptanceWindowMs?: number } = {},
): Promise<Harness> {
  const dir = options.dir ?? (await fakeToolDir());
  const client = createTestClient();
  const audit: ConnectorAuditEvent[] = [];
  const now = options.now ?? (() => Date.now());
  const detector = new ConnectionDetector({
    registry: new ProviderRegistry([FIXTURE_PROVIDER]),
    runner: new SafeCommandRunner({
      process: new NodeProcessPort({ path: dir, platform: "linux" }),
      clock: new SystemClock(),
    }),
    clock: new SystemClock(),
    platform: "linux",
  });
  const server = new ConnectorServer({
    detector,
    authenticator: new RequestAuthenticator({
      clients: [{ clientId: client.clientId, publicKey: client.publicKey }],
      now,
      ...(options.acceptanceWindowMs === undefined
        ? {}
        : { acceptanceWindowMs: options.acceptanceWindowMs }),
    }),
    now,
    onAudit: (event) => audit.push(event),
  });
  return { server, audit, client, now };
}

describe("protocol surface", () => {
  it("offers no way to name a command", () => {
    // The central property of this protocol: the method set is closed and
    // nothing in it takes an executable, an argument list or a shell string.
    expect(connectorMethodSchema.options).toEqual([
      "health",
      "capabilities",
      "connection.list",
      "connection.detect",
      "connection.test",
    ]);
    for (const method of connectorMethodSchema.options) {
      expect(method).not.toMatch(/exec|shell|command|spawn|eval/i);
    }
  });

  it("refuses a parameter nobody declared instead of ignoring it", () => {
    const client = createTestClient();
    const request = client.sign({ method: "connection.detect", providerId: "fixture" });

    const tampered = { ...request, params: { ...request.params, timeoutMs: 999_999 } };

    // Silently dropping it is how an option ends up believed-set and unset.
    expect(connectorRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it("binds the method into the signed bytes", () => {
    const base = {
      protocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: "0".repeat(32),
      clientId: "c",
    };
    const list = canonicalRequestBytes({
      ...base,
      method: "connection.list",
      params: { method: "connection.list" },
    });
    const detect = canonicalRequestBytes({
      ...base,
      method: "connection.detect",
      params: { method: "connection.detect" },
    });

    expect(list.equals(detect)).toBe(false);
  });

  it("produces the same bytes regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("serialises nested objects deterministically", () => {
    // The array-replacer form of JSON.stringify would drop `d` here, because it
    // applies the top-level key list at every depth.
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });
});

describe("nonce store", () => {
  it("accepts a nonce once", () => {
    const store = new NonceStore(1_000);

    expect(store.remember("n", 0)).toBe(true);
    expect(store.remember("n", 0)).toBe(false);
  });

  it("forgets a nonce once its window has passed", () => {
    const store = new NonceStore(1_000);
    store.remember("n", 0);

    // Not a weakness: the timestamp check refuses the old request anyway, and
    // remembering every nonce forever is an unbounded map.
    expect(store.remember("n", 1_001)).toBe(true);
    expect(store.size).toBe(1);
  });
});

posixOnly("connector server", () => {
  it("answers health and states which versions it speaks", async () => {
    const { server, client } = await harness();

    const response = await server.handle(client.sign({ method: "health" }));

    expect(response.ok).toBe(true);
    expect(response.ok && response.result).toMatchObject({
      status: "ok",
      supportedVersions: [1],
    });
  });

  it("echoes the request id so a caller can correlate", async () => {
    const { server, client } = await harness();
    const request = client.sign({ method: "health" });

    const response = await server.handle(request);

    expect(response.requestId).toBe(request.requestId);
  });

  it("refuses a protocol version it does not implement", async () => {
    const { server, client } = await harness();

    const response = await server.handle(
      client.sign({ method: "health" }, { protocolVersion: 99 }),
    );

    expect(response.ok).toBe(false);
    expect(!response.ok && response.error.code).toBe("unsupported_protocol_version");
  });

  it("mints a request id for a body too malformed to carry one", async () => {
    const { server, audit } = await harness();

    const response = await server.handle({ nonsense: true });

    expect(!response.ok && response.error.code).toBe("malformed_request");
    // Still traceable, and still audited.
    expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit.at(-1)?.ok).toBe(false);
    expect(audit.at(-1)?.clientId).toBeNull();
  });

  it("refuses an unknown client", async () => {
    const { server } = await harness();
    const stranger = createTestClient("not-registered");

    const response = await server.handle(stranger.sign({ method: "health" }));

    expect(!response.ok && response.error.code).toBe("unauthenticated");
  });

  it("refuses a signature that does not verify", async () => {
    const { server, client } = await harness();
    const forged = client.sign({ method: "health" }, { signature: "AAAA" });

    const response = await server.handle(forged);

    expect(!response.ok && response.error.code).toBe("unauthenticated");
  });

  it("refuses a signature captured from a different method", async () => {
    // The attack the canonical encoding exists to stop: observe a harmless
    // `connection.list`, reuse its signature to make the connector run probes.
    const { server, client } = await harness();
    const harmless = client.sign({ method: "connection.list" });

    const escalated = await server.handle({
      ...harmless,
      params: { method: "connection.detect" },
    });

    expect(!escalated.ok && escalated.error.code).toBe("unauthenticated");
  });

  it("refuses a replayed request", async () => {
    const { server, client } = await harness();
    const request = client.sign({ method: "health" });

    expect((await server.handle(request)).ok).toBe(true);
    const replayed = await server.handle(request);

    expect(!replayed.ok && replayed.error.code).toBe("replayed_request");
  });

  it("refuses a request older than the acceptance window", async () => {
    const { server, client } = await harness({ acceptanceWindowMs: 1_000 });
    const stale = client.sign(
      { method: "health" },
      { issuedAt: new Date(Date.now() - 60_000).toISOString() },
    );

    const response = await server.handle(stale);

    expect(!response.ok && response.error.code).toBe("expired_request");
  });

  it("refuses a request dated in the future", async () => {
    const { server, client } = await harness();
    const ahead = client.sign(
      { method: "health" },
      { issuedAt: new Date(Date.now() + 10 * 60_000).toISOString() },
    );

    const response = await server.handle(ahead);

    // Accepting it would extend how long a captured request stays usable.
    expect(!response.ok && response.error.code).toBe("expired_request");
  });

  it("does not burn a nonce on a request that failed to authenticate", async () => {
    const { server, client } = await harness();
    const nonce = randomBytes(16).toString("hex");
    await server.handle(client.sign({ method: "health" }, { nonce, signature: "AAAA" }));

    // Otherwise an eavesdropper could deny the real client its own request by
    // replaying it badly first.
    const legitimate = await server.handle(client.sign({ method: "health" }, { nonce }));

    expect(legitimate.ok).toBe(true);
  });

  it("gives the same message whatever the reason for refusing", async () => {
    const { server, client } = await harness({ acceptanceWindowMs: 1_000 });
    const stranger = createTestClient("not-registered");
    const reused = client.sign({ method: "health" });
    await server.handle(reused);

    const messages = await Promise.all(
      [
        stranger.sign({ method: "health" }),
        client.sign({ method: "health" }, { signature: "AAAA" }),
        reused,
        client.sign(
          { method: "health" },
          { issuedAt: new Date(Date.now() - 60_000).toISOString() },
        ),
      ].map(async (request) => {
        const response = await server.handle(request);
        return response.ok ? "accepted" : response.error.message;
      }),
    );

    // A caller must not be able to tell "wrong key" from "stale" from
    // "replayed": each distinction narrows down what to change.
    expect(new Set(messages).size).toBe(1);
  });

  it("detects a provider and reports it without running anything on a list", async () => {
    const { server, client, audit } = await harness();

    const detected = await server.handle(
      client.sign({ method: "connection.detect", providerId: "fixture" }),
    );
    const listed = await server.handle(client.sign({ method: "connection.list" }));

    expect(detected.ok).toBe(true);
    expect(listed.ok && (listed.result as { connections: unknown[] }).connections).toHaveLength(1);
    // The audit distinguishes a request that spawned a process from one that
    // only reported what was already observed.
    expect(audit.map((event) => event.executed)).toEqual([true, false]);
  });

  it("refuses to detect a provider the registry does not know", async () => {
    const { server, client } = await harness();

    const response = await server.handle(
      client.sign({ method: "connection.detect", providerId: "nope" }),
    );

    expect(!response.ok && response.error.code).toBe("unknown_provider");
  });

  it("never returns a credential a tool printed, nor records one", async () => {
    const secret = `sk-${randomBytes(24).toString("hex")}`;
    const dir = await fakeToolDir(`echo "fixture 1.2.3 token=${secret}"`);
    const { server, client, audit } = await harness({ dir });

    const response = await server.handle(
      client.sign({ method: "connection.detect", providerId: "fixture" }),
    );

    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("records who asked, for what, and what happened — and nothing else", async () => {
    const { server, client, audit } = await harness();

    await server.handle(client.sign({ method: "connection.test", providerId: "fixture" }));

    expect(Object.keys(audit[0] ?? {}).toSorted()).toEqual([
      "at",
      "clientId",
      "durationMs",
      "errorCode",
      "executed",
      "method",
      "ok",
      "providerId",
      "requestId",
    ]);
    expect(audit[0]?.providerId).toBe("fixture");
  });
});

describe("authenticator ordering", () => {
  it("checks the timestamp before spending a signature verification", async () => {
    // Order is a denial-of-service property: verifying first would let an
    // unauthenticated caller spend CPU at will with stale requests.
    const { server, client } = await harness({ acceptanceWindowMs: 1_000 });
    const stale = client.sign(
      { method: "health" },
      { issuedAt: new Date(Date.now() - 60_000).toISOString(), signature: "AAAA" },
    );

    const response = await server.handle(stale);

    // A bad signature on a stale request reports the timestamp, which is only
    // possible if the timestamp was checked first.
    expect(!response.ok && response.error.code).toBe("expired_request");
  });
});
