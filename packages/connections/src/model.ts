import { z } from "zod";

/**
 * The shared `Connection` domain.
 *
 * ## What a connection is
 *
 * One thing NEXUS can be attached to: a reasoning agent reachable over ACP, an
 * MCP server, a network fabric, or a machine that executes work. Four kinds,
 * one model, because the questions a person asks about them are identical — is
 * it installed, am I signed in, does it answer, and what do I do about it.
 *
 * ## Why the model forbids more than it allows
 *
 * A connection describes something that holds credentials: an agent CLI with a
 * live session, an MCP server with a token, a network with a key. The useful
 * discipline is therefore not what the model carries but what it **cannot**
 * carry. Every field below is safe to log, to serialise into an API response,
 * and to show on a dashboard — and the schema is `strict`, so a field that is
 * not on this list cannot be smuggled in by a provider that returns extra keys.
 *
 * A test serialises a connection built from deliberately secret-looking inputs
 * and asserts none of them survive. That test is the real specification; this
 * comment only explains it.
 */

/** What kind of thing is on the other end. */
export const connectionKindSchema = z.enum([
  /** A reasoning agent reachable over the Agent Client Protocol. */
  "acp",
  /** A Model Context Protocol server exposing tools. */
  "mcp",
  /** A network fabric, such as Tailscale. */
  "network",
  /** A machine that executes work: PC, server, NAS, Raspberry Pi, phone. */
  "device",
]);
export type ConnectionKind = z.infer<typeof connectionKindSchema>;

/**
 * The lifecycle of a connection.
 *
 * The order of this list is the order of progress, and that is deliberate: a
 * reader can see at a glance that `detected` is further along than
 * `not_installed` and that `connected` is the end of the happy path. Three
 * states sit outside that progression — `degraded`, `expired` and `error` — and
 * they are the ones that matter in practice, because they are where a person
 * has to decide something.
 */
