import { generateKeyPairSync } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Ephemeral signing key.
 *
 * Generated once per process. In production, `AUTH_SIGNING_KEY` must be
 * provided: without it, a restart invalidates all sessions, and two replicas
 * will not accept each other's tokens.
 */
const ephemeralSigningKey = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/**
 * Configuration schema.
 *
 * Project rule: every environment variable read by NEXUS is declared here.
 * No `process.env.X` lingers elsewhere in the codebase — ensuring `.env.example`
 * stays accurate and missing variables fail fast at boot rather than on the
 * first request at 3 AM.
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

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());

const optionalAbsolutePath = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).refine(isAbsolute, "must be an absolute path").optional(),
);

const modelPricingSchema = z.record(
  z.string().min(1),
  z.object({
    /** API equivalent in USD per million tokens, never an actual invoice. */
    inputPerMillionUsd: z.number().nonnegative(),
    outputPerMillionUsd: z.number().nonnegative(),
    cacheReadPerMillionUsd: z.number().nonnegative().default(0),
    cacheWritePerMillionUsd: z.number().nonnegative().default(0),
  }),
);

const modelPricing = z.preprocess((value, ctx) => {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "must contain a valid JSON object" });
    return z.NEVER;
  }
}, modelPricingSchema);

/**
 * Tauri desktop shell origins.
 *
 * **Always accepted, and non-configurable.** These are not network addresses:
 * they are the origins assigned by WebView to the application installed on the
 * host — `http://tauri.localhost` on Windows, `tauri://localhost` on macOS and
 * Linux. They do not target reachable network servers, and a website cannot
 * spoof them: the browser sets the `Origin` header, never the page.
 *
 * Hardcoding them here rather than in `.env` avoids a common trap: packaged
 * Windows desktop clients were rejected during origin validation on `/ws/client`
 * — 403 on handshake — because deployments omitted them from CORS_ORIGINS.
 * A value every deployment must provide that no one remembers is not configuration,
 * it is a defect.
 *
 * Origin verification remains otherwise strict: nothing else is relaxed.
 */
export const TAURI_ORIGINS = ["http://tauri.localhost", "tauri://localhost"] as const;

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    // API version. The deployment pipeline injects the commit SHA; in local dev,
    // the package version suffices.
    API_VERSION: z.string().min(1).default("0.1.0"),
    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    /**
     * Accepted origins for CORS **and** WebSocket handshakes.
     *
     * Tauri origins are included automatically (see `TAURI_ORIGINS`): the
     * desktop client cannot connect without them, and requiring them explicitly
     * in every deployment broke the application out of the box.
     */
    CORS_ORIGINS: csv.optional(),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
    RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),

    // Local observability. Prometheus uses a distinct port, unpublished by
    // default; OTLP remains optional so local development never depends on an
    // external collector.
    METRICS_ENABLED: envBoolean.default(true),
    METRICS_HOST: z.string().min(1).default("127.0.0.1"),
    METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
    OTEL_SERVICE_NAME: z.string().min(1).max(100).default("nexus-api"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(isUrl(["http:", "https:"]), "must be an HTTP(S) URL")
        .optional(),
    ),
    MODEL_PRICING_JSON: modelPricing.default({}),

    // Local semantic memory. The neural backend uses ONNX and disk caching;
    // `hash` remains available for constrained hardware.
    MEMORY_EMBEDDING_BACKEND: z.enum(["neural", "hash"]).default("neural"),
    MEMORY_EMBEDDING_MODEL: z
      .string()
      .min(1)
      .default("Xenova/paraphrase-multilingual-MiniLM-L12-v2"),
    MEMORY_EMBEDDING_CACHE_DIR: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    MEMORY_EMBEDDING_LOCAL_ONLY: envBoolean.default(false),

    DATABASE_URL: z
      .string()
      .refine(isUrl(["postgres:", "postgresql:"]), "must be a postgresql:// URL"),

    /**
     * Ed25519 private key (PEM PKCS8) signing auth tokens.
     *
     * Generated upon deployment, never committed. In development and test, an
     * ephemeral key is generated at startup: tokens do not survive restarts,
     * which is the desired behavior outside production.
     */
    AUTH_SIGNING_KEY: z.string().min(1).default(ephemeralSigningKey),

    REDIS_URL: z.string().refine(isUrl(["redis:", "rediss:"]), "must be a redis:// URL"),

    /**
     * Expected worker version, used to flag outdated workers.
     *
     * **Advisory only.** NEXUS does not auto-update workers: there is no channel
     * for remote code execution, by design. This setting simply alerts that an
     * agent machine is outdated.
     *
     * If absent, no opinion is rendered.
     */
    EXPECTED_WORKER_VERSION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "must be a semantic version")
        .optional(),
    ),

    /**
     * Public API URL that devices connect to.
     *
     * Required for QR pairing and explicit rather than inferred from the `Host`
     * header: callers choose the `Host` header, and deriving pairing addresses
     * from it would allow any caller to direct pairing traffic to an arbitrary
     * host. Settings can be reviewed and audited; headers cannot.
     *
     * If absent, QR pairing is rejected with a message identifying this setting.
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
          // Local network is the primary use case: phone and core on the same Wi-Fi.
          // HTTPS is required whenever outside local loopback or private ranges.
          const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
          return (
            url.protocol === "https:" || (url.protocol === "http:" && (loopback || privateHost))
          );
        }, "must be an HTTPS URL, or HTTP on loopback or private network")
        .optional(),
    ),

    /** Persistent directories, decoupled from code in read-only container images. */
    NEXUS_RUNTIME_CONFIG_DIR: optionalAbsolutePath,
    NEXUS_BROWSER_ARTIFACTS_DIR: optionalAbsolutePath,
    NEXUS_OBSERVABILITY_DIR: optionalAbsolutePath,

    /** NEXUS ACP / paper-trading engine, optional. */
    MISSION_CONTROL_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine((value) => {
          if (!URL.canParse(value)) return false;
          const url = new URL(value);
          const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
          return url.protocol === "https:" || (url.protocol === "http:" && loopback);
        }, "must be an HTTPS URL or loopback HTTP URL")
        .optional(),
    ),

    /** Optional local SearXNG meta-search engine. No account or API key required. */
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
        }, "must be HTTPS or a local/internal HTTP service, without credentials")
        .optional(),
    ),
    SEARXNG_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  })
  /**
   * Default origins depend on the environment parsed from input — not process.env.
   *
   * Pure parsing: `parseConfig` receives an explicit env object; relying on
   * `process.env` made parsing non-deterministic depending on caller state.
   */
  .transform((config) => ({
    ...config,
    CORS_ORIGINS: [
      ...new Set([
        ...(config.CORS_ORIGINS ??
          (config.NODE_ENV === "production"
            ? // In production, nothing is open by default: served origins must be declared.
              []
            : // In development, the local shells: API, desktop Vite window, Expo mobile.
              ["http://localhost:3000", "http://localhost:5273", "http://localhost:8081"])),
        ...TAURI_ORIGINS,
      ]),
    ],
  }))
  .superRefine((config, ctx) => {
    // A CORS wildcard in production defeats origin security.
    if (config.NODE_ENV === "production" && config.CORS_ORIGINS.includes("*")) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: "CORS_ORIGINS cannot contain '*' in production",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
