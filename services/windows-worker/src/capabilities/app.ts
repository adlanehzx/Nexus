import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { ExecutableNotAllowedError } from "../errors.js";

/**
 * `app.open` — ouvrir une application sur l'écran de l'utilisateur.
 *
 * Le nom reprend celui qui existe déjà côté Android (`android.app.open`) : c'est
 * la même intention sur une autre plateforme, et lui inventer un nom neuf
 * obligerait le planificateur à connaître deux vocabulaires pour une seule idée.
 *
 * ## Pourquoi ce n'est pas `process.start`
 *
 * `process.start` lance un **programme de la liste d'exécution**, avec des
 * arguments, et rend un identifiant de processus qu'on peut arrêter : c'est de
 * l'outillage. `app.open` met une **application devant l'utilisateur** : Chrome,
 * Spotify, l'explorateur. Deux intentions, deux listes, deux niveaux de risque.
 *
 * Les confondre reviendrait à ce qu'autoriser « ouvre Spotify » autorise aussi
 * « lance ce binaire avec ces arguments ».
 *
 * ## La règle qui rend cette capacité sûre
 *
 * **Elle n'accepte pas de chemin.** Elle accepte un *nom logique*, résolu dans
 * une table que la personne qui possède la machine a écrite. Un nom inconnu est
 * refusé ; il n'existe aucun moyen de faire ouvrir un exécutable qui ne figure
 * pas dans cette table.
 *
 * C'est la même philosophie que `ExecPolicy` : la sécurité vient de la forme de
 * l'API — qui n'accepte pas de chemin — et non d'un filtre sur des chaînes, qui
 * se contourne.
 *
 * **Elle n'accepte pas non plus d'arguments.** Les arguments d'une application
 * graphique sont un second canal d'injection : `chrome --load-extension=…`
 * charge du code, `explorer` ouvre n'importe quel dossier. Ouvrir une
 * application, c'est l'ouvrir. Pour naviguer, il y a `browser.open` ; pour
 * automatiser, le worker navigateur.
 */

export const appOpenInputSchema = z.object({
  /**
   * Nom logique de l'application, tel qu'il figure dans `WORKER_APPS`.
   *
   * Jamais un chemin : la table de résolution est la frontière, et accepter un
   * chemin la contournerait entièrement.
   */
  app: z.string().min(1).max(64),
});

export type AppOpenInput = z.infer<typeof appOpenInputSchema>;

export interface AppOpenResult {
  app: string;
  processId: number;
  startedAt: string;
}

export interface AppDependencies {
  runner: ProcessRunner;
  /** Table `nom logique → exécutable`, venue de la configuration. */
  applications: ReadonlyMap<string, string>;
  env: Record<string, string | undefined>;
  /** Variables transmises à l'application lancée. */
  allowedEnv: readonly string[];
}

export function createAppOpenCapability(
  dependencies: AppDependencies,
): LocalCapability<AppOpenInput, AppOpenResult> {
  const known = [...dependencies.applications.keys()].sort();

  return {
    name: "app.open",
    description:
      "Ouvre une application installée sur cet ordinateur, sur l'écran de l'utilisateur. " +
      `Applications connues : ${known.length === 0 ? "aucune" : known.join(", ")}. ` +
      "N'accepte qu'un de ces noms — ni chemin, ni argument.",
    inputSchema: appOpenInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description: "Nom de l'application à ouvrir",
          ...(known.length === 0 ? {} : { enum: known }),
        },
      },
      required: ["app"],
    },
    // Ouvrir une application est visible et réversible — l'utilisateur la voit
    // apparaître et peut la fermer. Le risque tient à *quelle* application, et
    // c'est la table qui en décide, pas l'appelant.
    riskLevel: "MEDIUM",

    execute: async (input): Promise<AppOpenResult> => {
      const name = input.app.trim().toLowerCase();
      const executable = dependencies.applications.get(name);

      if (executable === undefined) {
        // Le message énumère ce qui est possible : un refus qui ne dit pas quoi
        // faire à la place fait recommencer au hasard.
        throw new ExecutableNotAllowedError(
          `${input.app} (connues : ${known.length === 0 ? "aucune" : known.join(", ")})`,
        );
      }

      const env: Record<string, string> = {};
      for (const variable of dependencies.allowedEnv) {
        const value = dependencies.env[variable];
        if (value !== undefined) env[variable] = value;
      }

      // `start` et non `run` : une application graphique survit à la tâche qui
      // l'a ouverte. L'attendre bloquerait l'étape jusqu'à ce que l'utilisateur
      // ferme sa fenêtre.
      const started = await dependencies.runner.start({
        executable,
        args: [],
        env,
      });

      return { app: name, processId: started.processId, startedAt: started.startedAt };
    },
  };
}

/**
 * Décode la table des applications.
 *
 * Forme : `chrome=C:\Program Files\Google\Chrome\Application\chrome.exe,spotify=…`
 *
 * Les entrées mal formées sont **ignorées en silence** plutôt que de faire
 * échouer le démarrage : une ligne de configuration douteuse ne doit pas priver
 * l'utilisateur de son worker entier. Ce qui n'est pas décodé n'est simplement
 * pas ouvrable, et la description de la capacité dit lesquelles le sont.
 */
export function parseApplications(entries: readonly string[]): Map<string, string> {
  const applications = new Map<string, string>();

  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;

    const name = entry.slice(0, separator).trim().toLowerCase();
    const executable = entry.slice(separator + 1).trim();

    // Un nom vide, un chemin vide, ou un caractère nul — qui tronque les chaînes
    // dans les appels système sous-jacents.
    if (name.length === 0 || executable.length === 0) continue;
    if (name.includes("\0") || executable.includes("\0")) continue;

    applications.set(name, executable);
  }

  return applications;
}
