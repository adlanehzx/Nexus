import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidAppController } from "../ports.js";
import type { AppPolicy } from "../policy/app-policy.js";
import { ActivityLaunchBlockedError, AppNotAvailableError } from "../errors.js";

/**
 * `android.app.list` and `android.app.open`.
 */

export const appListInputSchema = z.object({
  /** Filter on displayed name or package, case-insensitive. */
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
      "Lists launchable applications on the user's Android phone, among those allowed by local policy.",
    inputSchema: appListInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        nameContains: { type: "string", description: "Filter on application name" },
        limit: { type: "number" },
      },
    },
    riskLevel: "SAFE",

    execute: async (input) => {
      const all = await dependencies.controller.listApps();

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
      "Opens an application on the user's Android phone, designated by its package name. " +
      "Does not accept URIs or intents: the system selects the application's launcher activity.",
    inputSchema: appOpenInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        packageName: {
          type: "string",
          description: "Android package name, for example \"com.spotify.music\"",
        },
      },
      required: ["packageName"],
    },
    riskLevel: "LOW",

    execute: async (input) => {
      const packageName = dependencies.policy.assertAllowed(input.packageName);

      if (!(await dependencies.controller.isInstalled(packageName))) {
        throw new AppNotAvailableError(packageName);
      }

      const result = await dependencies.controller.openApp(packageName);
      if (!result.launched) {
        throw new ActivityLaunchBlockedError(packageName, result.reason ?? "system refusal");
      }

      return { packageName, launched: true };
    },
  };
}
