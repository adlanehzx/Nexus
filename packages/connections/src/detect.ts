import type {
  AdapterAvailability,
  Connection,
  ConnectionAuthStatus,
  ConnectionErrorCategory,
  ConnectionPlatform,
  ConnectionState,
} from "./model.js";
import { connectionSchema } from "./model.js";
import type { ClockPort } from "./ports.js";
import type { ProbeOutcome, SafeCommandRunner } from "./probes.js";
import type { ProbeInterpretation, ProviderDefinition, ProviderRegistry } from "./registry.js";
import { stateRequiresHumanAction, transition } from "./state-machine.js";

/**
 * Turning probe results into connection states.
 *
 * ## The rule this file exists to enforce
 *
 * A connection is `connected` only when something ran and succeeded. Not when a
 * binary exists, not when `~/.codex` exists, not when a config file mentions a
 * profile. Those are the three shortcuts every integration takes eventually,
 * and each one produces the same bug: a dashboard showing a green dot next to a
 * tool that will fail the moment it is used.
 *
 * The strongest claim a presence probe can support is `detected`. Reaching
 * `connected` additionally requires a session probe that the provider declares
 * as `verified` and that positively reports an active session. A probe marked
 * `unverified` can still run and can still fail usefully — it just cannot be
 * the basis of a success claim.
 */

/**
 * What a previous detection left behind.
 *
 * ## Why not just the state
 *
 * Because a state cannot carry history. Rebuilding a Connection from the
 * state alone meant `lastSuccessAt` was recomputed as "now if this probe
 * succeeded, otherwise null" — so the first failure after a working
 * connection erased the record of it ever having worked. That is the field
 * somebody looks at to answer "did this ever work, and when did it stop",
 * which is exactly the question a failure makes them ask.
 *
 * Deliberately a narrow structural type rather than `Connection`. A full
 * `Connection` satisfies it, so a caller holding one passes it directly, but
 * the detector cannot read anything else from it — and nothing secret can
 * arrive through a shape with two fields of known type.
 */
export interface PreviousObservation {
  state: ConnectionState;
  /** ISO 8601 of the last probe that actually succeeded, or `null`. */
  lastSuccessAt: string | null;
}

/** The starting point when nothing has been observed yet. */
const NO_OBSERVATION: PreviousObservation = { state: "not_installed", lastSuccessAt: null };

export interface DetectorOptions {
  registry: ProviderRegistry;
  runner: SafeCommandRunner;
  clock: ClockPort;
  platform: ConnectionPlatform;
  /** The ambient environment, filtered by the runner before any child sees it. */
  env?: Readonly<Record<string, string | undefined>>;
  onAudit?: (event: DetectionAuditEvent) => void;
}

/**
 * What gets recorded about a detection.
 *
 * Note what is absent: no stdout, no stderr, no environment, no path contents.
 * An audit trail that carries a provider's raw output eventually carries a
 * provider's credential, and audit logs are the one place nobody redacts
 * because nobody expects them to contain anything.
 */
export interface DetectionAuditEvent {
  providerId: string;
  at: string;
  fromState: ConnectionState;
  toState: ConnectionState;
  durationMs: number;
  errorCategory: ConnectionErrorCategory | null;
  probeVerification: "verified" | "unverified";
}

/** Human sentences per failure category. Fixed text: nothing from a provider is interpolated. */
const USER_MESSAGES: Record<ConnectionErrorCategory, string> = {
  not_found: "This tool is not installed on this machine.",
  permission_denied: "NEXUS is not allowed to run this tool on this machine.",
  authentication_required: "Sign in to this tool with its own command line, then check again.",
  timeout: "This tool did not answer in time.",
  unsupported_platform: "This tool does not run on this kind of machine.",
  invalid_output: "This tool answered in a form NEXUS does not recognise.",
  quota_exhausted: "This tool reports that its usage limit is reached.",
  network_unreachable: "This tool could not reach the network.",
  internal: "NEXUS could not check this tool.",
};

