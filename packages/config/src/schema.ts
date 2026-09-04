import { generateKeyPairSync } from "node:crypto";
import { z } from "zod";

/**
 * Clé de signature éphémère.
 *
 * Produite une fois par processus. En production, `AUTH_SIGNING_KEY` doit être
 * fournie : sans elle, un redémarrage invaliderait toutes les sessions, et deux
 * réplicas n'accepteraient pas les jetons l'un de l'autre.
 */
const ephemeralSigningKey = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/**
 * Schéma de configuration.
 *
 * Règle du projet : toute variable d'environnement lue par NEXUS est déclarée ici.
 * Aucun `process.env.X` ne traîne ailleurs dans le code — c'est ce qui garantit
 * que `.env.example` reste vrai et qu'une clé manquante fait échouer le démarrage
 * plutôt que la première requête à 3 h du matin.
 */

const isUrl = (protocols: readonly string[]) => (value: string) => {
  if (!URL.canParse(value)) return false;
  return protocols.includes(new URL(value).protocol);
};

const csv = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.string()));

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    // Version exposée par l'API. Le pipeline de déploiement y injecte le SHA du
    // commit ; en local, la valeur du paquet suffit.
    API_VERSION: z.string().min(1).default("0.1.0"),
    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    CORS_ORIGINS: csv.default(["http://localhost:3000"]),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
    RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),

    DATABASE_URL: z
      .string()
      .refine(isUrl(["postgres:", "postgresql:"]), "doit être une URL postgresql://"),

    /**
     * Clé privée Ed25519 (PEM PKCS8) qui signe les jetons.
     *
     * Générée au déploiement, jamais commitée. En développement et en test, une
     * clé éphémère est produite au démarrage : les jetons ne survivent alors pas
     * à un redémarrage, ce qui est exactement le comportement souhaité hors
     * production.
     */
    AUTH_SIGNING_KEY: z.string().min(1).default(ephemeralSigningKey),

    REDIS_URL: z.string().refine(isUrl(["redis:", "rediss:"]), "doit être une URL redis://"),
  })
  .superRefine((config, ctx) => {
    // Un joker CORS en production annule l'intérêt de la liste d'origines.
    if (config.NODE_ENV === "production" && config.CORS_ORIGINS.includes("*")) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: "CORS_ORIGINS ne peut pas contenir '*' en production",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
