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
 * Parses alternative IPv4 formats:
 * - Decimal dotted: 127.0.0.1
 * - Octal dotted: 0177.0.0.1
 * - Hex dotted: 0x7f.0.0.1
 * - 32-bit integer DWORD: 2130706433 or 0x7f000001
 * Returns 32-bit unsigned integer or null.
 */
export function parseIpv4ToNumber(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();

  // Check if single integer (decimal, hex 0x..., or octal 0...)
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(trimmed)) {
    let val: number;
    if (trimmed.startsWith("0x")) {
      val = parseInt(trimmed, 16);
    } else if (trimmed.startsWith("0") && trimmed.length > 1) {
      val = parseInt(trimmed, 8);
    } else {
      val = parseInt(trimmed, 10);
    }
    if (Number.isFinite(val) && val >= 0 && val <= 0xffffffff) {
      return val >>> 0;
    }
    return null;
  }

  // Dotted notation (1 to 4 parts)
  const parts = trimmed.split(".");
  if (parts.length > 4 || parts.length === 0) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (!part) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      n = parseInt(part, 16);
    } else if (/^0[0-7]+$/.test(part)) {
      n = parseInt(part, 8);
    } else if (/^\d+$/.test(part)) {
      n = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }

  if (nums.length === 4) {
    if (nums.some((x) => x > 255)) return null;
    return ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0;
  } else if (nums.length === 3) {
    if (nums[0]! > 255 || nums[1]! > 255 || nums[2]! > 65535) return null;
    return ((nums[0]! << 24) | (nums[1]! << 16) | nums[2]!) >>> 0;
  } else if (nums.length === 2) {
    if (nums[0]! > 255 || nums[1]! > 16777215) return null;
    return ((nums[0]! << 24) | nums[1]!) >>> 0;
  } else if (nums.length === 1) {
    if (nums[0]! > 0xffffffff) return null;
    return nums[0]! >>> 0;
  }
  return null;
}

/**
 * Checks if an IP address belongs to loopback, RFC 1918 private,
 * link-local (cloud metadata), carrier-grade NAT, or reserved multicast ranges.
 * Supports alternative IPv4 representations (octal, hex, DWORD, IPv4-mapped IPv6).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (!ip || typeof ip !== "string") return false;
  const lower = ip.trim().toLowerCase();

  // 1. IPv4 alternative parsing (octal, hex, DWORD, dotted)
  const ipv4Num = parseIpv4ToNumber(lower);
  if (ipv4Num !== null) {
    const b0 = (ipv4Num >>> 24) & 0xff;
    const b1 = (ipv4Num >>> 16) & 0xff;

    if (b0 === 127) return true; // Loopback 127.0.0.0/8
    if (b0 === 10) return true; // Private RFC 1918 10.0.0.0/8
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // Private RFC 1918 172.16.0.0/12
    if (b0 === 192 && b1 === 168) return true; // Private RFC 1918 192.168.0.0/16
    if (b0 === 169 && b1 === 254) return true; // Link-local / Cloud metadata 169.254.0.0/16
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // CGNAT 100.64.0.0/10
    if (b0 === 0) return true; // Current network 0.0.0.0/8
    if (b0 >= 224) return true; // Multicast & reserved 224.0.0.0/4 and 240.0.0.0/4
    return false;
  }

  // 2. IPv6 validation and IPv4-mapped IPv6
  if (isIP(lower) === 6 || lower.includes(":")) {
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

    // IPv4-mapped IPv6 check (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (lower.includes("::ffff:")) {
      const v4Part = lower.split("::ffff:")[1];
      if (v4Part) {
        if (v4Part.includes(":")) {
          // Hex format like 7f00:1
          const hexParts = v4Part.split(":");
          if (hexParts.length === 2) {
            const h0 = parseInt(hexParts[0]!, 16);
            const h1 = parseInt(hexParts[1]!, 16);
            const mappedNum = ((h0 << 16) | h1) >>> 0;
            return isPrivateOrReservedIp(String(mappedNum));
          }
        }
        return isPrivateOrReservedIp(v4Part);
      }
    }
    return false;
  }

  return false;
}

export type DnsLookupFunction = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

export interface SsrCheckOptions {
  allowLocalhost?: boolean | undefined;
  serverName?: string | undefined;
  skipDnsResolution?: boolean | undefined;
  dnsLookup?: DnsLookupFunction | undefined;
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
        const lookupFn = options?.dnsLookup ?? (async (h) => lookup(h, { all: true }));
        const addresses = await lookupFn(hostname);
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

export interface SafeMcpFetchOptions {
  serverName: string;
  dnsLookup?: DnsLookupFunction | undefined;
  fetchFn?: typeof fetch | undefined;
  maxRedirects?: number | undefined;
  allowLocalhost?: boolean | undefined;
}

/**
 * Creates an SSRF-safe fetch wrapper:
 * - Validates target URL and every redirect destination.
 * - Protects against DNS rebinding and TOCTOU.
 * - Rejects private/reserved IPs on any hop.
 */
export function createSafeMcpFetch(options: SafeMcpFetchOptions): typeof fetch {
  const baseFetch = options.fetchFn ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;

  return async (input, init) => {
    let currentUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    let redirectsCount = 0;

    while (true) {
      await assertSafeRemoteUrl(currentUrl, {
        serverName: options.serverName,
        dnsLookup: options.dnsLookup,
        allowLocalhost: options.allowLocalhost,
      });

      const response = await baseFetch(currentUrl, {
        ...init,
        redirect: "manual",
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new McpSecurityError(
            options.serverName,
            `Redirect response (${response.status}) missing location header`,
          );
        }

        redirectsCount++;
        if (redirectsCount > maxRedirects) {
          throw new McpSecurityError(
            options.serverName,
            `Too many redirects: exceeded maximum of ${maxRedirects}`,
          );
        }

        const nextUrl = new URL(location, currentUrl).toString();

        // Strict verification of redirect hop before sending any request
        await assertSafeRemoteUrl(nextUrl, {
          serverName: options.serverName,
          dnsLookup: options.dnsLookup,
          allowLocalhost: options.allowLocalhost,
        });

        currentUrl = nextUrl;
        continue;
      }

      return response;
    }
  };
}