export class ConnectionDetector {
  readonly #registry: ProviderRegistry;
  readonly #runner: SafeCommandRunner;
  readonly #clock: ClockPort;
  readonly #platform: ConnectionPlatform;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #onAudit: ((event: DetectionAuditEvent) => void) | undefined;

  constructor(options: DetectorOptions) {
    this.#registry = options.registry;
    this.#runner = options.runner;
    this.#clock = options.clock;
    this.#platform = options.platform;
    this.#env = options.env ?? {};
    this.#onAudit = options.onAudit;
  }

  /**
   * Detects every provider that can run on this platform.
   *
   * `previous` maps a provider id to what was last observed for it. A map of
   * `Connection` values works directly: they satisfy `PreviousObservation`.
   */
  async detectAll(
    previous: ReadonlyMap<string, PreviousObservation> = new Map(),
  ): Promise<Connection[]> {
    const definitions = this.#registry.listForPlatform(this.#platform);
    // Sequential, not parallel. These probes spawn processes on a machine
    // somebody is using; detecting ten providers at once to save two seconds is
    // a bad trade against a visible stall on a laptop.
    const connections: Connection[] = [];
    for (const definition of definitions) {
      connections.push(
        await this.#detect(definition, previous.get(definition.id) ?? NO_OBSERVATION),
      );
    }
    return connections;
  }

  /** Detects a single provider by id. Throws `UnknownProviderError` for an unregistered id. */
  async detect(
    providerId: string,
    previous: PreviousObservation = NO_OBSERVATION,
  ): Promise<Connection> {
    return this.#detect(this.#registry.get(providerId), previous);
  }

