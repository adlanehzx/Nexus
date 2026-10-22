import { describe, expect, it } from "vitest";
import { ConnectionDetector, type DetectionAuditEvent } from "../src/detect.js";
import { FORBIDDEN_CONNECTION_FIELDS, connectionSchema } from "../src/model.js";
import { NodeProcessPort, SystemClock } from "../src/node-process.js";
import { SafeCommandRunner } from "../src/probes.js";
import { ProviderRegistry, type ProviderDefinition } from "../src/registry.js";
import { createFakeBinDir, fakeSecret } from "./fake-binaries.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

/** A provider whose probes point at fake binaries in a temporary directory. */
function fixtureProvider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
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
        // `undefined` means "unrecognised output", which is a different answer
        // from "recognised, no version", so it must not be spelled as a
        // present-but-undefined property.
        return version === undefined ? undefined : { version };
      },
    },
    actions: ["detect", "test"],
    ...overrides,
  };
}

function detectorFor(dir: string, provider: ProviderDefinition, platform = "linux" as const) {
  const audit: DetectionAuditEvent[] = [];
  const detector = new ConnectionDetector({
    registry: new ProviderRegistry([provider]),
    runner: new SafeCommandRunner({
      process: new NodeProcessPort({ path: dir, platform: "linux" }),
      clock: new SystemClock(),
    }),
    clock: new SystemClock(),
    platform,
    onAudit: (event) => audit.push(event),
  });
  return { detector, audit };
}

