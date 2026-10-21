import { existsSync } from "node:fs";
import { ConfigurationError } from "@nexus/shared";
import { configSchema, type AppConfig } from "./schema.js";

/**
 * Charge un fichier .env dans process.env s'il existe.
 *
 * Utilise `process.loadEnvFile` (natif depuis Node 20.12) plutôt que `dotenv` :
 * une dépendance de moins, et le même comportement que `node --env-file`.
 * Les variables déjà présentes dans l'environnement ne sont pas écrasées côté
 * conteneur, puisqu'en production aucun fichier .env n'est déployé.
 */
export function loadDotEnv(path: string): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

/**
 * Valide un environnement et retourne la configuration typée.
 * Fonction pure : c'est elle qu'on teste, sans toucher à `process.env`.
 */
export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(racine)"} — ${issue.message}`)
      .join("\n");

    throw new ConfigurationError({
      message: `Configuration invalide :\n${details}`,
      userMessage: "The service is misconfigured.",
      context: { issues: result.error.issues },
    });
  }

  return result.data;
}

let cached: AppConfig | undefined;

/**
 * Configuration du processus courant. Résolue une fois, puis mémorisée :
 * la configuration ne change pas pendant la vie d'un processus.
 */
export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Réservé aux tests : oublie la configuration mémorisée. */
export function resetConfigCache(): void {
  cached = undefined;
}
