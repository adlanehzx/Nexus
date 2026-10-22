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
            publicKey: publicKeySchema,
            /** Free-text note for whoever reads this file in a year. */
            comment: z.string().max(200).optional(),
          })
          .strict(),
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