export const connectionStateSchema = z.enum([
  /** Nothing found on this machine. */
  "not_installed",
  /** The executable exists; nothing more is claimed. */
  "detected",
  /** Installed, but the provider says a human must sign in. */
  "authentication_required",
  /** A sign-in flow is in progress, owned by the provider's own tooling. */
  "authenticating",
  /** A probe is running right now. */
  "testing",
  /** A probe succeeded. The strongest claim this model makes. */
  "connected",
  /** Reachable, but impaired — quota low, high latency, partial capability. */
  "degraded",
  /** A session existed and has lapsed. Distinct from never having had one. */
  "expired",
  /** Was connected, is not now, and nothing suggests a credential problem. */
  "disconnected",
  /** A probe failed for a reason the model could classify. */
  "error",
]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/**
 * Why a probe failed, in stable categories.
 *
 * Categories rather than messages, because a category can be branched on and a
 * message cannot. The matching human sentence lives in `userMessage`, already
 * redacted.
 */
export const connectionErrorCategorySchema = z.enum([
  "not_found",
  "permission_denied",
  "authentication_required",
  "timeout",
  "unsupported_platform",
  "invalid_output",
  "quota_exhausted",
  "network_unreachable",
  "internal",
]);
export type ConnectionErrorCategory = z.infer<typeof connectionErrorCategorySchema>;

/**
 * What a person can do about this connection, right now.
 *
 * Actions are named, not free-form, so that a surface cannot invent one and the
 * connector cannot be asked to run something that was never declared.
 * `sign_in` and `sign_out` deliberately mean "open the provider's own flow":
 * NEXUS never collects a credential itself.
 */
export const connectionActionSchema = z.enum([
  "detect",
  "test",
  "sign_in",
  "sign_out",
  "install",
  "open_docs",
]);
export type ConnectionAction = z.infer<typeof connectionActionSchema>;

export const connectionPlatformSchema = z.enum(["linux", "darwin", "win32", "android", "unknown"]);
export type ConnectionPlatform = z.infer<typeof connectionPlatformSchema>;

/**
 * Where an adapter comes from, and the evidence for saying so.
 *
 * `official` is a claim about provenance, and a claim needs a reason. The
 * evidence string is mandatory so that nobody can promote an adapter to
 * official by editing one word: they have to write down why, and a reviewer can
 * disagree with it.
 */
export const adapterProvenanceSchema = z.enum(["official", "community", "unknown"]);
export type AdapterProvenance = z.infer<typeof adapterProvenanceSchema>;

/**
 * Whether the ACP adapter is installed.
 *
 * Deliberately not a boolean. "I have not looked" and "I looked and it is not
 * there" are different facts, and collapsing them means reporting one of them
 * as the other. The only way to reach `available` is evidence from an adapter
 * probe; absence of evidence yields `unknown`.
 */
/**
 * What is known about the provider's own sign-in session.
 *
 * ## Why this is separate from the state
 *
 * Installation and authentication are related and not identical, and the model
 * says so rather than leaving a reader to infer one from the other. A tool can
 * be installed and signed out, installed with a lapsed session, or installed
 * with no way for NEXUS to tell. Folding that into the state would force a
 * single value to answer two questions, and the one that loses is whichever a
 * surface happens not to be asking.
 *
 * The state is allowed to be heuristic: `authentication_required` can be
 * reached from a stderr message that merely looks like a sign-in prompt,
 * because prompting a person to check is cheap and recoverable. This field is
 * not: it only moves on evidence from a probe the registry marks `verified`.
 * So `authentication_required` with `unknown` is a legitimate pairing — "you
 * may need to sign in, and we are not claiming to know".
 *
 * ## Vocabulary, and the consolidation still owed
 *
 * These are exactly the four values of `authStatusSchema` in
 * `services/api/src/services/provider-accounts.ts`, chosen so the two surfaces
 * never disagree about what "expired" means. The schema is re-declared here
 * rather than imported, because that module also exports a `ProviderAccount`
 * carrying `env` and `sessionDir` — a full environment map and a path to a
 * session file — and a domain package has no business depending on a type that
 * can hold credentials.
 *
 * The consolidation that is owed: move this four-value schema into
 * `@nexus/shared` and have both the API service and this package import it.
 * That is deliberately not done here, since it means editing a package outside
 * this batch's scope while `packages/` is being translated elsewhere. Until
 * then the duplication is one enum of four strings, and the comment on both
 * sides is the contract.
 */
export const connectionAuthStatusSchema = z.enum([
  /** A verified probe positively reported an active session. */
  "authenticated",
  /** A verified probe positively reported no session. */
  "unauthenticated",
  /** A verified probe positively reported a lapsed session. */
  "expired",
  /** Nobody looked, or what came back was not evidence. The default. */
  "unknown",
]);
export type ConnectionAuthStatus = z.infer<typeof connectionAuthStatusSchema>;

export const adapterAvailabilitySchema = z.enum(["available", "missing", "unknown"]);
export type AdapterAvailability = z.infer<typeof adapterAvailabilitySchema>;

export const connectionSchema = z
  .object({
    /** Stable across restarts and across detections. `kind:providerId[:instance]`. */
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_:-]*$/, "must be a stable lowercase identifier"),
    providerId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, "must be a lowercase provider identifier"),
    kind: connectionKindSchema,
    displayName: z.string().min(1).max(128),
    state: connectionStateSchema,

    /**
     * Version string as the provider reported it, or `null`.
     *
     * Kept as text rather than parsed: a provider that prints something
     * unexpected is an observation worth showing, not an error worth throwing.
     */
    version: z.string().max(64).nullable(),

    /**
     * Absolute path of the executable, or `null`.
     *
     * Safe to show: it is a path, not a secret. It is also the single most
     * useful line in a diagnostic, because "installed" and "the version I
     * expect" are different claims and this is what separates them.
     */
    executablePath: z.string().max(4096).nullable(),

    capabilities: z.array(z.string().min(1).max(64)).max(64),
    availableActions: z.array(connectionActionSchema).max(16),
    platform: connectionPlatformSchema,

    /** ISO 8601, or `null` when never probed. */
    lastCheckedAt: z.string().datetime().nullable(),
    /** ISO 8601 of the last probe that actually succeeded. */
    lastSuccessAt: z.string().datetime().nullable(),

    /**
     * What is known about the session, as opposed to about the installation.
     *
     * Never inferred from `state`, from `executablePath`, or from the adapter.
     * The presence of a CLI says nothing about whether anybody has signed into
     * it.
     */
    authStatus: connectionAuthStatusSchema,

    errorCategory: connectionErrorCategorySchema.nullable(),
    /** One sentence, already redacted, safe to display verbatim. */
    userMessage: z.string().max(400).nullable(),

    /**
     * Does a person have to do something, or will waiting help?
     *
     * Separate from the state because the two differ: `expired` needs a human,
     * `disconnected` usually does not, and both are failures. A surface that
     * guesses this from the state will get it wrong.
     */
    requiresHumanAction: z.boolean(),

    adapter: z
      .object({
        /**
         * Whether the ACP adapter itself is present.
         *
         * Three values, not a boolean, and never derived from the CLI. The
         * provider's command-line tool and the ACP adapter that bridges to it
         * are separate components installed separately: `codex` can be on PATH
         * with no adapter, and an adapter can be installed for a CLI that is
         * gone. A boolean forces a guess, and the guess that gets made is
         * "the CLI is here, so the adapter must be" — which is how a surface
         * ends up offering an action that cannot run.
         *
         * `unknown` is the honest answer until an adapter probe exists. It is
         * not a placeholder for `available`.
         */
        availability: adapterAvailabilitySchema,
        provenance: adapterProvenanceSchema,
        /**
         * Why this provenance was assigned, and what would change it.
         *
         * Mandatory and auditable. An unexplained claim about who maintains
         * someone else's software cannot be checked by a reader.
         */
        provenanceEvidence: z.string().min(1).max(400),
      })
      .strict()
      .nullable(),
  })
  // `strict`: a provider that returns extra keys cannot widen the model. This
  // is the line that makes "no secret in a Connection" enforceable rather than
  // merely intended — the forbidden fields have no way in.
  .strict();

export type Connection = z.infer<typeof connectionSchema>;

/**
 * Field names that must never appear in a serialised connection.
 *
 * Exported because the test that enforces it should not re-declare the list —
 * two copies of a security rule drift, and the copy that drifts is the one
 * nobody reads.
 */
export const FORBIDDEN_CONNECTION_FIELDS = [
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "cookie",
  "cookies",
  "authorization",
  "privateKey",
  "secret",
  "password",
  "env",
  "environment",
  "session",
  "sessionFile",
  "stdout",
  "stderr",
] as const;
