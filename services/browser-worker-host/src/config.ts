import { z } from "zod";
import { WorkerConfigurationError } from "@nexus/worker-core";

/**
 * Configuration de l'hôte du worker navigateur.
 *
 * Deux extrémités à raccorder, et donc deux jeux de variables :
 *
 *  - **vers le cœur** — les mêmes que le worker Windows et le worker Android :
 *    `NEXUS_BACKEND_URL`, `DEVICE_ID`, la clé de l'appareil. C'est ce qui fait
 *    de Browser Use un exécutant de la flotte plutôt qu'un service à part.
 *  - **vers le worker Python** — `BROWSER_WORKER_URL` et son jeton de service,
 *    c'est-à-dire le contrat HTTP existant, inchangé (ADR-006).
 *
 * **Aucun secret n'est codé ici.** La clé de l'appareil est un chemin de
 * fichier, le jeton du worker Python vient de l'environnement, et rien n'est
 * journalisé — `describe()` ne rend que les noms des variables.
 */

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const csvList = (fallback = "") => z.string().default(fallback).transform(csv);

export const browserHostConfigSchema = z.object({
  // ── Vers le cœur ─────────────────────────────────────────────────────────
  /** Cœur NEXUS. Une adresse distante doit être en `wss://`. */
  NEXUS_BACKEND_URL: z.string().url(),
  /** Attribué par le cœur à l'appairage. Public : il n'authentifie rien. */
  DEVICE_ID: z.string().min(1),
  /** Chemin de la clé privée Ed25519 de l'appareil, au format PEM. */
  DEVICE_KEY_PATH: z.string().min(1),

  // ── Vers le worker Python ────────────────────────────────────────────────
  /** Worker Browser Use. Jamais exposé à Internet — réseau interne seulement. */
  BROWSER_WORKER_URL: z.string().url().default("http://127.0.0.1:8100"),
  /**
   * Jeton de service du worker Python.
   *
   * Ce n'est **pas** l'authentification de NEXUS : celle-ci se joue sur la
   * signature du challenge, plus haut. Ce jeton protège un lien interne entre
   * deux processus qui tournent sur la même machine ou dans le même réseau
   * Docker. Les deux existent, et aucun ne remplace l'autre.
   */
  BROWSER_WORKER_TOKEN: z.string().min(16),

  // ── Capacités et politique ───────────────────────────────────────────────
  /** Capacités exposées. Vide = toutes celles réellement disponibles. */
  WORKER_CAPABILITIES: csvList(),
  /**
   * Domaines navigables. **Vide = aucune restriction côté liste blanche** —
   * les refus absolus du worker Python (boucle locale, plages privées, points
   * de métadonnées cloud) s'appliquent de toute façon.
   */
  BROWSER_ALLOWED_DOMAINS: csvList(),
  BROWSER_PROHIBITED_DOMAINS: csvList(),

  /** Étapes maximales d'une tâche de navigation, sauf demande plus basse. */
  BROWSER_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(15),
  /** Durée de vie d'une session navigateur inactive, côté worker Python. */
  BROWSER_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(600),
  /** `false` pour voir le navigateur. Utile au débogage, jamais en service. */
  BROWSER_HEADLESS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  // ── Cycle de vie ─────────────────────────────────────────────────────────
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  /** Une navigation est longue : quinze minutes, comme l'outil historique. */
  WORKER_TASK_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(900_000),
  /** Un Chromium consomme de 300 Mo à 1 Go. Trois de front est déjà beaucoup. */
  WORKER_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(8).default(2),

  WORKER_RECONNECT_MIN_MS: z.coerce.number().int().min(100).default(2_000),
  WORKER_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).default(120_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface BrowserHostConfig {
  backendUrl: string;
  deviceId: string;
  deviceKeyPath: string;

  browserWorkerUrl: string;
  browserWorkerToken: string;

  declaredCapabilities: string[];
  allowedDomains: string[];
  prohibitedDomains: string[];

  maxSteps: number;
  sessionTtlSeconds: number;
  headless: boolean;

  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Valide et normalise la configuration.
 *
 * @throws {WorkerConfigurationError} sur toute variable manquante ou aberrante.
 *   L'hôte refuse de démarrer plutôt que de s'annoncer au cœur sans savoir
 *   joindre le navigateur : il se ferait choisir par le sélecteur, puis
 *   échouerait tâche après tâche.
 */
export function loadBrowserHostConfig(env: Record<string, string | undefined>): BrowserHostConfig {
  const parsed = browserHostConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new WorkerConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} : ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const issues: string[] = [];

  // Le lien vers le cœur traverse potentiellement Internet.
  const core = new URL(raw.NEXUS_BACKEND_URL);
  const coreLocal = core.hostname === "localhost" || core.hostname === "127.0.0.1";
  if (!coreLocal && (core.protocol === "ws:" || core.protocol === "http:")) {
    issues.push("NEXUS_BACKEND_URL : une adresse distante doit utiliser wss:// ou https://");
  }

  // Le lien vers le worker Python, lui, est interne par construction. On refuse
  // qu'il soit distant en clair pour la même raison, et on rappelle que ce
  // worker ne doit jamais être publié.
  const browser = new URL(raw.BROWSER_WORKER_URL);
  const browserLocal =
    browser.hostname === "localhost" ||
    browser.hostname === "127.0.0.1" ||
    // Nom de service Docker : pas de point, donc pas un nom public.
    !browser.hostname.includes(".");
  if (!browserLocal && browser.protocol === "http:") {
    issues.push(
      "BROWSER_WORKER_URL : une adresse distante doit utiliser https://. Ce worker n'est jamais exposé à Internet.",
    );
  }

  if (raw.WORKER_RECONNECT_MAX_MS <= raw.WORKER_RECONNECT_MIN_MS) {
    issues.push("WORKER_RECONNECT_MAX_MS doit dépasser WORKER_RECONNECT_MIN_MS");
  }

  if (issues.length > 0) throw new WorkerConfigurationError(issues);

  return {
    backendUrl: raw.NEXUS_BACKEND_URL,
    deviceId: raw.DEVICE_ID,
    deviceKeyPath: raw.DEVICE_KEY_PATH,

    browserWorkerUrl: raw.BROWSER_WORKER_URL,
    browserWorkerToken: raw.BROWSER_WORKER_TOKEN,

    declaredCapabilities: raw.WORKER_CAPABILITIES,
    allowedDomains: raw.BROWSER_ALLOWED_DOMAINS,
    prohibitedDomains: raw.BROWSER_PROHIBITED_DOMAINS,

    maxSteps: raw.BROWSER_MAX_STEPS,
    sessionTtlSeconds: raw.BROWSER_SESSION_TTL_SECONDS,
    headless: raw.BROWSER_HEADLESS,

    heartbeatIntervalMs: raw.WORKER_HEARTBEAT_INTERVAL_MS,
    taskTimeoutMs: raw.WORKER_TASK_TIMEOUT_MS,
    maxConcurrentTasks: raw.WORKER_MAX_CONCURRENT_TASKS,
    reconnectMinMs: raw.WORKER_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.WORKER_RECONNECT_MAX_MS,
    logLevel: raw.LOG_LEVEL,
  };
}

/** Diagnostic sans secret : les noms des variables, jamais leurs valeurs. */
export function describeConfig(config: BrowserHostConfig): Record<string, unknown> {
  return {
    deviceId: config.deviceId,
    backendUrl: config.backendUrl,
    browserWorkerUrl: config.browserWorkerUrl,
    // Présence, pas contenu.
    browserWorkerToken: config.browserWorkerToken.length > 0 ? "[défini]" : "[absent]",
    declaredCapabilities: config.declaredCapabilities,
    allowedDomains: config.allowedDomains,
    prohibitedDomains: config.prohibitedDomains,
    headless: config.headless,
    maxConcurrentTasks: config.maxConcurrentTasks,
  };
}
