import { describe, expect, it } from "vitest";
import { NodeProcessPort, SystemClock } from "../src/node-process.js";
import {
  DEFAULT_ENV_ALLOWLIST,
  SafeCommandRunner,
  extendEnvAllowlist,
  classifyFailure,
  type ProbeAuditEntry,
} from "../src/probes.js";
import { FakeClock, createFakeBinDir, fakeSecret } from "./fake-binaries.js";

/**
 * These tests run real processes. They are the only way to assert the
 * properties that matter: a mocked spawn cannot be asked whether a shell
 * interpreted a semicolon.
 */
const posixOnly = process.platform === "win32" ? describe.skip : describe;

function runnerFor(dir: string, options: Partial<{ maxOutputChars: number }> = {}) {
  const audit: ProbeAuditEntry[] = [];
  const runner = new SafeCommandRunner({
    // A PATH containing only the temporary directory: the test cannot
    // accidentally pass by finding a real tool installed on the machine.
    process: new NodeProcessPort({ path: dir, platform: "linux" }),
    clock: new SystemClock(),
    onAudit: (entry) => audit.push(entry),
    ...options,
  });
  return { runner, audit };
}

posixOnly("SafeCommandRunner with real processes", () => {
  it("runs a declared command and returns its output", async () => {
    const bin = await createFakeBinDir();
    await bin.write("faketool", 'echo "faketool 1.4.2"');
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "faketool", args: ["--version"] });

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("faketool 1.4.2");
    expect(outcome.errorCategory).toBeNull();
  });

  it("does not let an argument become a second command", async () => {
    const bin = await createFakeBinDir();
    // Prints how many arguments it actually received. Under a shell, the
    // semicolon would end the command and `$#` would be 1 instead of 2 — and
    // `echo pwned` would run.
    await bin.write("argcount", 'echo "argc=$#"; echo "first=$1"');
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "argcount", args: ["a; echo pwned", "b"] });

    expect(outcome.stdout).toContain("argc=2");
    expect(outcome.stdout).toContain("first=a; echo pwned");
  });

  it("does not let a command substitution in an argument execute", async () => {
    const bin = await createFakeBinDir();
    await bin.write("argcount", 'echo "first=$1"');
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "argcount", args: ["$(echo pwned)"] });

    // The literal text, not its evaluation.
    expect(outcome.stdout).toBe("first=$(echo pwned)");
  });

  it("redacts a credential a provider prints on stdout", async () => {
    const secret = fakeSecret();
    const bin = await createFakeBinDir();
    await bin.write("leaky", `echo "logged in with ${secret}"`);
    const { runner, audit } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "leaky", args: [] });

    expect(outcome.stdout).not.toContain(secret);
    expect(outcome.stdout).toContain("[REDACTED]");
    // And the audit entry carries no output at all, redacted or otherwise.
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(Object.keys(audit[0] ?? {})).not.toContain("stdout");
  });

  it("redacts a credential a provider prints on stderr", async () => {
    const secret = fakeSecret();
    const bin = await createFakeBinDir();
    await bin.write("leaky", `echo "token=${secret}" >&2; exit 3`);
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "leaky", args: [] });

    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).not.toContain(secret);
    expect(outcome.stderr).toContain("[REDACTED]");
  });

  it("truncates output instead of holding whatever a provider decides to print", async () => {
    const bin = await createFakeBinDir();
    await bin.write("chatty", 'i=0; while [ $i -lt 200 ]; do echo "line $i"; i=$((i+1)); done');
    const { runner } = runnerFor(bin.dir, { maxOutputChars: 60 });

    const outcome = await runner.run({ file: "chatty", args: [] });

    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout).toContain("truncated");
    // 60 characters plus the truncation notice, nowhere near the full output.
    expect(outcome.stdout.length).toBeLessThan(140);
  });

  it("kills a process that exceeds its deadline", async () => {
    const bin = await createFakeBinDir();
    await bin.write("hang", "while true; do sleep 1; done");
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "hang", args: [], timeoutMs: 250 });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCategory).toBe("timeout");
    // Null, not 0: a killed process has no meaningful exit code, and reporting
    // one would let a caller mistake a timeout for a clean run.
    expect(outcome.exitCode).toBeNull();
  });

  it("does not hang on a provider that asks for input", async () => {
    const bin = await createFakeBinDir();
    // A tool prompting for a password. With an inherited stdin this blocks
    // forever; with stdin closed it reads EOF and exits.
    // The prompt text avoids the word "password" on purpose: redaction would
    // mask the value right after it, which is correct behaviour but would hide
    // the thing this test is looking at.
    await bin.write("prompt", 'printf "enter value: "; read -r answer; echo "eof:[$answer]"');
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "prompt", args: [], timeoutMs: 2_000 });

    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("eof:[]");
  });

  it("classifies a missing binary rather than throwing", async () => {
    const bin = await createFakeBinDir();
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run({ file: "absent", args: [] });

    expect(outcome.ok).toBe(false);
    expect(outcome.errorCategory).toBe("not_found");
  });

  it("hands the child only the environment it was given", async () => {
    const bin = await createFakeBinDir();
    // Echoes named variables rather than calling `env`: the child's PATH is
    // deliberately minimal, so the script must not depend on finding a binary.
    await bin.write("dumpenv", 'echo "HOME=$HOME"; echo "GITHUB_TOKEN=$GITHUB_TOKEN"');
    const { runner } = runnerFor(bin.dir);

    const outcome = await runner.run(
      { file: "dumpenv", args: [] },
      { PATH: bin.dir, HOME: "/nexus-fake-home", GITHUB_TOKEN: "must-not-be-inherited" },
    );

    expect(outcome.stdout).toContain("HOME=/nexus-fake-home");
    expect(outcome.stdout).not.toContain("must-not-be-inherited");
    expect(outcome.stdout).toContain("GITHUB_TOKEN=");
  });

  it("does not inherit the real process environment", async () => {
    const bin = await createFakeBinDir();
    await bin.write("dumpenv", 'echo "canary=$NEXUS_TEST_LEAK_CANARY"');
    const { runner } = runnerFor(bin.dir);
    // Set on the parent, and never passed as ambient input.
    process.env.NEXUS_TEST_LEAK_CANARY = "parent-only";
    try {
      const outcome = await runner.run({ file: "dumpenv", args: [] }, { PATH: bin.dir });
      expect(outcome.stdout).not.toContain("parent-only");
    } finally {
      delete process.env.NEXUS_TEST_LEAK_CANARY;
    }
  });
});