posixOnly("connection detection", () => {
  it("reports a missing tool as not installed, needing a person", async () => {
    const bin = await createFakeBinDir();
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("not_installed");
    expect(connection.errorCategory).toBe("not_found");
    expect(connection.requiresHumanAction).toBe(true);
    expect(connection.executablePath).toBeNull();
    expect(connection.lastSuccessAt).toBeNull();
  });

  it("reaches detected, and no further, on a successful presence probe", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    const connection = await detector.detect("fixture");

    // Installed and runnable is not the same claim as signed in, and the model
    // refuses to blur them.
    expect(connection.state).toBe("detected");
    expect(connection.version).toBe("2.3.4");
    expect(connection.executablePath).toContain("fixture");
    expect(connection.lastSuccessAt).not.toBeNull();
    expect(connection.requiresHumanAction).toBe(false);
  });

  it("does not call a tool connected just because its binary exists", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    expect((await detector.detect("fixture")).state).not.toBe("connected");
  });

  it("says invalid_output when a tool answers in a form it does not recognise", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "who knows"');
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("error");
    expect(connection.errorCategory).toBe("invalid_output");
    // The sentence must point at NEXUS, not send someone to reinstall a working tool.
    expect(connection.userMessage).toContain("NEXUS does not recognise");
  });

  it("turns a sign-in failure into authentication_required", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "not logged in" >&2; exit 1');
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("authentication_required");
    expect(connection.requiresHumanAction).toBe(true);
  });

  it("reaches connected only through a verified session probe", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    await bin.write("fixture-session", 'echo "status: active"');
    const { detector } = detectorFor(
      bin.dir,
      fixtureProvider({
        authenticate: {
          command: { file: "fixture-session", args: [] },
          verification: "verified",
          interpret: (stdout) => ({ authenticated: stdout.includes("active") }),
        },
      }),
    );

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("connected");
    expect(connection.lastSuccessAt).not.toBeNull();
  });

  it("caps an unverified session probe at detected even when it claims success", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    await bin.write("fixture-session", 'echo "status: active"');
    const { detector } = detectorFor(
      bin.dir,
      fixtureProvider({
        authenticate: {
          command: { file: "fixture-session", args: [] },
          verification: "unverified",
          interpret: (stdout) => ({ authenticated: stdout.includes("active") }),
        },
      }),
    );

    // A parser nobody has checked against the real tool is not evidence.
    expect((await detector.detect("fixture")).state).toBe("detected");
  });

  it("asks for a sign-in when a session probe says there is no session", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    await bin.write("fixture-session", 'echo "status: none"');
    const { detector } = detectorFor(
      bin.dir,
      fixtureProvider({
        authenticate: {
          command: { file: "fixture-session", args: [] },
          verification: "verified",
          interpret: (stdout) => ({ authenticated: stdout.includes("active") }),
        },
      }),
    );

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("authentication_required");
    expect(connection.lastSuccessAt).toBeNull();
  });

  it("calls a quota-limited tool degraded rather than broken", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    await bin.write("fixture-session", 'echo "429 rate limit exceeded" >&2; exit 1');
    const { detector } = detectorFor(
      bin.dir,
      fixtureProvider({
        authenticate: {
          command: { file: "fixture-session", args: [] },
          verification: "verified",
          interpret: () => ({ authenticated: true }),
        },
      }),
    );

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("degraded");
    expect(connection.errorCategory).toBe("quota_exhausted");
  });

  it("runs nothing at all on a platform a provider does not support", async () => {
    const bin = await createFakeBinDir();
    // Present and working — and still not probed, because the provider says it
    // does not run here.
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector } = detectorFor(bin.dir, fixtureProvider({ platforms: ["win32"] }), "linux");

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("not_installed");
    expect(connection.errorCategory).toBe("unsupported_platform");
    expect(connection.version).toBeNull();
  });

  it("never carries a credential a tool printed into the connection or the audit trail", async () => {
    const secret = fakeSecret();
    const bin = await createFakeBinDir();
    await bin.write("fixture", `echo "fixture 2.3.4 token=${secret}"`);
    const { detector, audit } = detectorFor(bin.dir, fixtureProvider());

    const connection = await detector.detect("fixture");

    const serialised = JSON.stringify(connection);
    expect(serialised).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(secret);
    for (const field of FORBIDDEN_CONNECTION_FIELDS) {
      expect(Object.keys(connection)).not.toContain(field);
    }
  });

  it("records every state change it made, and nothing a tool printed", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector, audit } = detectorFor(bin.dir, fixtureProvider());

    await detector.detect("fixture");

    expect(audit.map((event) => event.toState)).toEqual(["testing", "detected"]);
    for (const event of audit) {
      expect(Object.keys(event).toSorted()).toEqual([
        "at",
        "durationMs",
        "errorCategory",
        "fromState",
        "probeVerification",
        "providerId",
        "toState",
      ]);
    }
  });

  it("returns a value the schema accepts", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    const connection = await detector.detect("fixture");

    expect(() => connectionSchema.parse(connection)).not.toThrow();
  });

  it("refuses to detect a provider the registry does not know", async () => {
    const bin = await createFakeBinDir();
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    await expect(detector.detect("not-registered")).rejects.toThrow(
      /No connection provider is registered/,
    );
  });

  it("detects each supported provider once", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector } = detectorFor(bin.dir, fixtureProvider());

    const connections = await detector.detectAll();

    expect(connections).toHaveLength(1);
    expect(connections[0]?.providerId).toBe("fixture");
  });
});

posixOnly("output a provider's own answer cannot be represented", () => {
  it("refuses the connection instead of throwing out of a detection sweep", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector } = detectorFor(
      bin.dir,
      // A version far longer than the model allows: the shape of a tool that
      // prints a banner, or a stack trace, where a version belongs.
      fixtureProvider({
        detect: {
          command: { file: "fixture", args: ["--version"] },
          verification: "verified",
          interpret: () => ({ version: "9".repeat(500) }),
        },
      }),
    );

    const connection = await detector.detect("fixture");

    expect(connection.state).toBe("error");
    expect(connection.errorCategory).toBe("invalid_output");
    expect(connection.version).toBeNull();
  });

  it("still returns something the schema accepts", async () => {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 2.3.4"');
    const { detector } = detectorFor(
      bin.dir,
      fixtureProvider({
        detect: {
          command: { file: "fixture", args: ["--version"] },
          verification: "verified",
          interpret: () => ({ capabilities: ["x".repeat(200)] }),
        },
      }),
    );

    const connection = await detector.detect("fixture");

    expect(() => connectionSchema.parse(connection)).not.toThrow();
    expect(connection.capabilities).toEqual([]);
  });
});
