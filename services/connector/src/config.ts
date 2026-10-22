import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "@nexus/shared";
import type { ConnectorListenTarget } from "./http.js";

/**
 * Connector configuration.
 *
 * ## What this file may contain, and what it may never contain
 *
 * Public keys, and nothing else that is secret. A client proves who it is by
 * signing with a private key it keeps; the connector only ever needs the public
 * half. That is why there is no `token`, no `sharedSecret` and no `password`
 * field here, and why the schema is strict so one cannot be smuggled in by a
 * config file nobody re-read.
 *
 * It follows that this file is safe to commit as an example and safe to show in
 * a bug report. That property is worth protecting deliberately.
 */

/** Rejects anything that is not an SPKI PEM public key. */
const publicKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.includes("-----BEGIN PUBLIC KEY-----"), {
    message: "must be an SPKI PEM public key",
  })
  .refine((value) => !value.includes("PRIVATE KEY"), {
    // A private key in a server config is a mistake worth refusing loudly
    // rather than tolerating because it happens to parse.
    message: "must not contain a private key",
  });

export const connectorConfigSchema = z
  .object({
    /** Clients allowed to talk to this connector. An empty list accepts nobody. */
    clients: z
      .array(
        z
          .object({
            clientId: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9._:-]+$/, "must be a plain client identifier"),
            /**
             * The client's single key, in the original one-key shape.
             *
             * Kept so existing configuration files keep working: this is an
             * additive migration, not a replacement. Exactly one of
             * `publicKey` or `keys` must be present, and `keys` is what
             * rotation uses.
             */
            publicKey: publicKeySchema.optional(),
            /**
             * The client's keys, newest last.
             *
             * Rotation is adding a key and revoking the old one, which means
             * both are briefly valid — that overlap is the whole reason
             * rotation needs more than one slot. A revoked key never verifies
             * again, and revoked entries are kept rather than deleted so an
             * operator can see that a key was withdrawn instead of wondering
             * whether it ever existed.
             */
            keys: z
              .array(
                z
                  .object({
                    publicKey: publicKeySchema,
                    /** ISO 8601. Informational; verification does not depend on it. */
                    addedAt: z.string().datetime().optional(),
                    /** ISO 8601. Present means revoked, and a revoked key is refused. */
                    revokedAt: z.string().datetime().optional(),
                    label: z.string().max(100).optional(),
                  })
                  .strict(),
              )
              .max(8)
              .optional(),
            /**
             * Whether this client may talk to the connector at all.
             *
             * Separate from revoking its keys: disabling is reversible and
             * says nothing about whether the key material is compromised.
             */
            enabled: z.boolean().default(true),
            /** Free-text note for whoever reads this file in a year. */
            comment: z.string().max(200).optional(),
          })
          .strict()
          .refine((client) => (client.publicKey === undefined) !== (client.keys === undefined), {
            // Both would be ambiguous about which one rotation should touch;
            // neither would be a client that can never authenticate, which is
            // a configuration mistake worth naming rather than tolerating.
            message: "declare exactly one of publicKey or keys",
          }),
      )
      .max(32),
    listen: z
      .discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("loopback"), port: z.number().int().min(0).max(65_535) })
          .strict(),
        z.object({ kind: z.literal("unix"), path: z.string().min(1).max(4096) }).strict(),
      ])
      .default({ kind: "loopback", port: 8787 }),
    /** How long a signed request stays acceptable, in milliseconds. */
    acceptanceWindowMs: z.number().int().min(1_000).max(300_000).default(30_000),
    /** Tolerated clock difference in either direction, in milliseconds. */
    clockSkewMs: z.number().int().min(0).max(60_000).default(5_000),
  })
  .strict();

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export class ConnectorConfigError extends AppError {
  readonly code = "CONNECTOR_CONFIG_INVALID";
  readonly httpStatus = 500;

  constructor(detail: string) {
    super({
      message: `connector configuration is invalid: ${detail}`,
      userMessage: "The connector is misconfigured.",
    });
  }
}

/** Parses configuration from an already-read value. Pure, so it is testable without a filesystem. */
export function parseConnectorConfig(value: unknown): ConnectorConfig {
  const parsed = connectorConfigSchema.safeParse(value);
  if (!parsed.success) {
    // Issue paths and messages only. A Zod error can quote the offending value,
    // and the offending value in this file is a key.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConnectorConfigError(detail);
  }
  return parsed.data;
}

export async function readConnectorConfig(path: string): Promise<ConnectorConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // The path is named because it is not a secret and is the only thing that
    // makes this actionable.
    throw new ConnectorConfigError(`cannot read ${path}`);
  }
  try {
    return parseConnectorConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ConnectorConfigError) throw error;
    throw new ConnectorConfigError(`${path} is not valid JSON`);
  }
}

/** The listen target, in the shape `startConnector` expects. */
export function listenTargetFrom(config: ConnectorConfig): ConnectorListenTarget {
  return config.listen;
}

/**
 * Flattens a configured client into the keys that may verify a request today.
 *
 * One place decides what "usable key" means, so the authenticator cannot drift
 * from the admin tooling. A disabled client contributes nothing, and a revoked
 * key contributes nothing — both are refusals, reached by different routes and
 * reversed by different actions.
 */
export function usableKeysFor(client: ConnectorConfig["clients"][number]): string[] {
  if (!client.enabled) return [];
  if (client.publicKey !== undefined) return [client.publicKey];
  return (client.keys ?? [])
    .filter((key) => key.revokedAt === undefined)
    .map((key) => key.publicKey);
}

/** Every client that can currently authenticate, in the authenticator's shape. */
export function authenticatorClientsFrom(
  config: ConnectorConfig,
): { clientId: string; publicKeys: string[] }[] {
  return config.clients
    .map((client) => ({ clientId: client.clientId, publicKeys: usableKeysFor(client) }))
    .filter((client) => client.publicKeys.length > 0);
}
