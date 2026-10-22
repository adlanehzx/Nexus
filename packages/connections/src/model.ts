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
        /** Present when a separate adapter process bridges to this provider. */
        available: z.boolean(),
        provenance: adapterProvenanceSchema,
        /** Why we call it official or community. Mandatory, auditable. */
        provenanceEvidence: z.string().min(1).max(200),
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