posixOnly("NodeProcessPort.which", () => {
  it("finds an executable on the given PATH", async () => {
    const bin = await createFakeBinDir();
    const path = await bin.write("findme", "exit 0");
    const port = new NodeProcessPort({ path: bin.dir, platform: "linux" });

    await expect(port.which("findme")).resolves.toBe(path);
  });

  it("does not report a file that exists but cannot be executed", async () => {
    const bin = await createFakeBinDir();
    await bin.writeNonExecutable("readable", "not a program");
    const port = new NodeProcessPort({ path: bin.dir, platform: "linux" });

    await expect(port.which("readable")).resolves.toBeUndefined();
  });

  it("refuses a relative path with a separator", async () => {
    const bin = await createFakeBinDir();
    await bin.write("findme", "exit 0");
    const port = new NodeProcessPort({ path: bin.dir, platform: "linux" });

    // Resolving this would make the answer depend on the working directory.
    await expect(port.which("./findme")).resolves.toBeUndefined();
    await expect(port.which("sub/findme")).resolves.toBeUndefined();
  });

  it("accepts an absolute path only when it is executable", async () => {
    const bin = await createFakeBinDir();
    const executable = await bin.write("abs-ok", "exit 0");
    const plain = await bin.writeNonExecutable("abs-no", "x");
    const port = new NodeProcessPort({ path: "", platform: "linux" });

    await expect(port.which(executable)).resolves.toBe(executable);
    await expect(port.which(plain)).resolves.toBeUndefined();
  });
});

