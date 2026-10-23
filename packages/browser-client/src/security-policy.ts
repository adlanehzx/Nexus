import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

const ALWAYS_PROHIBITED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",
  "metadata.google.internal",
  "::1",
  "[::1]",
]);

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const [b0, b1] = parts;
    if (b0 === 127) return true; // loopback
    if (b0 === 10) return true; // private RFC 1918
    if (b0 === 172 && b1 !== undefined && b1 >= 16 && b1 <= 31) return true; // private RFC 1918
    if (b0 === 192 && b1 === 168) return true; // private RFC 1918
    if (b0 === 169 && b1 === 254) return true; // link-local metadata
    if (b0 === 100 && b1 !== undefined && b1 >= 64 && b1 <= 127) return true; // CGNAT
    if (b0 === 0) return true;
    if (b0 !== undefined && b0 >= 224) return true; // multicast & reserved
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (
      lower.startsWith("fe80:") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true; // link-local
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.includes("::ffff:")) {
      const rest = lower.split("::ffff:")[1];
      if (rest) {
        if (rest.includes(".")) {
          const b0 = Number(rest.split(".")[0]);
          return b0 === 127 || b0 === 10 || b0 === 0 || b0 === 169 || (b0 === 192 && rest.startsWith("192.168."));
        }
        const [h0] = rest.split(":");
        if (h0) {
          const num = parseInt(h0, 16);
          const b0 = (num >> 8) & 0xff;
          const b1 = num & 0xff;
          if (b0 === 127 || b0 === 10 || b0 === 0) return true;
          if (b0 === 192 && b1 === 168) return true;
          if (b0 === 169 && b1 === 254) return true;
          if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
        }
      }
    }
    return false;
  }
  return false;
}

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
export type ScopedBrowserAction =
  | "navigate"
  | "interact"
  | "download"
  | "upload"
  | "clipboard"
  | "credentials"
  | "profile";

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
    const rawHostname = parsed.hostname.toLowerCase();
    const hostname =
      rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;

    if (!this.#allowLocalhost) {
      if (ALWAYS_PROHIBITED_HOSTS.has(rawHostname) || ALWAYS_PROHIBITED_HOSTS.has(hostname)) {
        throw new BrowserSecurityError(
          `Navigation to internal or cloud metadata endpoint forbidden (${rawHostname}) for SSRF security.`,
          "SSRF_LOOPBACK_FORBIDDEN",
        );
      }

      if (isPrivateIp(hostname)) {
        throw new BrowserSecurityError(
          `Navigation to private or loopback address forbidden (${rawHostname}) for SSRF security.`,
          "SSRF_LOOPBACK_FORBIDDEN",
        );
      }

      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(rawHostname) || pattern.test(hostname)) {
          throw new BrowserSecurityError(
            `Navigation to private or loopback address forbidden (${rawHostname}) for SSRF security.`,
            "SSRF_LOOPBACK_FORBIDDEN",
          );
        }
      }

      // Check non-standard decimal, octal or hex formats
      if (/^\d+$/.test(hostname) || hostname.startsWith("0x") || hostname.includes(".0x")) {
        throw new BrowserSecurityError(
          `Navigation to non-standard IP format forbidden (${rawHostname}) for SSRF security.`,
          "SSRF_LOOPBACK_FORBIDDEN",
        );
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

  /**
   * Asynchronously validates navigation target with DNS resolution to defeat DNS rebinding attacks.
   */
  async assertSafeNavigation(rawUrl: string): Promise<URL> {
    const parsed = this.assertUrlSafe(rawUrl);
    if (!this.#allowLocalhost) {
      const rawHostname = parsed.hostname.toLowerCase();
      const hostname =
        rawHostname.startsWith("[") && rawHostname.endsWith("]")
          ? rawHostname.slice(1, -1)
          : rawHostname;

      if (!isIP(hostname)) {
        try {
          const addresses = await lookup(hostname, { all: true });
          for (const addr of addresses) {
            if (isPrivateIp(addr.address)) {
              throw new BrowserSecurityError(
                `Domain "${hostname}" resolves to private/reserved IP "${addr.address}". Blocked for SSRF protection.`,
                "SSRF_LOOPBACK_FORBIDDEN",
              );
            }
          }
        } catch (error) {
          if (error instanceof BrowserSecurityError) throw error;
          throw new BrowserSecurityError(
            `DNS resolution failed for "${hostname}": ${error instanceof Error ? error.message : String(error)}`,
            "DNS_RESOLUTION_FAILED",
          );
        }
      }
    }
    return parsed;
  }

  /**
   * Enforces scoped permissions for downloads, uploads, clipboard, credentials, and profiles.
   */
  assertScopedPermission(
    action: "navigate" | "interact" | "download" | "upload" | "clipboard" | "credentials" | "profile",
    grantedPermissions: readonly string[],
  ): void {
    const required: Record<ScopedBrowserAction, string> = {
      navigate: "browser.navigate",
      interact: "browser.interact",
      download: "browser.download",
      upload: "browser.upload",
      clipboard: "browser.clipboard",
      credentials: "browser.login",
      profile: "browser.profile",
    };

    const needed = required[action] ?? `browser.${action}`;
    const allowed =
      grantedPermissions.includes("*") ||
      grantedPermissions.includes(needed) ||
      grantedPermissions.some((p) => p.endsWith(".*") && needed.startsWith(p.slice(0, -1))) ||
      (action === "download" && grantedPermissions.includes("browser.interact"));

    if (!allowed) {
      throw new BrowserSecurityError(
        `Missing required scoped permission "${needed}" for browser action "${action}".`,
        "INSUFFICIENT_BROWSER_PERMISSION",
      );
    }
  }
}
