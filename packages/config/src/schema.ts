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

/**
 * Origines de la coquille de bureau Tauri.
 *
 * **Toujours acceptées, et non configurables.** Ce ne sont pas des adresses
 * réseau : ce sont les origines que la WebView attribue à l'application
 * installée sur la machine — `http://tauri.localhost` sous Windows,
 * `tauri://localhost` sous macOS et Linux. Elles ne désignent aucun serveur
 * joignable, et un site web ne peut pas les usurper : c'est le navigateur qui
 * pose l'en-tête `Origin`, jamais la page.
 *
 * Les inscrire ici plutôt que dans `.env` répare un piège réel : le client
 * Windows empaqueté était refusé par la validation d'origine du canal
 * `/ws/client` — 403 à la poignée de main — parce qu'aucun déploiement ne
 * pensait à les ajouter. Une valeur que tout le monde doit fournir et que
 * personne ne connaît n'est pas une configuration, c'est un défaut.
 *
 * La vérification d'origine, elle, reste entière : rien d'autre n'est élargi.
 */
export const TAURI_ORIGINS = ["http://tauri.localhost", "tauri://localhost"] as const;

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    // Version exposée par l'API. Le pipeline de déploiement y injecte le SHA du
    // commit ; en local, la valeur du paquet suffit.
    API_VERSION: z.string().min(1).default("0.1.0"),
    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    /**
     * Origines acceptées, pour CORS **et** pour la poignée de main WebSocket.
     *
     * Les origines Tauri y sont ajoutées d'office (voir `TAURI_ORIGINS`) : le
     * client de bureau ne peut pas se connecter sans elles, et les demander à
     * chaque déploiement revenait à casser l'application par défaut.
     */
    CORS_ORIGINS: csv.optional(),
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

    /**
     * Adresse publique de l'API, telle qu'un appareil doit l'appeler.
     *
     * Nécessaire pour l'appairage par QR, et explicite plutôt que déduite de
     * l'en-tête `Host` : cet en-tête est choisi par l'appelant, et un QR qui en
     * dériverait son adresse laisserait n'importe quelle requête décider où un
     * téléphone enverra sa clé publique. Un réglage se relit et s'audite ; un
     * en-tête, non.
     *
     * Absente, l'appairage par QR est refusé avec un message qui nomme ce
     * réglage — plutôt que de produire un QR qui mène au mauvais endroit.
     */
    PUBLIC_API_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine((value) => {
          if (!URL.canParse(value)) return false;
          const url = new URL(value);
          if (url.username || url.password) return false;
          const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
          // Un réseau local est le cas d'usage normal : le téléphone et le cœur
          // sont sur le même Wi-Fi. HTTPS reste exigé dès qu'on sort de là.
          const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
          return (
            url.protocol === "https:" || (url.protocol === "http:" && (loopback || privateHost))
          );
        }, "doit être une URL HTTPS, ou HTTP sur la boucle locale ou un réseau privé")
        .optional(),
    ),

    /** Moteur NEXUS ACP/paper-trading, optionnel. */
    MISSION_CONTROL_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine((value) => {
          if (!URL.canParse(value)) return false;
          const url = new URL(value);
          const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
          return url.protocol === "https:" || (url.protocol === "http:" && loopback);
        }, "doit être une URL HTTPS ou une URL HTTP de boucle locale")
        .optional(),
    ),

    /** Métamoteur local optionnel. Aucun compte ni clé API n'est nécessaire. */
    SEARXNG_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine((value) => {
          if (!URL.canParse(value)) return false;
          const url = new URL(value);
          if (url.username || url.password) return false;
          if (url.protocol === "https:") return true;
          if (url.protocol !== "http:") return false;
          return (
            ["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
            !url.hostname.includes(".") ||
            url.hostname.endsWith(".internal")
          );
        }, "doit être HTTPS ou un service HTTP local/interne, sans credentials")
        .optional(),
    ),
    SEARXNG_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  })
  /**
   * Les origines par défaut dépendent de l'environnement, et cet
   * environnement est celui qu'on vient de lire — pas celui du processus.
   *
   * La différence n'est pas théorique : `parseConfig` reçoit un objet
   * d'environnement explicite, et faire dépendre un défaut de `process.env`
   * rendait le résultat différent selon le processus qui appelle. Une même
   * entrée doit produire une même sortie, sous vitest comme en production.
   */
  .transform((config) => ({
    ...config,
    CORS_ORIGINS: [
      ...new Set([
        ...(config.CORS_ORIGINS ??
          (config.NODE_ENV === "production"
            ? // En production, rien n'est ouvert par défaut : les origines
              // réellement servies sont déclarées au déploiement.
              []
            : // En développement, les trois coquilles locales — l'API elle-même,
              // la fenêtre Vite du client de bureau, le serveur Expo du mobile.
              ["http://localhost:3000", "http://localhost:5273", "http://localhost:8081"])),
        ...TAURI_ORIGINS,
      ]),
    ],
  }))
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
