import { describe, expect, it } from "vitest";
import { ConnectionDetector } from "../src/detect.js";
import { FORBIDDEN_CONNECTION_FIELDS } from "../src/model.js";
import { NodePackageResolver } from "../src/node-packages.js";
import { NodeProcessPort, SystemClock } from "../src/node-process.js";
import { SafeCommandRunner, extendEnvAllowlist } from "../src/probes.js";
import { BUILT_IN_PROVIDERS, createBuiltInRegistry } from "../src/providers.js";

/**
 * Smoke tests against the agent tooling actually installed on this machine.
 *
 * ## Disabled by default, and why there are two switches
 *
 * CI must stay deterministic and free. These tests are not: what they observe
 * depends on what somebody installed, so a green run proves something about
 * this machine rather than about the code. They are skipped unless explicitly
 * enabled.
 *
 *   NEXUS_REAL_AGENT_SMOKE=1        discovery only — free, no quota
 *   NEXUS_REAL_AGENT_CONVERSATION=1 additionally allows a real exchange
 *
 * Two switches because the two have different costs. Discovery runs
 * `--version` and looks for packages on disk: no session, no network, no
 * quota, nothing billable. A conversation spends somebody's allowance, so
 * enabling discovery must not silently enable that too.
 *
 * ## What these never do
 *
 * No paid API key is read or required — the providers' own CLIs hold their
 * sessions and NEXUS never touches them. Nothing prints a token, a cookie or
 * an environment: every assertion below is on a `Connection`, whose schema
 * refuses those fields, and one test checks that explicitly rather than
 * trusting it.
 */

const DISCOVERY = process.env["NEXUS_REAL_AGENT_SMOKE"] === "1";
const CONVERSATION = process.env["NEXUS_REAL_AGENT_CONVERSATION"] === "1";

const discovery = DISCOVERY ? describe : describe.skip;
const conversation = DISCOVERY && CONVERSATION ? describe : describe.skip;

/**
 * Per-test budget, generous on purpose.
 *
 * Measured rather than guessed: a real `codex --version` on the machine this
 * was written on takes several seconds, comfortably past Vitest's five-second
 * default. The probes themselves are capped at ten seconds each by the
 * registry, so a provider with both a presence and an adapter check can
 * legitimately occupy twenty, and `detectAll` runs providers sequentially.
 */
const SMOKE_TIMEOUT_MS = 90_000;

function detector(): ConnectionDetector {
  const clock = new SystemClock();
  return new ConnectionDetector({
    registry: createBuiltInRegistry(),
    runner: new SafeCommandRunner({
      process: new NodeProcessPort({ platform: process.platform }),
      clock,
      // Mirrors how the API wires this, so the smoke test measures production
      // behaviour rather than a more permissive variant of it.
      envAllowlist: extendEnvAllowlist(process.env["NEXUS_PROBE_ENV_ALLOWLIST"]),
    }),
    clock,
    platform:
      process.platform === "linux" || process.platform === "darwin" ? process.platform : "unknown",
    packages: new NodePackageResolver(),
    // The runner allowlists names and strips secret-shaped ones before any
    // child sees this, which is the only reason passing it is acceptable.
    env: process.env,
  });
}

discovery("discovering the agent tooling on this machine", () => {
  it(
    "reports every built-in provider without throwing",
    { timeout: SMOKE_TIMEOUT_MS },
    async () => {
      const connections = await detector().detectAll();

      // The assertion is about shape, not about what is installed: a machine
      // with none of these tools is a valid machine and must not fail a suite.
      expect(connections).toHaveLength(BUILT_IN_PROVIDERS.length);
      for (const connection of connections) {
        expect(connection.lastCheckedAt).not.toBeNull();
      }
    },
  );

  it.each(["codex", "claude", "antigravity"])(
    "reaches a definite state for %s",
    { timeout: SMOKE_TIMEOUT_MS },
    async (id) => {
      const connection = await detector().detect(id);

      // Every state is acceptable; `unknown` is not a state, it is the absence
      // of one, and the detector must never leave a connection there.
      expect(connection.state).not.toBe("testing");
      expect([
        "not_installed",
        "detected",
        "authentication_required",
        "expired",
        "disconnected",
        "error",
        "connected",
        "degraded",
      ]).toContain(connection.state);
    },
  );

  it.each(["codex", "claude", "antigravity"])(
    "answers about %s's ACP adapter separately from its CLI",
    { timeout: SMOKE_TIMEOUT_MS },
    async (id) => {
      const connection = await detector().detect(id);

      // The adapters are launched with `npx -y`, so absence proves nothing and
      // `missing` must never appear for them.
      expect(["available", "unknown"]).toContain(connection.adapter?.availability);
    },
  );

  it("never claims a session it has not proven", { timeout: SMOKE_TIMEOUT_MS }, async () => {
    const connections = await detector().detectAll();

    for (const connection of connections) {
      // No provider declares a session probe, so no amount of installed
      // tooling may produce `authenticated` or `connected`.
      expect(connection.authStatus).toBe("unknown");
      expect(connection.state).not.toBe("connected");
    }
  });

  it(
    "returns nothing secret, whatever the tools printed",
    { timeout: SMOKE_TIMEOUT_MS },
    async () => {
      const connections = await detector().detectAll();

      const serialised = JSON.stringify(connections);
      for (const field of FORBIDDEN_CONNECTION_FIELDS) {
        for (const connection of connections) {
          expect(Object.keys(connection)).not.toContain(field);
        }
      }
      // A real `--version` can print a path or a build hash; it must not print
      // anything shaped like a credential, and if it did, redaction caught it.
      expect(serialised).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
      expect(serialised).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
      expect(serialised).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    },
  );

  it(
    "prints a summary a human can read without leaking anything",
    { timeout: SMOKE_TIMEOUT_MS },
    async () => {
      const connections = await detector().detectAll();

      // Deliberately part of the test rather than a script: the summary is what
      // somebody will paste into an issue, so it is held to the same rule as the
      // payload.
      const summary = connections
        .map(
          (connection) =>
            `${connection.providerId}: ${connection.state}` +
            ` adapter=${connection.adapter?.availability ?? "n/a"}` +
            ` auth=${connection.authStatus}` +
            ` version=${connection.version ?? "-"}`,
        )
        .join("\n");
      // eslint-disable-next-line no-console -- the point of a smoke test is the report
      console.log(`\n${summary}\n`);

      expect(summary).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
    },
  );
});

conversation("exchanging a real message with an installed agent", () => {
  it("is not implemented in this batch", () => {
    // Deliberately a failing-free placeholder rather than an untested harness.
    //
    // A real ACP exchange needs an ACP client, and the one NEXUS has lives in
    // services/agent, which this package cannot depend on without inverting
    // the dependency graph. Writing a second client here to satisfy a smoke
    // test would mean shipping an ACP implementation nobody has run against a
    // real adapter — the exact thing the rest of this work refuses to do.
    //
    // What is needed, recorded so it is actionable: a smoke test in the agent
    // service that starts a declared ACP profile, sends one short prompt, and
    // asserts a non-empty response, behind this same double opt-in. That
    // service is outside the scope of this branch.
    expect(CONVERSATION).toBe(true);
  });
});
