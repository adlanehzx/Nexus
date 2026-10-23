import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { McpSecurityError } from "./errors.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
]);

/**
 * Checks if an IP address belongs to loopback, RFC 1918 private,
 * link-local (cloud metadata), carrier-grade NAT, or reserved multicast ranges.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4 validation
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const [b0, b1] = parts;
    if (b0 === 127) return true; // Loopback 127.0.0.0/8
    if (b0 === 10) return true; // Private RFC 1918 10.0.0.0/8
    if (b0 === 172 && b1 !== undefined && b1 >= 16 && b1 <= 31) return true; // Private RFC 1918 172.16.0.0/12
    if (b0 === 192 && b1 === 168) return true; // Private RFC 1918 192.168.0.0/16
    if (b0 === 169 && b1 === 254) return true; // Link-local / Cloud metadata 169.254.0.0/16
    if (b0 === 100 && b1 !== undefined && b1 >= 64 && b1 <= 127) return true; // CGNAT 100.64.0.0/10
    if (b0 === 0) return true; // Current network 0.0.0.0/8
    if (b0 !== undefined && b0 >= 224) return true; // Multicast & reserved 224.0.0.0/4 and 240.0.0.0/4
    return false;
  }

  // IPv6 validation
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // Loopback / unspecified
    if (
      lower.startsWith("fe80:") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true; // Link-local fe80::/10
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // Unique local fc00::/7
    if (lower.startsWith("ff")) return true; // Multicast ff00::/8
    if (lower.includes("::ffff:")) {
      const v4Part = lower.split("::ffff:")[1];
      if (v4Part && isPrivateOrReservedIp(v4Part)) return true;
    }
    return false;
  }

  return false;
}

export interface SsrCheckOptions {
  allowLocalhost?: boolean;
  serverName?: string;
  skipDnsResolution?: boolean;
}

/**
 * Validates a remote MCP server URL against SSRF threats:
 * - Scheme must be http: or https:
 * - Hostname cannot be loopback, private RFC 1918, link-local metadata
 * - DNS resolution cannot resolve to private/reserved IP
 */
export async function assertSafeRemoteUrl(rawUrl: string, options?: SsrCheckOptions): Promise<URL> {
  const serverName = options?.serverName ?? "remote";
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpSecurityError(serverName, `Invalid remote MCP server URL: "${rawUrl}"`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpSecurityError(
      serverName,
      `Forbidden URL scheme "${url.protocol}". Only HTTPS and HTTP are supported.`,
    );
  }

  const hostname = url.hostname.toLowerCase();

  if (!options?.allowLocalhost) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new McpSecurityError(
        serverName,
        `Remote server destination "${hostname}" is forbidden (loopback or cloud metadata address).`,
      );
    }

    if (isPrivateOrReservedIp(hostname)) {
      throw new McpSecurityError(
        serverName,
        `Direct private IP address "${hostname}" is forbidden for remote MCP servers.`,
      );
    }

    if (!options?.skipDnsResolution) {
      try {
        const addresses = await lookup(hostname, { all: true });
        for (const addr of addresses) {
          if (isPrivateOrReservedIp(addr.address)) {
            throw new McpSecurityError(
              serverName,
              `Host "${hostname}" resolves to private/reserved IP "${addr.address}". Blocked by SSRF policy.`,
            );
          }
        }
      } catch (error) {
        if (error instanceof McpSecurityError) throw error;
        throw new McpSecurityError(
          serverName,
          `DNS resolution failed for remote server host "${hostname}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return url;
}
