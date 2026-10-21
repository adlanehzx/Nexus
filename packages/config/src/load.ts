import { existsSync } from "node:fs";
import { ConfigurationError } from "@nexus/shared";
import { configSchema, type AppConfig } from "./schema.js";

/**
 * Loads a .env file into process.env if it exists.
 *
 * Uses native `process.loadEnvFile` (Node 20.12+) rather than `dotenv`:
 * one less dependency, and identical behavior to `node --env-file`.
 * Existing environment variables are preserved.
 */
export function loadDotEnv(path: string): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

/**
 * Validates an environment object and returns strongly-typed configuration.
 * Pure function: testable without mutating `process.env`.
 */
export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"} — ${issue.message}`)
      .join("\n");

    throw new ConfigurationError({
      message: `Invalid configuration:\n${details}`,
      userMessage: "The service is misconfigured.",
      context: { issues: result.error.issues },
    });
  }

  return result.data;
}

let cached: AppConfig | undefined;

/**
 * Current process configuration. Resolved once and cached:
 * configuration does not change during the lifecycle of a process.
 */
export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Test utility: resets cached configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}
