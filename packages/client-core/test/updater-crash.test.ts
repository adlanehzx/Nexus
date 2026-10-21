import { describe, expect, it } from "vitest";
import { CrashReporter, InMemoryCrashStore } from "../src/crash.js";
import { UpdatePolicy, type ReleaseEntry } from "../src/updater.js";

/**
 * Auto-update is a code execution vector: rejection rules are the primary focus of tests.
 * Crash reports contain paths, names, and context fragments: tests verify no secrets
 * are leaked and disk capacity is protected.
 */

const release = (overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version: "1.3.0",
  channel: "stable",
  signature: "sig",
  url: "https://example.test/nexus-1.3.0.AppImage",
  publishedAt: 1,
  ...overrides,
});

describe("updates: proposed releases", () => {
  it("proposes the latest release from the channel", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    const decision = policy.decide([release({ version: "1.1.0" }), release({ version: "1.2.0" })]);
    expect(decision.kind).toBe("available");
    if (decision.kind === "available") expect(decision.release.version).toBe("1.2.0");
  });

  it("returns none when already up to date", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.3.0" });
    expect(policy.decide([release()]).kind).toBe("none");
  });
});

describe("updates: rejections", () => {
  it("rejects unsigned releases", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    const decision = policy.decide([release({ signature: null })]);
    expect(decision).toMatchObject({ kind: "rejected", reason: "unsigned release" });
  });

  it("rejects empty signature", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    expect(policy.decide([release({ signature: "" })]).kind).toBe("rejected");
  });

  it("never allows downgrades", () => {
    const policy = new UpdatePolicy({ currentVersion: "2.0.0" });
    expect(policy.decide([release({ version: "1.9.0" })]).kind).toBe("none");
  });

  it("does not change channels silently", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0", channel: "stable" });
    expect(policy.decide([release({ version: "2.0.0", channel: "beta" })]).kind).toBe("none");
  });

  it("requires consent for major version updates", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.5.0" });
    const decision = policy.decide([release({ version: "2.0.0" })]);
    expect(decision.kind).toBe("consent-required");
  });

  it("applies major release when consent is granted", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.5.0", allowMajor: true });
    expect(policy.decide([release({ version: "2.0.0" })]).kind).toBe("available");
  });

  it("rejects decision if installed version is unparseable", () => {
    const policy = new UpdatePolicy({ currentVersion: "not-a-version" });
    expect(policy.decide([release()]).kind).toBe("rejected");
  });

  it("ignores malformed feed entry rather than aborting", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    const decision = policy.decide([release({ version: "not-a-version" }), release()]);
    expect(decision.kind).toBe("available");
  });

  it("does not expose any installation methods", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    for (const method of ["install", "apply", "download", "run"]) {
      expect(method in policy, method).toBe(false);
    }
  });
});

describe("crash telemetry", () => {
  const reporter = (options: { capacity?: number } = {}) =>
    new CrashReporter({
      store: new InMemoryCrashStore(),
      version: "1.2.3",
      now: () => 1_000,
      newId: (() => {
        let index = 0;
        return () => {
          index += 1;
          return `crash-${String(index)}`;
        };
      })(),
      ...options,
    });

  it("records error kind, message and stack", async () => {
    const crashes = reporter();
    const report = await crashes.record(new TypeError("x.y is not a function"));
    expect(report.kind).toBe("TypeError");
    expect(report.message).toContain("is not a function");
    expect(report.version).toBe("1.2.3");
  });

  it("redacts secrets from message, stack, and context", async () => {
    const crashes = reporter();
    const token = `sk-${"a".repeat(32)}`;
    const report = await crashes.record(new Error(`failure with ${token}`), {
      url: `https://example.test/?token=${token}`,
    });

    expect(report.message).not.toContain(token);
    expect(report.message).toContain("[REDACTED]");
    expect(JSON.stringify(report.context)).not.toContain(token);
  });

  it("counts occurrences instead of duplicating entries", async () => {
    const crashes = reporter();
    const boom = new Error("always the same");
    await crashes.record(boom);
    await crashes.record(boom);
    const reports = await crashes.list();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.occurrences).toBe(2);
  });

  it("bounds maximum retained reports", async () => {
    const crashes = reporter({ capacity: 2 });
    for (const index of [1, 2, 3]) await crashes.record(new Error(`error ${String(index)}`));
    expect(await crashes.list()).toHaveLength(2);
  });

  it("bounds stack trace length", async () => {
    const crashes = new CrashReporter({
      store: new InMemoryCrashStore(),
      version: "1.2.3",
      maxStackChars: 100,
    });
    const error = new Error("long");
    error.stack = "x".repeat(5_000);
    const report = await crashes.record(error);
    expect(report.stack).toContain("truncated");
    expect(report.stack.length).toBeLessThan(200);
  });

  it("formats readable report without network transmission", async () => {
    const crashes = reporter();
    const report = await crashes.record(new Error("crash"), { screen: "conversation" });
    const text = await crashes.share(report.id);

    expect(text).toContain("NEXUS 1.2.3");
    expect(text).toContain("crash");
    expect(text).toContain("screen: conversation");
    expect("send" in crashes).toBe(false);
    expect("upload" in crashes).toBe(false);
  });

  it("returns undefined for unknown report", async () => {
    const crashes = reporter();
    expect(await crashes.share("missing")).toBeUndefined();
  });

  it("clears on request", async () => {
    const crashes = reporter();
    await crashes.record(new Error("x"));
    await crashes.clear();
    expect(await crashes.list()).toHaveLength(0);
  });
});
