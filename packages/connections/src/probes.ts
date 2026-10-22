import { redactText, truncate } from "@nexus/shared";
import type { ConnectionErrorCategory } from "./model.js";
import { UnsupportedExecutableError } from "./node-process.js";
import type { ClockPort, ProcessPort, SpawnedProcess } from "./ports.js";

/**
 * Running a provider's own diagnostic command, safely.
 *
 * ## The threat this exists for
 *
 * Detecting a connection means running software NEXUS does not control, and
 * reading what it prints. Three things can go wrong, and all three have been
 * seen in real tools:
 *
 *  1. **The command is chosen by the caller.** If a request can name the
 *     command, the connector becomes a remote shell. The defence is structural:
 *     a probe is a value declared by the provider registry, and `run` accepts
 *     nothing else. There is no code path from a request to a new argv.
 *  2. **The output contains a credential.** `codex --version` will not, but
 *     `codex whoami` might, and an error message from a failed auth call very
 *     well may. Everything leaving this module passes through the repository's
 *     redaction, and is truncated, before it is returned or logged.
 *  3. **The process waits for a human.** A CLI that finds no session sometimes
 *     prompts. A prompt on a closed stdin usually exits; a prompt on an
 *     inherited stdin hangs forever, holding a worker. Stdin is therefore
 *     closed immediately and a timeout kills what remains.
 */

/**
 * A command a provider is allowed to run, as data.
 *
 * `file` and `args` are separate, and `args` is an array. That shape is what
 * makes shell interpolation impossible rather than merely discouraged: there is
 * no string for a shell to parse, and no shell.
 */
export interface DeclaredCommand {
  /** Binary name resolved on PATH, or an absolute path. Never a command line. */
  file: string;
  args: readonly string[];
  /** Hard ceiling on wall-clock time. */
  timeoutMs?: number;
  /** Extra environment variables, each of which must be justified by the provider. */
  env?: Readonly<Record<string, string>>;
}

export interface ProbeOutcome {
  ok: boolean;
  exitCode: number | null;
  /** Redacted and truncated. Safe to log and to return. */
  stdout: string;
  /** Redacted and truncated. Safe to log and to return. */
  stderr: string;
  /** Set when `ok` is false. */
  errorCategory: ConnectionErrorCategory | null;
  durationMs: number;
  /** True when the probe was killed for exceeding its deadline. */
  timedOut: boolean;
  /** True when the output was cut because it exceeded the cap. */
  truncated: boolean;
}

export interface SafeCommandRunnerOptions {
  process: ProcessPort;
  clock: ClockPort;
  /** Default ceiling when a declared command does not set one. */
  defaultTimeoutMs?: number;
  /** Maximum characters kept from each stream. */
  maxOutputChars?: number;
  /** Variables passed through from the ambient environment, by name. */
  envAllowlist?: readonly string[];
  /** Receives every probe, already redacted. */
  onAudit?: (entry: ProbeAuditEntry) => void;
}

export interface ProbeAuditEntry {
  file: string;
  args: readonly string[];
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  errorCategory: ConnectionErrorCategory | null;
}

/**
 * Environment variables a diagnostic command may inherit.
 *
 * An allowlist, not a denylist, and the difference is the whole point. A
 * denylist has to predict every name a credential might take — `GITHUB_TOKEN`,
 * `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, and whatever is invented next
 * month. An allowlist only has to know what a version probe needs, which is
 * almost nothing.
 *
 * `HOME` is on the list and deserves its justification: a CLI finds its own
 * session directory through it, so removing it would make every provider look
 * signed out. That is a deliberate trade — we let the tool find its session, we
 * never read it ourselves.
 */
export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_ENV",
] as const;

/**
 * Names that are stripped even if an allowlist entry would admit them.
 *
 * Belt and braces. The allowlist is the barrier; this is what still holds if
 * somebody widens the allowlist in a hurry, which is exactly the change that
 * gets made at the end of a long day.
 */
