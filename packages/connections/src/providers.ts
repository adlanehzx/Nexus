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

/**
 * Platforms these providers are declared to support.
 *
 * Windows is **excluded**, and not for lack of interest. npm installs its
 * executables there as `.cmd` shims, a `.cmd` cannot be started without
 * `cmd.exe`, and running anything through `cmd.exe` means quoting arguments for
 * it — the problem CVE-2024-27980 exists about, and one nobody has solved
 * reliably. Declaring `win32` support would mean either lying about what works
 * or adding a `shell: true` path, and a probe is not worth an injection
 * surface.
 *
 * What would lift this: resolving the shim to the real target it wraps (npm
 * shims are generated wrappers around a JavaScript entry point, so the honest
 * route is to launch the Node binary with that script as an argument, which
 * needs no interpreter), verified on a real Windows machine. The mechanism is
 * ready — `launchability` in node-process.ts already refuses what it must — and
 * nothing here needs to change except this list and a resolver.
 *
 * Mobile is excluded for the simpler reason that these are command-line tools.
 */
const DESKTOP_PLATFORMS = ["linux", "darwin"] as const;

/**
 * `claude auth status`, observed on 2.1.318 signed in and with an empty config directory.
 *
 * Prints JSON with `loggedIn`, exiting 0 when signed in and 1 when not. It runs locally and
 * consumes no quota. Only that flag is read: the output also holds the account's email and
 * organization, which NEXUS has no use for and does not keep.
 *
 * A lapsed session has not been observed, so this never reports one.
 */
export function parseClaudeAuthStatus(result: {
  exitCode: number | null;
  stdout: string;
}): ProbeInterpretation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const loggedIn = (parsed as { loggedIn?: unknown } | null)?.loggedIn;
  if (loggedIn === true && result.exitCode === 0) return { authenticated: true };
  if (loggedIn === false && result.exitCode === 1) return { authenticated: false };
  return undefined;
}

/**
 * `codex login status`, observed on 0.166.0 signed in and with an empty CODEX_HOME.
 *
 * Answers on stderr, among possible warnings: "Logged in using ChatGPT" exiting 0, or
 * "Not logged in" exiting 1. It runs locally and consumes no quota. A lapsed session has not
 * been observed, so this never reports one.
 */
export function parseCodexLoginStatus(result: {
  exitCode: number | null;
  stderr: string;
}): ProbeInterpretation | undefined {
  if (result.exitCode === 0 && /^Logged in using /m.test(result.stderr)) {
    return { authenticated: true };
  }
  if (result.exitCode === 1 && /^Not logged in$/m.test(result.stderr)) {
    return { authenticated: false };
  }
  return undefined;
}

export const CODEX_PROVIDER: ProviderDefinition = {
  id: "codex",
  displayName: "Codex",
  kind: "acp",
  platforms: DESKTOP_PLATFORMS,
  adapter: {
    // Not `official`. The npm scope was the only evidence available, and a
    // scope does not prove who maintains what is published under it — telling a
    // user that OpenAI stands behind this adapter is a claim this repository
    // cannot support. `unknown` says what we actually know.
    provenance: "unknown",
    provenanceEvidence:
      "Unknown maintainer. The adapter is referenced in services/agent/config/profiles.example.json under the @agentclientprotocol npm scope, but a scope is a name and does not establish who publishes under it. To classify as official, record an authoritative vendor statement: the adapter listed as supported in the vendor's own documentation, or the npm package linked from a vendor-controlled domain.",
    probe: {
      kind: "package",
      packageName: "@agentclientprotocol/codex-acp",
      verification: "verified",
      // The profile in services/agent/config/profiles.example.json launches
      // this adapter with `npx -y`, which fetches it on demand. A local copy
      // is therefore sufficient evidence of presence and its absence is
      // evidence of nothing at all.
      absenceProves: "nothing",
    },
  },
  detect: {
    command: { file: "codex", args: ["--version"], timeoutMs: 10_000 },
    verification: "verified",
    interpret: parseVersionLine,
  },
  authenticate: {
    command: { file: "codex", args: ["login", "status"], timeoutMs: 15_000 },
    verification: "verified",
    interpretResult: parseCodexLoginStatus,
  },
  actions: ["detect", "test", "open_docs"],
  docsUrl: "https://developers.openai.com/codex/cli",
  authGuide: {
    kind: "cli_command",
    command: "codex login",
    instructions: "Run 'codex login' in your terminal to sign in to OpenAI.",
    url: "https://developers.openai.com/codex/cli",
  },
};

