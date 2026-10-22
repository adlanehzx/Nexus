import { AppError } from "@nexus/shared";
import type {
  AdapterProvenance,
  ConnectionAction,
  ConnectionKind,
  ConnectionPlatform,
} from "./model.js";
import type { DeclaredCommand } from "./probes.js";

/**
 * The catalogue of what NEXUS can connect to.
 *
 * ## Why a registry rather than a function per provider
 *
 * Because the registry is the thing that makes arbitrary execution impossible.
 * Every command NEXUS will ever run during detection is declared here, as data,
 * before any request arrives. The connector resolves a provider id to a
 * declaration; it never builds one. A request that asks for an unknown id gets
 * a refusal, not a best effort.
 *
 * That shape also makes the dangerous change visible in review: adding a
 * command means editing this file, which is a diff a human reads, rather than
 * threading a new string through a call site nobody looks at twice.
 */

/**
 * How much confidence a probe's interpretation deserves.
 *
 * This exists because of an honesty problem. Writing `codex auth status` in a
 * registry is easy; knowing what it prints when a session has expired requires
 * running it against a real, expired session. Until someone has done that, the
 * parser is a guess, and a guess that silently reports `connected` is worse
 * than no probe at all.
 *
 * So the uncertainty is carried in the type. `unverified` probes are still run,
 * but the detector refuses to derive `connected` from one.
 */
export type ProbeVerification =
  /** Behaviour confirmed against the real CLI, including its failure modes. */
  | "verified"
  /** Command and parser written from documentation or convention, not observed. */
  | "unverified";

export interface ProviderProbe {
  command: DeclaredCommand;
  verification: ProbeVerification;
  /**
   * Interprets a successful probe.
   *
   * Receives already-redacted, already-truncated output. Returning `undefined`
   * means "this output is not something I recognise", which the detector treats
   * as `invalid_output` rather than as a failure of the provider.
   */
  interpret?: (stdout: string) => ProbeInterpretation | undefined;
}

export interface ProbeInterpretation {
  version?: string;
  /** True only when the output positively states an active session. */
  authenticated?: boolean;
  capabilities?: readonly string[];
}

/**
 * A probe for the ACP adapter, as opposed to the provider's own CLI.
 *
 * Separate from `detect` because they answer different questions about
 * different components. `codex --version` says the CLI is installed; it says
 * nothing about whether the ACP adapter that bridges to it is. Conflating them
 * produces a surface offering an action that cannot run.
 */
export interface AdapterProbe {
  command: DeclaredCommand;
  verification: ProbeVerification;
  /**
   * Interprets a successful probe.
   *
   * Receives redacted, truncated output. `undefined` means "not recognised",
   * which yields `unknown` rather than a guess in either direction.
   */
  interpret?: (stdout: string) => { available: boolean } | undefined;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  kind: ConnectionKind;
  /** Platforms where this provider can work at all. */
  platforms: readonly ConnectionPlatform[];
  adapter: {
    provenance: AdapterProvenance;
    /**
     * Why that provenance was assigned, and what would change it.
     *
     * Mandatory, because "official" is a claim about who maintains someone
     * else's software and an unexplained claim cannot be checked. A published
     * package scope is not such evidence: scopes are names, and a name does not
     * establish who stands behind what is published under it. Anything short of
     * an authoritative vendor statement means `unknown` or `community`, and the
     * text must record the exact source that would justify an upgrade.
     */
    provenanceEvidence: string;
    /**
     * How to find out whether the adapter is installed.
     *
     * Optional, and absent for every provider NEXUS currently ships: without
     * one, availability is reported as `unknown`, never as `available`.
     */
    probe?: AdapterProbe;
  };
  /** Presence probe. Must be side-effect free and must not need a session. */
  detect: ProviderProbe;
  /** Session probe. Optional: not every provider exposes one that is safe to run. */
  authenticate?: ProviderProbe;
  /** Actions a user interface may offer for this provider. */
  actions: readonly ConnectionAction[];
  /** Where a human goes to fix things. Never a URL built from input. */
  docsUrl?: string;
}

export class UnknownProviderError extends AppError {
  readonly code = "UNKNOWN_CONNECTION_PROVIDER";
  readonly httpStatus = 404;

  constructor(providerId: string) {
    super({
      // The id is echoed because it came from the caller and is not a secret;
      // it is the one piece of information that makes the error actionable.
      message: `No connection provider is registered under the id "${providerId}".`,
      userMessage: "This connection type is not available in this installation.",
      context: { providerId },
    });
  }
}

export class UnsupportedProbeError extends AppError {
  readonly code = "UNSUPPORTED_CONNECTION_PROBE";
  readonly httpStatus = 400;

  constructor(providerId: string, action: string) {
    super({
      message: `Provider "${providerId}" declares no probe for the action "${action}".`,
      userMessage: "This check is not available for this connection.",
      context: { providerId, action },
    });
  }
}

/**
 * Two providers claiming the same id.
 *
 * A 500, not a 400: nothing a user did causes this. It means the installation
 * registered a provider twice, which would otherwise resolve to whichever
 * registration happened to run last — a difference nobody would notice until a
 * probe ran the wrong binary.
 */
export class DuplicateProviderError extends AppError {
  readonly code = "DUPLICATE_CONNECTION_PROVIDER";
  readonly httpStatus = 500;

  constructor(providerId: string) {
    super({
      message: `A connection provider is already registered under the id "${providerId}".`,
      userMessage: "This NEXUS installation is misconfigured.",
      context: { providerId },
    });
  }
}

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderDefinition>();

  constructor(definitions: readonly ProviderDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ProviderDefinition): void {
    if (this.#providers.has(definition.id)) throw new DuplicateProviderError(definition.id);
    this.#providers.set(definition.id, definition);
  }

  /** Throws rather than returning `undefined`: an unknown id is a caller error. */
  get(providerId: string): ProviderDefinition {
    const definition = this.#providers.get(providerId);
    if (!definition) throw new UnknownProviderError(providerId);
    return definition;
  }

  has(providerId: string): boolean {
    return this.#providers.has(providerId);
  }

  list(): readonly ProviderDefinition[] {
    return [...this.#providers.values()];
  }

  /** Providers that can work on a platform. Keeps a dashboard from offering Windows-only tools on Linux. */
  listForPlatform(platform: ConnectionPlatform): readonly ProviderDefinition[] {
    return this.list().filter((definition) => definition.platforms.includes(platform));
  }

  /**
   * The only way to obtain a command.
   *
   * `action` is a closed union, not a string, so there is no spelling of this
   * call that produces a command the registry did not declare.
   */
  probeFor(providerId: string, action: "detect" | "authenticate"): ProviderProbe {
    const definition = this.get(providerId);
    const probe = action === "detect" ? definition.detect : definition.authenticate;
    if (!probe) throw new UnsupportedProbeError(providerId, action);
    return probe;
  }
}