const ALWAYS_STRIPPED =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|COOKIE|SESSION|PRIVATE_?KEY|AUTH)(_|$)/i;

/**
 * Adds host-declared names to the default allowlist.
 *
 * ## Why this escape hatch exists
 *
 * Because a minimal environment can make a perfectly installed CLI hang, and
 * this was observed rather than imagined. On the machine this was written on,
 * `codex` and `claude` are shims that run `mise use -g`; with the default
 * allowlist they never answer `--version` and detection correctly reports a
 * timeout — correctly, and uselessly, because the tools work fine. Restoring
 * one variable the shim needs brings the probe back to about fifty
 * milliseconds.
 *
 * Version-manager shims (mise, asdf, volta) are a normal way these tools get
 * installed, and no portable variable describes how a parent's PATH was built.
 * So the host declares what its shims need, by name, and nothing else changes.
 *
 * ## Why this cannot be used to leak a credential
 *
 * The names pass through the same secret-shaped filter as everything else, so
 * declaring `GITHUB_TOKEN` here admits nothing. The hatch widens which
 * *ordinary* variables reach a child; it cannot widen the rule about secrets,
 * and a test asserts exactly that.
 */
export function extendEnvAllowlist(
  declared: string | undefined,
  base: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): readonly string[] {
  if (declared === undefined || declared.trim().length === 0) return base;
  const extra = declared
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .filter((name) => !ALWAYS_STRIPPED.test(name));
  return [...new Set([...base, ...extra])];
}

export class SafeCommandRunner {
  readonly #process: ProcessPort;
  readonly #clock: ClockPort;
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputChars: number;
  readonly #envAllowlist: readonly string[];
  readonly #onAudit: ((entry: ProbeAuditEntry) => void) | undefined;

  constructor(options: SafeCommandRunnerOptions) {
    this.#process = options.process;
    this.#clock = options.clock;
    // Ten seconds: a version probe that takes longer is broken, and a person
    // watching a dashboard will not wait for it either.
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.#maxOutputChars = options.maxOutputChars ?? 8_192;
    this.#envAllowlist = options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST;
    this.#onAudit = options.onAudit;
  }

