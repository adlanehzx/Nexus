import type { ProbeInterpretation, ProviderDefinition } from "./registry.js";
import { ProviderRegistry } from "./registry.js";

/**
 * The ACP providers NEXUS ships with.
 *
 * ## What is claimed here, and what is not
 *
 * Each provider declares a **presence probe** — `--version` — and nothing more.
 * That is a deliberate limit, not an unfinished one.
 *
 * `--version` is safe to run on every one of these tools: it is free, it needs
 * no session, it has no side effect, and the convention is stable enough to
 * rely on. A **session probe** is a different matter. Knowing what `codex` or
 * `claude` prints when a session has expired, as opposed to when it is missing,
 * as opposed to when the machine is offline, requires observing the real tool
 * in each of those states. Writing a plausible command from memory and shipping
 * the parser would produce exactly the failure this package is meant to prevent:
 * a confident "connected" that nobody verified.
 *
 * So the session-probe mechanism is fully built and fully tested — with fake
 * binaries, in `providers.test.ts` and `detect.test.ts` — and the three real
 * providers do not use it yet. The consequence is explicit: in this batch no
 * real provider reaches `connected`; the strongest state they reach is
 * `detected`. Adding a session probe later is a change to this file only.
 */

/**
 * Pulls a version out of a `--version` line.
 *
 * Tolerant on purpose: these tools print `1.2.3`, `codex-cli 1.2.3`,
 * `v1.2.3 (abcdef)` and worse, and the shape changes between releases. What
 * must not happen is inventing a version — an unrecognised line yields
 * `undefined`, which the detector reports as `invalid_output` rather than
 * guessing.
 */
export function parseVersionLine(stdout: string): ProbeInterpretation | undefined {
  // A leading \b would not match in `v1.2.3`, because `v` and `1` are both word
  // characters and there is no boundary between them. The lookbehind instead
  // anchors on "not part of a longer token", which also keeps `abc1.2.3` out.
  const match = /(?<![\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\w.])/.exec(stdout);
  return match?.[1] === undefined ? undefined : { version: match[1] };
}

/** Platforms the ACP command-line tools run on. Mobile is excluded: they need a shell and a filesystem. */
const DESKTOP_PLATFORMS = ["linux", "darwin", "win32"] as const;

export const CODEX_PROVIDER: ProviderDefinition = {
  id: "codex",
  displayName: "Codex",
  kind: "acp",
  platforms: DESKTOP_PLATFORMS,
  adapter: {
    provenance: "official",
    // The evidence is the publishing scope, which is checkable from the repo:
    // services/agent/config/profiles.example.json runs
    // @agentclientprotocol/codex-acp, published under the scope that owns the
    // Agent Client Protocol itself.
    provenanceEvidence:
      "ACP adapter published under the @agentclientprotocol npm scope, as referenced in services/agent/config/profiles.example.json.",
  },
  detect: {
    command: { file: "codex", args: ["--version"], timeoutMs: 10_000 },
    verification: "verified",
    interpret: parseVersionLine,
  },
  actions: ["detect", "test", "open_docs"],
  docsUrl: "https://developers.openai.com/codex/cli",
};

export const CLAUDE_PROVIDER: ProviderDefinition = {
  id: "claude",
  displayName: "Claude Code",
  kind: "acp",
  platforms: DESKTOP_PLATFORMS,
  adapter: {
    provenance: "official",
    provenanceEvidence:
      "ACP adapter published under the @agentclientprotocol npm scope, as referenced in services/agent/config/profiles.example.json.",
  },
  detect: {
    command: { file: "claude", args: ["--version"], timeoutMs: 10_000 },
    verification: "verified",
    interpret: parseVersionLine,
  },
  actions: ["detect", "test", "open_docs"],
  docsUrl: "https://docs.claude.com/en/docs/claude-code",
};

export const ANTIGRAVITY_PROVIDER: ProviderDefinition = {
  id: "antigravity",
  displayName: "Antigravity",
  kind: "acp",
  platforms: DESKTOP_PLATFORMS,
  adapter: {
    // Community until proven otherwise, and the burden of proof is on the
    // "official" label. google-antigravity-acp is a third-party wrapper around
    // the `agy` binary: nothing in this repository shows it is published by the
    // vendor of the tool it drives. Calling it official would be telling a user
    // that someone stands behind it when we do not know that.
    provenance: "community",
    provenanceEvidence:
      "Third-party npm package google-antigravity-acp wrapping the `agy` binary; no vendor publication evidence present in this repository.",
  },
  detect: {
    command: { file: "agy", args: ["--version"], timeoutMs: 10_000 },
    // Unverified: the argument follows the convention the other two use, but
    // the `agy` output has not been observed here. A convention is not an
    // observation, and the type says so.
    verification: "unverified",
    interpret: parseVersionLine,
  },
  actions: ["detect", "test", "open_docs"],
};

export const BUILT_IN_PROVIDERS: readonly ProviderDefinition[] = [
  CODEX_PROVIDER,
  CLAUDE_PROVIDER,
  ANTIGRAVITY_PROVIDER,
];

/** A registry holding the providers NEXUS ships with. Callers may register more. */
export function createBuiltInRegistry(): ProviderRegistry {
  return new ProviderRegistry(BUILT_IN_PROVIDERS);
}