describe("environment construction", () => {
  const runner = new SafeCommandRunner({
    process: new NodeProcessPort({ path: "", platform: "linux" }),
    clock: new FakeClock(),
  });

  it("keeps only allowlisted names", () => {
    const env = runner.buildEnv({
      PATH: "/usr/bin",
      HOME: "/nexus-fake-home",
      SOMETHING_ELSE: "x",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/nexus-fake-home" });
  });

  it("drops a secret-shaped name even when a provider asks for it", () => {
    const env = runner.buildEnv({ PATH: "/usr/bin" }, { MY_API_KEY: "x", FEATURE_FLAG: "on" });

    expect(env.MY_API_KEY).toBeUndefined();
    expect(env.FEATURE_FLAG).toBe("on");
  });

  it.each([
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "ANTHROPIC_API_KEY",
    "DB_PASSWORD",
    "SESSION_ID",
    "MY_PRIVATE_KEY",
    "COOKIE_JAR",
    "AUTH_HEADER",
  ])("never passes %s through", (name) => {
    // Passed both as ambient and as an explicit provider request: neither path
    // may admit it.
    expect(runner.buildEnv({ [name]: "v" })[name]).toBeUndefined();
    expect(runner.buildEnv({}, { [name]: "v" })[name]).toBeUndefined();
  });

  it("does not include an allowlisted name that is unset", () => {
    expect(runner.buildEnv({})).toEqual({});
  });

  it("declares no secret-shaped name in its own allowlist", () => {
    // Guards the allowlist itself against a careless addition.
    for (const name of DEFAULT_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/token|secret|key|password|cookie|session|auth/i);
    }
  });
});

describe("failure classification", () => {
  it("prefers a timeout over anything stderr says", () => {
    expect(classifyFailure({ timedOut: true, exitCode: null, stderr: "not logged in" })).toBe(
      "timeout",
    );
  });

  it.each([
    ["command not found", "not_found"],
    ["permission denied", "permission_denied"],
    ["Error: not logged in. Run `login` first.", "authentication_required"],
    ["your session has expired", "authentication_required"],
    ["429 rate limit exceeded", "quota_exhausted"],
    ["getaddrinfo ENOTFOUND api.example.com", "network_unreachable"],
    ["unsupported platform: aix", "unsupported_platform"],
  ])("classifies %j", (stderr, expected) => {
    expect(classifyFailure({ timedOut: false, exitCode: 1, stderr })).toBe(expected);
  });

  it("says internal rather than guessing", () => {
    expect(classifyFailure({ timedOut: false, exitCode: 9, stderr: "flurb" })).toBe("internal");
  });
});

describe("host-declared environment additions", () => {
  it("returns the default list when nothing is declared", () => {
    expect(extendEnvAllowlist(undefined)).toEqual(DEFAULT_ENV_ALLOWLIST);
    expect(extendEnvAllowlist("  ")).toEqual(DEFAULT_ENV_ALLOWLIST);
  });

  it("adds declared names", () => {
    const extended = extendEnvAllowlist("__MISE_DIFF, ASDF_DIR");

    expect(extended).toContain("__MISE_DIFF");
    expect(extended).toContain("ASDF_DIR");
    // The defaults are kept, not replaced: a host adding one name must not
    // lose PATH.
    expect(extended).toContain("PATH");
  });

  it.each(["GITHUB_TOKEN", "MY_API_KEY", "DB_PASSWORD", "SESSION_ID", "AUTH_HEADER"])(
    "refuses to admit %s however it is declared",
    (name) => {
      // The hatch widens which ordinary variables reach a child. It cannot
      // widen the rule about secrets, which is the only reason it is safe to
      // read this from the environment at all.
      expect(extendEnvAllowlist(name)).not.toContain(name);
    },
  );

  it("still strips a declared secret name at build time", () => {
    const runner = new SafeCommandRunner({
      process: new NodeProcessPort({ path: "", platform: "linux" }),
      clock: new FakeClock(),
      envAllowlist: extendEnvAllowlist("GITHUB_TOKEN,__MISE_DIFF"),
    });

    const env = runner.buildEnv({ GITHUB_TOKEN: "leak", __MISE_DIFF: "state" });

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.__MISE_DIFF).toBe("state");
  });

  it("ignores names that are not environment variable names", () => {
    const extended = extendEnvAllowlist("not-a-name, PATH;rm -rf /, VALID_NAME");

    expect(extended).toContain("VALID_NAME");
    expect(extended).not.toContain("not-a-name");
    expect(extended.some((name) => name.includes(";"))).toBe(false);
  });

  it("does not duplicate a name already in the defaults", () => {
    const extended = extendEnvAllowlist("PATH,HOME");

    expect(extended.filter((name) => name === "PATH")).toHaveLength(1);
  });
});