  async #detect(
    definition: ProviderDefinition,
    previous: PreviousObservation,
  ): Promise<Connection> {
    const startedAt = this.#clock.now();
    const previousState = previous.state;

    if (!definition.platforms.includes(this.#platform)) {
      // Not an error and not a probe: there is nothing to run, so nothing runs.
      return this.#build(definition, {
        state: this.#move(definition, previousState, "not_installed", 0, "unsupported_platform"),
        errorCategory: "unsupported_platform",
        version: null,
        executablePath: null,
        capabilities: [],
        succeeded: false,
        // Nothing ran, so nothing is known about the adapter either. The
        // provider not running here says nothing about what is installed.
        adapterAvailability: "unknown",
        // Nothing probed a session, so nothing is claimed about one. In
        // particular, a CLI being present is not evidence anybody signed in.
        authStatus: "unknown",
        previous,
      });
    }

    const executablePath = await this.#runner.locate(definition.detect.command.file);
    if (executablePath === undefined) {
      return this.#build(definition, {
        state: this.#move(
          definition,
          previousState,
          "not_installed",
          this.#clock.now() - startedAt,
          "not_found",
        ),
        errorCategory: "not_found",
        version: null,
        executablePath: null,
        capabilities: [],
        succeeded: false,
        // The CLI is absent. That is a fact about the CLI, and the adapter is a
        // separate install — we did not look, so we do not claim.
        adapterAvailability: "unknown",
        // Nothing probed a session, so nothing is claimed about one. In
        // particular, a CLI being present is not evidence anybody signed in.
        authStatus: "unknown",
        previous,
      });
    }

    // Everything past this point is a claim backed by execution, so it goes
    // through `testing` first. The state machine enforces that; this is the
    // call that makes the enforcement real rather than documentary.
    const probing = this.#move(definition, previousState, "testing", 0, null);
    const outcome = await this.#runner.run(definition.detect.command, this.#env);
    // Two different "nothing" results, deliberately not collapsed with `??`:
    //
    //  - no interpreter DECLARED  → `{}`, meaning "recognised, nothing learned"
    //  - interpreter RETURNED undefined → `undefined`, meaning "I do not
    //    recognise this output", which must surface as `invalid_output`
    //
    // Treating the second as the first is how a tool that answered gibberish
    // ends up reported as working.
    const interpretation: ProbeInterpretation | undefined = !outcome.ok
      ? undefined
      : definition.detect.interpret === undefined
        ? {}
        : definition.detect.interpret(outcome.stdout);

    if (!outcome.ok) {
      const category = outcome.errorCategory ?? "internal";
      const failed = category === "authentication_required" ? "authentication_required" : "error";
      return this.#build(definition, {
        state: this.#move(definition, probing, failed, outcome.durationMs, category),
        errorCategory: category,
        version: null,
        executablePath,
        capabilities: [],
        succeeded: false,
        // The presence probe failed, so the adapter was never looked at.
        adapterAvailability: "unknown",
        // Nothing probed a session, so nothing is claimed about one. In
        // particular, a CLI being present is not evidence anybody signed in.
        authStatus: "unknown",
        previous,
      });
    }

    if (interpretation === undefined) {
      // Ran fine, said something unrecognisable. Reporting this as a distinct
      // category matters: "I could not parse the answer" is a NEXUS problem,
      // and telling a user their tool is broken instead would send them to fix
      // the wrong thing.
      return this.#build(definition, {
        state: this.#move(definition, probing, "error", outcome.durationMs, "invalid_output"),
        errorCategory: "invalid_output",
        version: null,
        executablePath,
        capabilities: [],
        succeeded: false,
        adapterAvailability: "unknown",
        // Nothing probed a session, so nothing is claimed about one. In
        // particular, a CLI being present is not evidence anybody signed in.
        authStatus: "unknown",
        previous,
      });
    }

    // The adapter is probed only once the CLI has answered, because a provider
    // whose CLI is broken tells us nothing useful about its bridge. The result
    // is a separate fact carried alongside, never folded into the state.
    const adapterAvailability = await this.#adapterAvailability(definition);

    const sessionProbe = definition.authenticate;
    if (!sessionProbe) {
      // Installed, runnable, session unknown. This is the ceiling for a provider
      // that declares no session probe, and it is deliberately below `connected`.
      return this.#build(definition, {
        state: this.#move(definition, probing, "detected", outcome.durationMs, null),
        errorCategory: null,
        version: interpretation.version ?? null,
        executablePath,
        capabilities: interpretation.capabilities ?? [],
        succeeded: true,
        adapterAvailability,
        // Installed and runnable. That is a fact about the install, not about
        // a session, and this is the pairing the review asked to keep distinct.
        authStatus: "unknown",
        previous,
      });
    }

    const session = await this.#runner.run(sessionProbe.command, this.#env);
    const state = this.#sessionState(session, sessionProbe.verification, sessionProbe.interpret);
    return this.#build(definition, {
      state: this.#move(definition, probing, state.state, session.durationMs, state.errorCategory),
      errorCategory: state.errorCategory,
      version: interpretation.version ?? state.version ?? null,
      executablePath,
      capabilities: state.capabilities,
      succeeded: state.state === "connected" || state.state === "degraded",
      adapterAvailability,
      authStatus: state.authStatus,
      previous,
      probeVerification: sessionProbe.verification,
    });
  }

  /**
   * Looks for the ACP adapter, as a question separate from the CLI.
   *
   * The rules mirror the session probe's, for the same reason: a claim only
   * strengthens on evidence.
   *
   *  - No probe declared — the case for every shipped provider — yields
   *    `unknown`. Never `available`.
   *  - The adapter binary genuinely absent yields `missing`. That conclusion
   *    comes from the operating system rather than from a parser, so an
   *    unverified probe is still trusted for it.
   *  - A parser saying "available" is trusted only when the probe is
   *    `verified`; otherwise `unknown`.
   *  - A parser saying "not available", or any other failure, yields `unknown`
   *    when unverified: wrongly reporting `missing` sends somebody to reinstall
   *    something that is already there.
   */
  async #adapterAvailability(definition: ProviderDefinition): Promise<AdapterAvailability> {
    const probe = definition.adapter.probe;
    if (!probe) return "unknown";

    const outcome = await this.#runner.run(probe.command, this.#env);
    if (!outcome.ok) {
      return outcome.errorCategory === "not_found" ? "missing" : "unknown";
    }

    const parsed = probe.interpret === undefined ? undefined : probe.interpret(outcome.stdout);
    if (parsed === undefined) return "unknown";
    if (probe.verification !== "verified") return "unknown";
    return parsed.available ? "available" : "missing";
  }

  /**
   * Interprets a session probe into a state and an auth status.
   *
   * The two move on different evidence, deliberately. The state may be
   * heuristic — reaching `authentication_required` from a message that looks
   * like a sign-in prompt is cheap and recoverable for a reader. The auth
   * status may not: it changes only on a positive statement from a probe the
   * registry marks `verified`. Everything else is `unknown`, which is why
   * `authentication_required` paired with `unknown` is a legitimate result
   * rather than an inconsistency.
   */
  #sessionState(
    outcome: ProbeOutcome,
    verification: "verified" | "unverified",
    interpret:
      | ((stdout: string) =>
          | {
              authenticated?: boolean;
              sessionExpired?: boolean;
              version?: string;
              capabilities?: readonly string[];
            }
          | undefined)
      | undefined,
  ): {
    state: ConnectionState;
    authStatus: ConnectionAuthStatus;
    errorCategory: ConnectionErrorCategory | null;
    version: string | undefined;
    capabilities: readonly string[];
  } {
    if (!outcome.ok) {
      const category = outcome.errorCategory ?? "internal";
      const state: ConnectionState =
        category === "authentication_required"
          ? "authentication_required"
          : category === "quota_exhausted"
            ? "degraded"
            : category === "network_unreachable"
              ? "disconnected"
              : "error";
      // A failed probe is not a statement about a session, even when its
      // stderr reads like one. `quota_exhausted` is the tempting case — the
      // tool arguably answered as somebody signed in — but that is an
      // inference from an error message, and this field does not do inference.
      return {
        state,
        authStatus: "unknown",
        errorCategory: category,
        version: undefined,
        capabilities: [],
      };
    }

    const parsed = interpret?.(outcome.stdout);
    if (parsed === undefined) {
      return {
        state: "error",
        authStatus: "unknown",
        errorCategory: "invalid_output",
        version: undefined,
        capabilities: [],
      };
    }
    if (parsed.sessionExpired === true) {
      // Distinct from "no session": somebody who signed in before and must
      // again reads a different sentence from somebody who never has.
      return {
        state: verification === "verified" ? "expired" : "authentication_required",
        authStatus: verification === "verified" ? "expired" : "unknown",
        errorCategory: "authentication_required",
        version: parsed.version,
        capabilities: parsed.capabilities ?? [],
      };
    }
    if (parsed.authenticated !== true) {
      // Not authenticated is not an error: it is the normal state of a tool
      // nobody has signed into yet, and it needs a person, not a retry.
      return {
        state: "authentication_required",
        authStatus: verification === "verified" ? "unauthenticated" : "unknown",
        errorCategory: "authentication_required",
        version: parsed.version,
        capabilities: parsed.capabilities ?? [],
      };
    }
    if (verification !== "verified") {
      // An unverified parser said "authenticated". That is not enough to tell a
      // user their tool works, so the claim is capped at `detected` and the
      // reason is recorded rather than hidden.
      return {
        state: "detected",
        authStatus: "unknown",
        errorCategory: null,
        version: parsed.version,
        capabilities: parsed.capabilities ?? [],
      };
    }
    return {
      state: "connected",
      // The only path to this value: a verified probe that positively said so.
      authStatus: "authenticated",
      errorCategory: null,
      version: parsed.version,
      capabilities: parsed.capabilities ?? [],
    };
  }

  #move(
    definition: ProviderDefinition,
    from: ConnectionState,
    to: ConnectionState,
    durationMs: number,
    errorCategory: ConnectionErrorCategory | null,
    probeVerification: "verified" | "unverified" = definition.detect.verification,
  ): ConnectionState {
    const next = transition(from, to);
    this.#onAudit?.({
      providerId: definition.id,
      at: new Date(this.#clock.now()).toISOString(),
      fromState: from,
      toState: next,
      durationMs,
      errorCategory,
      probeVerification,
    });
    return next;
  }

  #build(
    definition: ProviderDefinition,
    result: {
      state: ConnectionState;
      errorCategory: ConnectionErrorCategory | null;
      version: string | null;
      executablePath: string | null;
      capabilities: readonly string[];
      succeeded: boolean;
      adapterAvailability: AdapterAvailability;
      authStatus: ConnectionAuthStatus;
      previous: PreviousObservation;
      probeVerification?: "verified" | "unverified";
    },
  ): Connection {
    const now = new Date(this.#clock.now()).toISOString();
    // Parsed, not cast. The schema is `strict`, so this call is what guarantees
    // no extra field — a leaked secret included — ever reaches a caller.
    //
    // A failure here is not a crash. Some of these values come from a
    // provider's own output: a tool that prints a 500-character "version" would
    // otherwise throw a validation error out of a detection loop and take the
    // whole sweep down with it. Refusing that one connection, and saying why,
    // is the proportionate answer.
    const candidate = {
      id: `${definition.kind}:${definition.id}`,
      providerId: definition.id,
      kind: definition.kind,
      displayName: definition.displayName,
      state: result.state,
      version: result.version,
      executablePath: result.executablePath,
      capabilities: [...result.capabilities],
      availableActions: [...definition.actions],
      platform: this.#platform,
      lastCheckedAt: now,
      // Every check updates `lastCheckedAt`; only a success moves
      // `lastSuccessAt`. A failure leaves the earlier value alone, because
      // "it worked at 14:02 and has failed since" is the useful fact and
      // overwriting it with null destroys exactly that.
      lastSuccessAt: result.succeeded ? now : result.previous.lastSuccessAt,
      authStatus: result.authStatus,
      errorCategory: result.errorCategory,
      userMessage: result.errorCategory === null ? null : USER_MESSAGES[result.errorCategory],
      requiresHumanAction: stateRequiresHumanAction(result.state),
      adapter: {
        // Never derived from `executablePath`. The CLI and the adapter are
        // separate installs, so the presence of one is not evidence about the
        // other.
        availability: result.adapterAvailability,
        provenance: definition.adapter.provenance,
        provenanceEvidence: definition.adapter.provenanceEvidence,
      },
    };

    const parsed = connectionSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    return this.#unrepresentable(definition, now, result.previous);
  }

  /**
   * The connection we report when a provider's own output will not fit the model.
   *
   * Built from constants and from the registry, never from probe output, so this
   * one cannot fail validation in turn.
   */
  #unrepresentable(
    definition: ProviderDefinition,
    now: string,
    previous: PreviousObservation,
  ): Connection {
    return connectionSchema.parse({
      id: `${definition.kind}:${definition.id}`,
      providerId: definition.id,
      kind: definition.kind,
      displayName: definition.displayName,
      state: "error",
      version: null,
      executablePath: null,
      capabilities: [],
      availableActions: [...definition.actions],
      platform: this.#platform,
      lastCheckedAt: now,
      // Not `now`: nothing succeeded, and inventing a success timestamp here
      // would be the worst version of this bug rather than a fix for it. Not
      // forced to null either — an earlier success is still a fact.
      lastSuccessAt: previous.lastSuccessAt,
      // Nothing was learned about the session either.
      authStatus: "unknown",
      errorCategory: "invalid_output",
      userMessage: USER_MESSAGES.invalid_output,
      requiresHumanAction: stateRequiresHumanAction("error"),
      adapter: {
        availability: "unknown",
        provenance: definition.adapter.provenance,
        provenanceEvidence: definition.adapter.provenanceEvidence,
      },
    });
  }
}
