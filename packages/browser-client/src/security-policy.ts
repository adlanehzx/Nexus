import { URL } from "node:url";
import type { PageInfo } from "./harness-driver.js";

export interface BrowserSecurityOptions {
  allowLocalhost?: boolean;
  allowedDomains?: string[];
  deniedDomains?: string[];
}

export class BrowserSecurityError extends Error {
  readonly code: string;
  constructor(message: string, code = "BROWSER_SECURITY_ERROR") {
    super(message);
    this.name = "BrowserSecurityError";
    this.code = code;
  }
}

export class HumanInterventionRequiredError extends Error {
  readonly code = "HUMAN_INTERVENTION_REQUIRED";
  readonly reason: string;
  readonly pageUrl: string;
  constructor(reason: string, pageUrl: string) {
    super(`Intervention humaine requise sur ${pageUrl} : ${reason}`);
    this.name = "HumanInterventionRequiredError";
    this.reason = reason;
    this.pageUrl = pageUrl;
  }
}

const DANGEROUS_DOWNLOAD_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".sh",
  ".ps1",
  ".apk",
  ".bin",
  ".elf",
  ".msi",
  ".scr",
  ".vbs",
  ".iso",
  ".dmg",
  ".app",
  ".jar",
]);

const FORBIDDEN_SCHEMES = new Set(["file:", "chrome:", "javascript:", "about:", "data:", "blob:"]);

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./, // AWS / cloud metadata
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^localhost$/i,
];

const CAPTCHA_OR_MFA_KEYWORDS = [
  "captcha",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "cloudflare challenge",
  "verify you are human",
  "vérifiez que vous êtes un humain",
  "two-factor authentication",
  "authentification à deux facteurs",
  "enter verification code",
  "code de vérification",
  "security check",
  "robot check",
  "human verification",
];

/**
 * Politique de sécurité pour la navigation web native dans NEXUS.
 */
export class BrowserSecurityPolicy {
  readonly #allowLocalhost: boolean;
  readonly #allowedDomains?: Set<string> | undefined;
  readonly #deniedDomains?: Set<string> | undefined;

  constructor(options: BrowserSecurityOptions = {}) {
    this.#allowLocalhost = options.allowLocalhost ?? false;
    this.#allowedDomains = options.allowedDomains
      ? new Set(options.allowedDomains.map((d) => d.toLowerCase()))
      : undefined;
    this.#deniedDomains = options.deniedDomains
      ? new Set(options.deniedDomains.map((d) => d.toLowerCase()))
      : undefined;
  }

  /**
   * Valide une URL avant navigation.
   * Lève une BrowserSecurityError si l'URL est interdite ou suspecte.
   */
  assertUrlSafe(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BrowserSecurityError(`URL syntaxiquement invalide : ${rawUrl}`, "INVALID_URL");
    }

    // 1. Schémas autorisés
    if (FORBIDDEN_SCHEMES.has(parsed.protocol)) {
      throw new BrowserSecurityError(
        `Schéma d'URL interdit pour la navigation (${parsed.protocol}). Seuls http: et https: sont autorisés.`,
        "FORBIDDEN_SCHEME",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserSecurityError(
        `Protocole non supporté : ${parsed.protocol}. Seuls http: et https: sont autorisés.`,
        "UNSUPPORTED_PROTOCOL",
      );
    }

    // 2. Protection contre les téléchargements dangereux dès l'URL
    const pathname = parsed.pathname.toLowerCase();
    for (const ext of DANGEROUS_DOWNLOAD_EXTENSIONS) {
      if (pathname.endsWith(ext)) {
        throw new BrowserSecurityError(
          `Téléchargement de fichier exécutable interdit (${ext}). NEXUS refuse l'acquisition de fichiers exécutables.`,
          "FORBIDDEN_EXECUTABLE_DOWNLOAD",
        );
      }
    }

    // 3. Protection SSRF & boucles locales
    const hostname = parsed.hostname.toLowerCase();
    if (!this.#allowLocalhost) {
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          throw new BrowserSecurityError(
            `Navigation vers une adresse privée ou locale interdite (${hostname}) pour des raisons de sécurité SSRF.`,
            "SSRF_LOOPBACK_FORBIDDEN",
          );
        }
      }
    }

    // 4. Domaines refusés
    if (this.#deniedDomains && this.#deniedDomains.has(hostname)) {
      throw new BrowserSecurityError(
        `Accès au domaine ${hostname} explicitement refusé par la politique.`,
        "DOMAIN_DENIED",
      );
    }

    // 5. Domaines restreints
    if (this.#allowedDomains && !this.#allowedDomains.has(hostname)) {
      throw new BrowserSecurityError(
        `Domaine ${hostname} non autorisé par la liste blanche.`,
        "DOMAIN_NOT_ALLOWED",
      );
    }

    return parsed;
  }

  /**
   * Analyse une page pour détecter les besoins d'intervention humaine (CAPTCHA, MFA, login).
   */
  detectHumanIntervention(info: PageInfo, sampleText = ""): { required: boolean; reason?: string } {
    const haystack = `${info.title} ${sampleText}`.toLowerCase();
    for (const keyword of CAPTCHA_OR_MFA_KEYWORDS) {
      if (haystack.includes(keyword)) {
        return {
          required: true,
          reason: `Détection d'un défi de sécurité ou vérification humaine ('${keyword}').`,
        };
      }
    }
    return { required: false };
  }
}
