import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidAppController } from "../ports.js";
import type { AppPolicy } from "../policy/app-policy.js";
import { ActivityLaunchBlockedError, AppNotAvailableError } from "../errors.js";

/**
 * `android.app.list` et `android.app.open`.
 *
 * Aucune des deux n'accepte d'URI ni d'`Intent`. Un `Intent` arbitraire est
 * l'équivalent Android d'une ligne de commande : il peut viser un composant
 * interne d'une autre application, transporter des données, déclencher un
 * paiement. La seule entrée acceptée est un **nom de paquet**, validé, et le
 * système choisit lui-même l'activité de lancement.
 */

export const appListInputSchema = z.object({
  /** Filtre sur le nom affiché ou le paquet, insensible à la casse. */
  nameContains: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const appOpenInputSchema = z.object({
  packageName: z.string().min(3).max(255),
});

export type AppListInput = z.infer<typeof appListInputSchema>;
export type AppOpenInput = z.infer<typeof appOpenInputSchema>;

export interface AppDependencies {
  controller: AndroidAppController;
  policy: AppPolicy;
}

export function createAppListCapability(
  dependencies: AppDependencies,
): LocalCapability<
  AppListInput,
  { apps: { packageName: string; label: string }[]; total: number }
> {
  return {
    name: "android.app.list",
    description:
      "Liste les applications ouvrables du téléphone Android de l'utilisateur, " +
      "parmi celles que la politique locale autorise.",
    inputSchema: appListInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        nameContains: { type: "string", description: "Filtre sur le nom de l'application" },
        limit: { type: "number" },
      },
    },
    riskLevel: "SAFE",

    execute: async (input) => {
      const all = await dependencies.controller.listApps();

      // Le filtrage par la politique passe avant tout le reste : une application
      // interdite ne doit même pas apparaître dans un inventaire. Sa seule
      // présence renseigne sur l'utilisateur.
      const permitted = all.filter(
        (app) => app.launchable && dependencies.policy.allows(app.packageName),
      );

      const needle = input.nameContains?.toLowerCase();
      const filtered =
        needle === undefined
          ? permitted
          : permitted.filter(
              (app) =>
                app.label.toLowerCase().includes(needle) ||
                app.packageName.toLowerCase().includes(needle),
            );

      // Ni version, ni date d'installation, ni permissions : rien de tout cela
      // n'aide à ouvrir une application.
      return {
        apps: filtered
          .slice(0, input.limit)
          .map((app) => ({ packageName: app.packageName, label: app.label })),
        total: filtered.length,
      };
    },
  };
}

export function createAppOpenCapability(
  dependencies: AppDependencies,
): LocalCapability<AppOpenInput, { packageName: string; launched: boolean }> {
  return {
    name: "android.app.open",
    description:
      "Ouvre une application sur le téléphone Android de l'utilisateur, désignée par son " +
      "nom de paquet. N'accepte ni URI ni intention : le système choisit l'écran d'accueil " +
      "de l'application.",
    inputSchema: appOpenInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        packageName: {
          type: "string",
          description: "Nom de paquet Android, par exemple « com.spotify.music »",
        },
      },
      required: ["packageName"],
    },
    riskLevel: "LOW",

    execute: async (input) => {
      const packageName = dependencies.policy.assertAllowed(input.packageName);

      // Vérification d'existence avant lancement : distinguer « pas installée »
      // de « le système a refusé » évite de renvoyer un diagnostic trompeur.
      if (!(await dependencies.controller.isInstalled(packageName))) {
        throw new AppNotAvailableError(packageName);
      }

      const result = await dependencies.controller.openApp(packageName);
      if (!result.launched) {
        throw new ActivityLaunchBlockedError(packageName, result.reason ?? "refus du système");
      }

      return { packageName, launched: true };
    },
  };
}
