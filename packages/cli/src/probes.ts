import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

/**
 * Sondes élémentaires.
 *
 * Chacune répond à une question et rend un constat, jamais une exception : un
 * diagnostic qui s'arrête à la première panne ne diagnostique rien. On veut la
 * liste complète de ce qui manque, en un passage.
 *
 * Elles sont regroupées ici pour que les vérifications puissent être testées
 * en les remplaçant, sans toucher à la machine.
 */

const run = promisify(execFile);

export interface Probes {
  /** Un port accepte-t-il une connexion TCP ? */
  tcp(host: string, port: number, timeoutMs?: number): Promise<boolean>;
  /** Réponse HTTP d'une URL, ou `undefined` si injoignable. */
  http(url: string, timeoutMs?: number): Promise<{ status: number; body: string } | undefined>;
  /** Sortie d'une commande, ou `undefined` si elle échoue ou n'existe pas. */
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

/** Décompose une URL en hôte et port, en appliquant le port par défaut du schéma. */
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

/**
 * État d'une unité systemd utilisateur.
 *
 * Trois questions distinctes, parce que les réponses se combinent mal : une
 * unité peut être installée et arrêtée, active sans être activée au démarrage,
 * ou absente alors que le processus tourne — lancé à la main.
 */
export interface UnitState {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  fragmentPath: string | undefined;
}

/**
 * Lit la sortie `KEY=value` de `systemctl show`.
 *
 * Et non `--value`, qui ne rend que les valeurs : systemd les ordonne **à sa
 * façon**, pas dans l'ordre des `-p` demandés. Une lecture positionnelle
 * marche donc par accident et casse en silence — ici elle lisait `ActiveState`
 * à la place de `UnitFileState`, et rapportait toute unité active comme
 * arrêtée et non activée.
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