  /**
   * Builds the child environment from an ambient one.
   *
   * Exported behaviour, not a private detail, because it is the part most worth
   * testing: a leak here is invisible until it shows up in somebody's logs.
   */
  buildEnv(
    ambient: Readonly<Record<string, string | undefined>>,
    extra: Readonly<Record<string, string>> = {},
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.#envAllowlist) {
      const value = ambient[name];
      if (value === undefined || ALWAYS_STRIPPED.test(name)) continue;
      env[name] = value;
    }
    for (const [name, value] of Object.entries(extra)) {
      // A provider may ask for a variable, but not for a secret-shaped one.
      if (ALWAYS_STRIPPED.test(name)) continue;
      env[name] = value;
    }
    return env;
  }

  /** Is the binary present and executable? */
  async locate(file: string): Promise<string | undefined> {
    return this.#process.which(file);
  }

  /**
   * Runs a declared command.
   *
   * Takes a `DeclaredCommand`, never a string, and that signature is the
   * security boundary: there is no way to express "run this text" here, so no
   * request can.
   */
  async run(
    command: DeclaredCommand,
    ambientEnv: Readonly<Record<string, string | undefined>> = {},
  ): Promise<ProbeOutcome> {
    const startedAt = this.#clock.now();
    const timeoutMs = command.timeoutMs ?? this.#defaultTimeoutMs;
    const env = this.buildEnv(ambientEnv, command.env ?? {});

    // Resolve the binary ourselves, then execute the absolute path.
    //
    // This is not an optimisation, it is a correctness and a safety property.
    // A bare name handed to `spawn` is resolved against the PATH of the CHILD
    // environment — the one we just stripped — so a minimal environment would
    // silently make every probe unrunnable. Worse, if PATH were passed through,
    // the binary that ran would be decided by a variable instead of by us.
    // Resolving against the port's own PATH makes "which binary ran" a question
    // with one answer.
    const resolved = await this.#process.which(command.file);
    if (resolved === undefined) {
      return this.#finish(command, {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        errorCategory: "not_found",
        durationMs: this.#clock.now() - startedAt,
        timedOut: false,
        truncated: false,
      });
    }

    let child: SpawnedProcess;
    try {
      child = this.#process.spawn(resolved, command.args, { env });
    } catch (error) {
      // A spawn that throws is almost always a missing binary — except when the
      // port refused to launch something that would need a shell, which is a
      // platform limitation. Reporting that as `not_found` would send somebody
      // to reinstall a tool that is correctly installed.
      const category: ConnectionErrorCategory =
        error instanceof UnsupportedExecutableError ? "unsupported_platform" : "not_found";
      return this.#finish(command, {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: redactText(error instanceof Error ? error.message : String(error)),
        errorCategory: category,
        durationMs: this.#clock.now() - startedAt,
        timedOut: false,
        truncated: false,
      });
    }

    let timedOut = false;
    const deadline = this.#clock.sleep(timeoutMs).then(() => {
      if (child.running) {
        timedOut = true;
        child.kill();
      }
      // A sentinel distinct from any real exit code, so the race below cannot
      // mistake a timeout for a clean exit.
      return -1 as const;
    });

    const exitCode = await Promise.race([child.exit(), deadline]);
    const rawStdout = await child.output();
    const rawStderr = await child.stderr();

    const stdout = this.#clamp(rawStdout);
    const stderr = this.#clamp(rawStderr);
    const truncated = stdout.truncated || stderr.truncated;

    const ok = !timedOut && exitCode === 0;
    return this.#finish(command, {
      ok,
      exitCode: timedOut ? null : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      errorCategory: ok ? null : classifyFailure({ timedOut, exitCode, stderr: rawStderr }),
      durationMs: this.#clock.now() - startedAt,
      timedOut,
      truncated,
    });
  }

  #clamp(raw: string): { text: string; truncated: boolean } {
    // Redact first, then truncate. The other order can cut a secret in half and
    // leave the first half, which the patterns no longer recognise.
    const redacted = redactText(raw).trim();
    if (redacted.length <= this.#maxOutputChars) return { text: redacted, truncated: false };
    return { text: truncate(redacted, this.#maxOutputChars), truncated: true };
  }

  #finish(command: DeclaredCommand, outcome: ProbeOutcome): ProbeOutcome {
    this.#onAudit?.({
      file: command.file,
      args: command.args,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      errorCategory: outcome.errorCategory,
    });
    return outcome;
  }
}

/**
 * Turns a failure into a stable category.
 *
 * Matching on stderr is a heuristic and is treated as one: it runs last, after
 * the two signals that are facts — a timeout and an exit code. A wrong guess
 * yields `internal`, which is honest, rather than a confident category that
 * sends a reader down the wrong path.
 */
export function classifyFailure(input: {
  timedOut: boolean;
  exitCode: number | null;
  stderr: string;
}): ConnectionErrorCategory {
  if (input.timedOut) return "timeout";

  const text = input.stderr.toLowerCase();
  if (/not found|no such file|enoent|is not recognized/.test(text)) return "not_found";
  if (/permission denied|eacces|not permitted/.test(text)) return "permission_denied";
  if (/not logged in|unauthenticated|please (log|sign) in|login required|401/.test(text)) {
    return "authentication_required";
  }
  if (/expired|session.*(invalid|expired)/.test(text)) return "authentication_required";
  if (/quota|rate limit|429|usage limit/.test(text)) return "quota_exhausted";
  if (/getaddrinfo|enotfound|econnrefused|network|dns/.test(text)) return "network_unreachable";
  if (/unsupported platform|not supported on/.test(text)) return "unsupported_platform";
  return "internal";
}
