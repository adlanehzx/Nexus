import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ValidationError } from "@nexus/shared";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

/** Valide la destination initiale et chaque redirection avant tout accès réseau. */
export async function assertPublicWebUrl(
  value: string | URL,
  resolver: HostResolver = resolveHost,
): Promise<URL> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch (error) {
    throw invalidUrl("L’URL web est invalide.", error);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidUrl("Seules les URL HTTP(S) sont autorisées.");
  }
  if (url.username || url.password) {
    throw invalidUrl("Les identifiants intégrés dans une URL sont interdits.");
  }
  if (
    (url.protocol === "http:" && url.port && url.port !== "80") ||
    (url.protocol === "https:" && url.port && url.port !== "443")
  ) {
    throw invalidUrl("Les ports web non standards sont interdits.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw invalidUrl("Cette destination réseau privée est interdite.");
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname).catch((error: unknown) => {
        throw invalidUrl("Le nom de domaine ne peut pas être résolu.", error);
      });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw invalidUrl("Cette destination réseau privée est interdite.");
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
}

export async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

export function isPublicIp(value: string): boolean {
  const unwrapped = value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : value;
  const family = isIP(unwrapped);
  if (family === 4) return isPublicIpv4(unwrapped);
  if (family === 6) return isPublicIpv6(unwrapped);
  return false;
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

function invalidUrl(message: string, cause?: unknown): ValidationError {
  return new ValidationError({
    message,
    userMessage: "Cette adresse web ne peut pas être consultée en sécurité.",
    ...(cause === undefined ? {} : { cause }),
  });
}
