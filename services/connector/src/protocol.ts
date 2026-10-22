import { z } from "zod";

/**
 * The local connector protocol.
 *
 * ## Shape, and why it is closed
 *
 * A request names a method from a fixed enum and carries parameters validated
 * per method. There is no `exec`, no `command`, no `shell`, and no method whose
 * parameters include a path to run. That absence is the main security property
 * of this file: the connector's whole job is running local binaries, so the one
 * thing it must never accept is a caller's opinion about which binary.
 *
 * ## Version negotiation
 *
 * Every request states the protocol version it speaks. The server answers with
 * the version it used, and refuses a version it does not implement rather than
 * guessing at a payload shape. `supportedVersions` on the health response lets
 * a client pick without a round of trial and error.
 */

/** Versions this implementation understands. Additive: an old client keeps working. */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export const CURRENT_PROTOCOL_VERSION = 1 as const;

export const connectorMethodSchema = z.enum([
  /** Liveness and version negotiation. The only method usable before anything else. */
  "health",
  /** What this connector can do, so a client does not have to probe to find out. */
  "capabilities",
  /** Connections as last observed. Never runs anything. */
  "connection.list",
  /** Runs the declared presence probe for one or all providers. */
  "connection.detect",
  /** Re-runs the declared probes for one provider. */
  "connection.test",
]);
export type ConnectorMethod = z.infer<typeof connectorMethodSchema>;

/**
 * Methods that cause a process to be spawned.
 *
 * Named explicitly so the audit trail and any future rate limit can treat them
 * differently from a read. A method that runs something is a different kind of
 * request from one that reports what was already observed.
 */
export const EXECUTING_METHODS: readonly ConnectorMethod[] = [
  "connection.detect",
  "connection.test",
];

/** A provider id, constrained to the same alphabet the registry uses. */
const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, "must be a lowercase provider identifier");

/**
 * Per-method parameters.
 *
 * Every variant is `strict`. An unknown parameter is an error, not something to
 * ignore: silently dropping a field a client thought was meaningful is how a
 * security option ends up believed-set and unset.
 */
export const connectorParamsSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("health") }).strict(),
  z.object({ method: z.literal("capabilities") }).strict(),
  z.object({ method: z.literal("connection.list") }).strict(),
  z
    .object({
      method: z.literal("connection.detect"),
      /** Omitted means every provider supported on this platform. */
      providerId: providerIdSchema.optional(),
    })
    .strict(),
  z.object({ method: z.literal("connection.test"), providerId: providerIdSchema }).strict(),
]);
export type ConnectorParams = z.infer<typeof connectorParamsSchema>;

/**
 * The signed envelope.
 *
 * `requestId`, `issuedAt` and `nonce` are all three required, and each answers
 * a different question. `requestId` makes a request traceable in an audit log.
 * `issuedAt` bounds how long a captured request stays usable. `nonce` stops a
 * replay inside that window, which `issuedAt` alone cannot do.
 */
export const connectorRequestSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    requestId: z.string().uuid(),
    /** ISO 8601. Compared against the server clock with a bounded skew. */
    issuedAt: z.string().datetime(),
    /** Single-use, remembered for at least the acceptance window. */
    nonce: z.string().min(16).max(128),
    clientId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/, "must be a plain client identifier"),
    /** Base64 signature over the canonical request bytes. */
    signature: z.string().min(1).max(512),
    params: connectorParamsSchema,
  })
  .strict();
export type ConnectorRequest = z.infer<typeof connectorRequestSchema>;

/**
 * Error codes a caller can see.
 *
 * There is exactly **one** authentication code. An unknown client, a signature
 * that does not verify, a stale timestamp and a reused nonce are four different
 * facts internally and one answer externally, because each distinction narrows
 * what an attacker has to change next: "replayed" confirms the signature was
 * good, "expired" confirms the key was accepted, and "unknown client" confirms
 * which identifiers exist. The precise reason is recorded in the local audit
 * trail, where the operator can see it and a caller cannot.
 */
