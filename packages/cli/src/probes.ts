import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

/**
 * Elementary system probes.
 *
 * Each probe returns an observation, never throws: diagnostics must not abort
 * on the first error. We need the full comprehensive report in a single pass.
 */

const run = promisify(execFile);

export interface Probes {
  /** Checks if a TCP port accepts incoming connections. */
  tcp(host: string, port: number, timeoutMs?: number): Promise<boolean>;
  /** HTTP response or undefined if unreachable. */
  http(url: string, timeoutMs?: number): Promise<{ status: number; body: string } | undefined>;
  /** Command output or undefined if execution fails. */
  command(file: string, args: string[], timeoutMs?: number): Promise<string | undefined>;
}

export const systemProbes: Probes = {
  async tcp(host, port, timeoutMs = 2_000) {
    return new Promise((resolve) => {
      const socket = createConnection({ host, port });
      const settle = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      socket.once("error", () => settle(false));
    });
  },

  async http(url, timeoutMs = 3_000) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return { status: response.status, body: await response.text() };
    } catch {
      return undefined;
    }
  },

  async command(file, args, timeoutMs = 10_000) {
    try {
      const { stdout } = await run(file, args, { timeout: timeoutMs });
      return stdout.trim();
    } catch {
      return undefined;
    }
  },
};

/** Decomposes a URL into host and port, applying protocol defaults. */
export function hostAndPort(url: string): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(url);
    const port =
      parsed.port.length > 0
        ? Number(parsed.port)
        : parsed.protocol === "https:"
          ? 443
          : parsed.protocol === "redis:" || parsed.protocol === "rediss:"
            ? 6379
            : parsed.protocol === "postgresql:" || parsed.protocol === "postgres:"
              ? 5432
              : 80;
    return { host: parsed.hostname, port };
  } catch {
    return undefined;
  }
}

/** State of a systemd user unit. */
export interface UnitState {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  fragmentPath: string | undefined;
}

/**
 * Parses KEY=value output from `systemctl show`.
 */
export function parseUnitShow(output: string): UnitState {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const fragmentPath = values.get("FragmentPath") ?? "";
  return {
    installed: values.get("LoadState") === "loaded",
    enabled: values.get("UnitFileState") === "enabled",
    active: values.get("ActiveState") === "active",
    fragmentPath: fragmentPath.length > 0 ? fragmentPath : undefined,
  };
}

export async function unitState(probes: Probes, unit: string): Promise<UnitState> {
  const shown = await probes.command("systemctl", [
    "--user",
    "show",
    unit,
    "-p",
    "LoadState",
    "-p",
    "UnitFileState",
    "-p",
    "ActiveState",
    "-p",
    "FragmentPath",
  ]);
  if (shown === undefined) {
    return { installed: false, enabled: false, active: false, fragmentPath: undefined };
  }
  return parseUnitShow(shown);
}
