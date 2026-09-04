import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * État **public** du démon, déposé sur le disque.
 *
 * Un seul lecteur : l'interface NEXUS installée sur la même machine, qui a
 * besoin de savoir quel appareil ce poste est, pour se reconnaître dans la liste
 * que le cœur lui renvoie. Sans ce fichier, la fenêtre créerait un second
 * appareil pour la même machine et l'utilisateur verrait deux « Portable » dans
 * sa flotte.
 *
 * Ce qu'on y écrit est délibérément pauvre : **un identifiant, une plateforme,
 * une version**. Pas le chemin de la clé privée, pas les racines autorisées, pas
 * les exécutables permis, pas l'URL du cœur. Un fichier lisible par l'utilisateur
 * ne doit rien contenir qu'on regretterait de voir copié.
 *
 * Et surtout : ce fichier **n'accorde rien**. Il ne s'agit pas d'un canal de
 * commande entre l'interface et le démon — il n'en existe aucun. C'est une
 * carte de visite en lecture seule.
 */

export interface PublicWorkerState {
  deviceId: string;
  platform: string;
  workerVersion: string;
  /** Horodatage du dernier démarrage. Sert au diagnostic, à rien d'autre. */
  startedAt: string;
}

/**
 * Emplacement par défaut : `%ProgramData%\NEXUS\worker\device.json`.
 *
 * `ProgramData` plutôt que le profil utilisateur, parce que le démon tourne en
 * service et que l'interface tourne dans une session interactive : ils ne
 * partagent pas de dossier personnel.
 */
export function defaultStatePath(env: Record<string, string | undefined>): string {
  const root = env.ProgramData ?? env.PROGRAMDATA ?? ".";
  return join(root, "NEXUS", "worker", "device.json");
}

/**
 * Écrit l'état public.
 *
 * N'échoue jamais bruyamment : un démon qui refuserait de démarrer parce qu'il
 * ne peut pas écrire un fichier d'agrément serait absurde. L'interface affichera
 * « aucun exécutant détecté », ce qui est gênant et sans conséquence — alors
 * qu'un worker arrêté, lui, ne fait plus rien du tout.
 *
 * @returns le chemin écrit, ou `undefined` si l'écriture a échoué.
 */
export async function publishWorkerState(
  path: string,
  state: PublicWorkerState,
): Promise<string | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/** Ne retient d'une configuration que ce qui peut être publié. */
export function publicStateOf(input: {
  deviceId: string;
  platform: string;
  workerVersion: string;
  now: Date;
}): PublicWorkerState {
  return {
    deviceId: input.deviceId,
    platform: input.platform,
    workerVersion: input.workerVersion,
    startedAt: input.now.toISOString(),
  };
}
