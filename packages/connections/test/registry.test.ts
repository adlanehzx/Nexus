import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_PROVIDER,
  BUILT_IN_PROVIDERS,
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  createBuiltInRegistry,
  parseVersionLine,
} from "../src/providers.js";
import {
  DuplicateProviderError,
  ProviderRegistry,
  UnknownProviderError,
  UnsupportedProbeError,
} from "../src/registry.js";

describe("provider registry", () => {
  it("resolves a declared probe", () => {
    const registry = createBuiltInRegistry();

    expect(registry.probeFor("codex", "detect").command).toEqual({
      file: "codex",
      args: ["--version"],
      timeoutMs: 10_000,
    });
  });

  it("refuses an unknown provider instead of improvising one", () => {
    const registry = createBuiltInRegistry();

    expect(() => registry.get("whatever-the-request-said")).toThrow(UnknownProviderError);
    expect(() => registry.probeFor("whatever-the-request-said", "detect")).toThrow(
      UnknownProviderError,
    );
  });

  it("does not leak the requested id into the user-facing message", () => {
    try {
      createBuiltInRegistry().get("injected-value");
      expect.unreachable("must throw");
    } catch (error) {
      const typed = error as UnknownProviderError;
      // Technical message may name it; the sentence shown to a person must not
      // echo attacker-chosen text back into a user interface.
      expect(typed.message).toContain("injected-value");
      expect(typed.userMessage).not.toContain("injected-value");
      expect(typed.httpStatus).toBe(404);
    }
  });

  it("refuses a probe a provider does not declare", () => {
    // No built-in provider declares a session probe in this batch; asking for
    // one must be a refusal, not an invented command.
    expect(() => createBuiltInRegistry().probeFor("codex", "authenticate")).toThrow(
      UnsupportedProbeError,
    );
  });

  it("refuses two providers under the same id", () => {
    const registry = new ProviderRegistry([CODEX_PROVIDER]);

    expect(() => registry.register(CODEX_PROVIDER)).toThrow(DuplicateProviderError);
  });

  it("filters by platform", () => {
    const registry = createBuiltInRegistry();

    expect(registry.listForPlatform("linux")).toHaveLength(BUILT_IN_PROVIDERS.length);
    // These are command-line tools; a phone is not a place they run.
    expect(registry.listForPlatform("android")).toHaveLength(0);
  });
});

describe("built-in providers", () => {
  it("declares only non-interactive, side-effect-free presence probes", () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(provider.detect.command.args).toEqual(["--version"]);
      // A probe without a deadline is a probe that can hold a worker forever.
      expect(provider.detect.command.timeoutMs).toBeGreaterThan(0);
      expect(provider.detect.command.file).not.toMatch(/[;&|$`\s]/);
    }
  });

  it("never passes an environment variable to a provider in this batch", () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(provider.detect.command.env).toBeUndefined();
    }
  });

  it("justifies every provenance claim", () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(provider.adapter.provenanceEvidence.length).toBeGreaterThan(20);
      // Bounded by the same limit the connection schema enforces, so a
      // definition cannot carry evidence a Connection would then refuse.
      expect(provider.adapter.provenanceEvidence.length).toBeLessThanOrEqual(400);
    }
  });

  it("marks Antigravity as community until the repository proves otherwise", () => {
    // The adapter is a third-party package wrapping someone else's binary.
    // Labelling it official would tell a user somebody stands behind it.
    expect(ANTIGRAVITY_PROVIDER.adapter.provenance).toBe("community");
  });

  it("claims nothing official without vendor evidence", () => {
    // An npm scope is a name. It does not establish who publishes under it, so
    // it cannot support "officially maintained by OpenAI" or "by Anthropic".
    expect(CODEX_PROVIDER.adapter.provenance).toBe("unknown");
    expect(CLAUDE_PROVIDER.adapter.provenance).toBe("unknown");
  });

  it("ships no provider claiming official status at all", () => {
    // Structural, so adding a provider cannot smuggle the claim back in: an
    // `official` label has to arrive with a reviewed change to this assertion.
    expect(BUILT_IN_PROVIDERS.filter((p) => p.adapter.provenance === "official")).toEqual([]);
  });

  it("records what would justify upgrading each unproven claim", () => {
    // Evidence that only explains the current label is a dead end for whoever
    // picks this up later; it has to name the source that would change it.
    for (const provider of BUILT_IN_PROVIDERS) {
      if (provider.adapter.provenance === "official") continue;
      expect(provider.adapter.provenanceEvidence).toMatch(
        /to classify as official|no vendor publication evidence/i,
      );
    }
  });

  it("looks for its ACP adapter as a package, never by running anything", () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      const probe = provider.adapter.probe;
      expect(probe?.kind).toBe("package");
      // A command probe would start a process to answer a question a directory
      // listing answers, and starting someone else's adapter to ask whether it
      // exists is the kind of probe that eventually costs money.
      expect(probe).not.toHaveProperty("command");
    }
  });

  it("names the adapter packages the agent profiles actually launch", () => {
    // The evidence is in-repo and checkable:
    // services/agent/config/profiles.example.json.
    const byId = new Map(
      BUILT_IN_PROVIDERS.map((provider) => [
        provider.id,
        provider.adapter.probe?.kind === "package" ? provider.adapter.probe.packageName : null,
      ]),
    );

    expect(byId.get("codex")).toBe("@agentclientprotocol/codex-acp");
    expect(byId.get("claude")).toBe("@agentclientprotocol/claude-agent-acp");
    expect(byId.get("antigravity")).toBe("google-antigravity-acp");
  });

  it("treats an absent adapter package as proving nothing", () => {
    // Every one of these is launched with `npx -y`, which fetches on demand.
    // Reporting `missing` because no local copy exists would send somebody to
    // install something that was never required.
    for (const provider of BUILT_IN_PROVIDERS) {
      const probe = provider.adapter.probe;
      if (probe?.kind !== "package") throw new Error("expected a package probe");
      expect(probe.absenceProves).toBe("nothing");
      // Verified, and legitimately so: unlike parsing somebody's stdout, "a
      // directory with a package.json exists" has no interpretation step to
      // get wrong. Downgrading it would silently cap availability at unknown
      // and make the probe pointless.
      expect(probe.verification).toBe("verified");
    }
  });

  it("declares no session probe yet, rather than an unobserved one", () => {
    // Deliberate: the mechanism is tested with fakes, and no real provider
    // claims `connected` until its real output has been observed.
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(provider.authenticate).toBeUndefined();
    }
  });
});

describe("version parsing", () => {
  it.each([
    ["1.4.2", "1.4.2"],
    ["codex-cli 1.10.0", "1.10.0"],
    ["v0.63.0 (build abc123)", "0.63.0"],
    ["claude 2.0.1-beta.3", "2.0.1-beta.3"],
  ])("reads %j", (line, expected) => {
    expect(parseVersionLine(line)?.version).toBe(expected);
  });

  it.each(["", "unknown", "version: unavailable", "1.4"])(
    "returns undefined rather than inventing a version from %j",
    (line) => {
      expect(parseVersionLine(line)).toBeUndefined();
    },
  );
});
