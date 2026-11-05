import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { InsecureBackendUrlError, backendHttpUrl } from "@nexus/client-core";
import { readPreference, writePreference } from "./preferences.js";

/**
 * Which NEXUS core this app talks to.
 *
 * NEXUS is self-hosted: the address belongs to the user, not to the build.
 * `EXPO_PUBLIC_NEXUS_URL` only pre-fills it. The address is validated by
 * client-core, which refuses plaintext to anything but the local machine.
 */

declare const process: { env: Record<string, string | undefined> };

const BUILD_DEFAULT = process.env.EXPO_PUBLIC_NEXUS_URL ?? "";

/**
 * Normalizes what a person types. A bare host means https: plaintext must be
 * asked for explicitly, and client-core refuses it for remote hosts anyway.
 *
 * @throws Error with a message fit for display.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Enter the address of your NEXUS core.");

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return backendHttpUrl(candidate);
  } catch (cause) {
    if (cause instanceof InsecureBackendUrlError && candidate.startsWith("http:")) {
      throw new Error(
        "Remote servers must use https://. Session tokens never travel in plaintext.",
        {
          cause,
        },
      );
    }
    throw new Error("That does not look like a valid server address.", { cause });
  }
}

interface ServerContextValue {
  /** Validated address, or null before one is configured. */
  url: string | null;
  ready: boolean;
  setUrl: (url: string) => Promise<void>;
}

const ServerContext = createContext<ServerContextValue | undefined>(undefined);

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const [url, setStoredUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void readPreference("nexus.server").then((stored) => {
      if (!active) return;
      setStoredUrl(resolveInitial(stored));
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const setUrl = useCallback(async (next: string) => {
    const normalized = normalizeServerUrl(next);
    await writePreference("nexus.server", normalized);
    setStoredUrl(normalized);
  }, []);

  const value = useMemo(() => ({ url, ready, setUrl }), [url, ready, setUrl]);
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

function resolveInitial(stored: string | null): string | null {
  for (const candidate of [stored, BUILD_DEFAULT]) {
    if (candidate === null || candidate.length === 0) continue;
    try {
      return normalizeServerUrl(candidate);
    } catch {
      // A stale or invalid value falls through to the sign-in screen.
    }
  }
  return null;
}

export function useServer(): ServerContextValue {
  const value = useContext(ServerContext);
  if (value === undefined) throw new Error("useServer must be used within <ServerProvider>");
  return value;
}