export const CLAUDE_PROVIDER: ProviderDefinition = {
  id: "claude",
  displayName: "Claude Code",
  kind: "acp",
  platforms: DESKTOP_PLATFORMS,
  adapter: {
    // See CODEX_PROVIDER: same reasoning, same missing evidence.
    provenance: "unknown",
    provenanceEvidence:
      "Unknown maintainer. The adapter is referenced in services/agent/config/profiles.example.json under the @agentclientprotocol npm scope, but a scope is a name and does not establish who publishes under it. To classify as official, record an authoritative vendor statement: the adapter listed as supported in the vendor's own documentation, or the npm package linked from a vendor-controlled domain.",
    probe: {
      kind: "package",
      packageName: "@agentclientprotocol/claude-agent-acp",
      verification: "verified",
      absenceProves: "nothing",
    },
  },
  detect: {
    command: { file: "claude", args: ["--version"], timeoutMs: 10_000 },
    verification: "verified",
    interpret: parseVersionLine,
  },
  authenticate: {
    command: { file: "claude", args: ["auth", "status"], timeoutMs: 15_000 },
    verification: "verified",
    interpretResult: parseClaudeAuthStatus,
  },
  actions: ["detect", "test", "open_docs"],
  docsUrl: "https://docs.claude.com/en/docs/claude-code",
  authGuide: {
    kind: "cli_command",
    command: "claude login",
    instructions: "Run 'claude login' in your terminal to authenticate with Anthropic.",
    url: "https://docs.claude.com/en/docs/claude-code",
  },
};

/**
 * `agy models`, observed on 1.5.2 signed in and signed out.
 *
 * Prints the models list on stdout and exits 0 when signed in.
 * Prints "Error: Please sign in to view available models." and exits 1 when signed out.
 * It runs locally and consumes no quota.
 */
export function parseAgyAuthStatus(result: {
  exitCode: number | null;
  stdout: string;
  stderr?: string;
}): ProbeInterpretation | undefined {
  if (
    result.exitCode === 0 &&
    (result.stdout.includes("gemini") ||
      result.stdout.includes("flash") ||
      result.stdout.includes("Fetching available models"))
  ) {
    return { authenticated: true };
  }
  if (
    result.exitCode === 1 ||
    result.stdout.includes("Please sign in") ||
    result.stderr?.includes("Please sign in") ||
    result.stdout.includes("not logged into Antigravity") ||
    result.stderr?.includes("not logged into Antigravity")
  ) {
    return { authenticated: false };
  }
  return undefined;
}

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
    probe: {
      kind: "package",
      packageName: "google-antigravity-acp",
      verification: "verified",
      absenceProves: "nothing",
    },
  },
  detect: {
    command: { file: "agy", args: ["--version"], timeoutMs: 10_000 },
    verification: "verified",
    interpret: parseVersionLine,
  },
  authenticate: {
    command: { file: "agy", args: ["models"], timeoutMs: 15_000 },
    verification: "verified",
    interpretResult: parseAgyAuthStatus,
  },
  actions: ["detect", "test", "open_docs"],
  authGuide: {
    kind: "cli_command",
    command: "agy acp --login",
    instructions: "Run 'agy acp --login' in your terminal to authenticate with Google.",
    url: null,
  },
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
