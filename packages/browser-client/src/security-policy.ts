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
    super(`Human intervention required on ${pageUrl}: ${reason}`);
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
  "two-factor authentication",
  "enter verification code",
  "security check",
  "robot check",
  "human verification",
];

/**
 * Security policy for native web browsing in NEXUS.
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
   * Validates a URL before navigation.
   * Throws BrowserSecurityError if URL is prohibited.
   */
  assertUrlSafe(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BrowserSecurityError(`Syntactically invalid URL: ${rawUrl}`, "INVALID_URL");
    }

    // 1. Permitted schemes
    if (FORBIDDEN_SCHEMES.has(parsed.protocol)) {
      throw new BrowserSecurityError(
        `Forbidden URL scheme for navigation (${parsed.protocol}). Only http: and https: are allowed.`,
        "FORBIDDEN_SCHEME",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserSecurityError(
        `Unsupported protocol: ${parsed.protocol}. Only http: and https: are allowed.`,
        "UNSUPPORTED_PROTOCOL",
      );
    }

    // 2. Dangerous download prevention
    const pathname = parsed.pathname.toLowerCase();
    for (const ext of DANGEROUS_DOWNLOAD_EXTENSIONS) {
      if (pathname.endsWith(ext)) {
        throw new BrowserSecurityError(
          `Executable file download forbidden (${ext}). NEXUS refuses acquisition of executables.`,
          "FORBIDDEN_EXECUTABLE_DOWNLOAD",
        );
      }
    }

    // 3. SSRF & loopback protection
    const hostname = parsed.hostname.toLowerCase();
    if (!this.#allowLocalhost) {
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          throw new BrowserSecurityError(
            `Navigation to private or loopback address forbidden (${hostname}) for SSRF security.`,
            "SSRF_LOOPBACK_FORBIDDEN",
          );
        }
      }
    }

    // 4. Denied domains
    if (this.#deniedDomains && this.#deniedDomains.has(hostname)) {
      throw new BrowserSecurityError(
        `Access to domain ${hostname} explicitly denied by policy.`,
        "DOMAIN_DENIED",
      );
    }

    // 5. Allowed domains whitelist
    if (this.#allowedDomains && !this.#allowedDomains.has(hostname)) {
      throw new BrowserSecurityError(
        `Domain ${hostname} not permitted by whitelist.`,
        "DOMAIN_NOT_ALLOWED",
      );
    }

    return parsed;
  }

  /**
   * Evaluates page info to detect need for human intervention (CAPTCHA, MFA, login).
   */
  detectHumanIntervention(info: PageInfo, sampleText = ""): { required: boolean; reason?: string } {
    const haystack = `${info.title} ${sampleText}`.toLowerCase();
    for (const keyword of CAPTCHA_OR_MFA_KEYWORDS) {
      if (haystack.includes(keyword)) {
        return {
          required: true,
          reason: `Detected security challenge or human verification check ('${keyword}').`,
        };
      }
    }
    return { required: false };
  }
}