export const connectorErrorCodeSchema = z.enum([
  "unsupported_protocol_version",
  "malformed_request",
  /** Every authentication failure, without exception. */
  "authentication_failed",
  "unknown_method",
  "unknown_provider",
  /**
   * Too many probes already running.
   *
   * A distinct, stable code rather than a generic failure, because the right
   * client response is different: retry shortly, with nothing to fix.
   */
  "capacity_exhausted",
  "internal_error",
]);
export type ConnectorErrorCode = z.infer<typeof connectorErrorCodeSchema>;

/**
 * Why authentication failed, for the audit trail only.
 *
 * Never serialised into a response. The type exists so the distinction is not
 * lost — an operator reading logs needs it to tell a clock problem from an
 * attack — while the wire protocol stays uniform.
 */
export const connectorAuthFailureReasonSchema = z.enum([
  "unknown_client",
  "invalid_signature",
  "expired_timestamp",
  "future_timestamp",
  "malformed_timestamp",
  "replayed_nonce",
]);
export type ConnectorAuthFailureReason = z.infer<typeof connectorAuthFailureReasonSchema>;

/**
 * Responses carry no credential, by construction.
 *
 * There is no field here for a token, a header or an environment, and the
 * connection payload comes from `@nexus/connections`, whose schema is strict
 * and refuses those field names outright.
 */
export const connectorResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      protocolVersion: z.number().int().positive(),
      requestId: z.string().uuid(),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      protocolVersion: z.number().int().positive(),
      requestId: z.string().uuid(),
      error: z
        .object({
          code: connectorErrorCodeSchema,
          /** One sentence, safe to display. Never a provider's raw output. */
          message: z.string().min(1).max(400),
        })
        .strict(),
    })
    .strict(),
]);
export type ConnectorResponse = z.infer<typeof connectorResponseSchema>;

/**
 * The exact bytes a client signs and the server verifies.
 *
 * ## Why the whole request, not just the nonce
 *
 * `@nexus/devices` signs a server-issued challenge, which is right for proving
 * possession of a key during pairing. It is not enough here. A signature over a
 * nonce alone authenticates the signer but says nothing about what they asked
 * for, so anyone who observed one request could reuse its signature with a
 * different method. Binding method and parameters into the signed bytes makes a
 * captured signature useless for anything but the request it came from.
 *
 * The encoding is explicit and ordered rather than `JSON.stringify` of an
 * object: two parties must agree byte for byte, and object key order is not a
 * contract anybody should bet a signature on.
 */
export function canonicalRequestBytes(input: {
  protocolVersion: number;
  method: ConnectorMethod;
  requestId: string;
  issuedAt: string;
  nonce: string;
  clientId: string;
  params: ConnectorParams;
}): Buffer {
  // Parameters are serialised with sorted keys so the same request always
  // produces the same bytes on both sides.
  const params = canonicalJson(input.params);
  // The method appears twice: on its own line and inside the serialised
  // parameters, whose discriminator is the method. The redundancy is deliberate
  // — removing either one alone changes nothing, and the explicit line keeps the
  // binding obvious to a reader and robust if parameters ever stop carrying the
  // discriminator. Mutation testing confirms both must go before the
  // cross-method replay test fails.
  const canonical = [
    "nexus-connector",
    String(input.protocolVersion),
    input.method,
    input.requestId,
    input.issuedAt,
    input.nonce,
    input.clientId,
    params,
  ].join("\n");
  return Buffer.from(canonical, "utf8");
}

/**
 * Deterministic JSON: object keys sorted, recursively.
 *
 * Not `JSON.stringify(value, sortedKeys)`. The array form of the replacer is an
 * allowlist applied at every depth, so a nested object whose keys differ from
 * the top level silently loses them — which would make two parties sign
 * different bytes and look like a signature bug rather than a serialisation
 * one. Today's parameters are flat; this stays correct when they stop being.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}
