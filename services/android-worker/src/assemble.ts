import { LocalCapabilityRegistry, type LocalCapability } from "@nexus/worker-core";
import type { AndroidWorkerConfig } from "./config.js";
import type { AndroidPlatform } from "./ports.js";
import { AppPolicy } from "./policy/app-policy.js";
import { UiPolicy } from "./policy/ui-policy.js";
import { ScreenshotPolicy } from "./policy/screenshot-policy.js";
import { createAppListCapability, createAppOpenCapability } from "./capabilities/app.js";
import {
  createUiClickCapability,
  createUiInputCapability,
  createUiScrollCapability,
} from "./capabilities/ui.js";
import { createScreenshotCapability } from "./capabilities/screenshot.js";
import { createNotificationCapability } from "./capabilities/notification.js";

/**
 * Assemblage du worker Android.
 *
 * Un seul endroit relie les politiques, les ports système et les capacités. Le
 * reste du code ne construit rien : il reçoit ce dont il a besoin. C'est ce qui
 * permet aux tests de remplacer les quatre ports Android et d'éprouver toute la
 * chaîne — validation, politique, délais, annulation, rédaction — sans
 * émulateur, sans APK, et sans toucher au téléphone.
 *
 * Rien ici ne dépend du modèle de téléphone. Le Redmi Note 10S passe par ces
 * mêmes lignes qu'un autre appareil Android.
 */

export interface AssembleOptions {
  config: AndroidWorkerConfig;
  platform: AndroidPlatform;
}

export interface AssembledAndroidWorker {
  capabilities: LocalCapabilityRegistry;
  appPolicy: AppPolicy;
  uiPolicy: UiPolicy;
  screenshotPolicy: ScreenshotPolicy;
}

export function assembleCapabilities(options: AssembleOptions): AssembledAndroidWorker {
  const { config, platform } = options;

  const appPolicy = new AppPolicy({
    allowedPackages: config.allowedPackages,
    deniedPackages: config.deniedPackages,
  });
  const uiPolicy = new UiPolicy({
    allowCoordinateClicks: config.allowCoordinateClicks,
  });
  const screenshotPolicy = new ScreenshotPolicy({
    maxDimension: config.screenshotMaxDimension,
    minIntervalMs: config.screenshotMinIntervalMs,
  });

  const capabilities = new LocalCapabilityRegistry(config.declaredCapabilities);

  capabilities.registerAll([
    createAppListCapability({ controller: platform.apps, policy: appPolicy }),
    createAppOpenCapability({ controller: platform.apps, policy: appPolicy }),
    createUiClickCapability({ controller: platform.ui, policy: uiPolicy }),
    createUiInputCapability({ controller: platform.ui, policy: uiPolicy }),
    createUiScrollCapability({ controller: platform.ui, policy: uiPolicy }),
    createScreenshotCapability({ provider: platform.screenshots, policy: screenshotPolicy }),
    createNotificationCapability({ controller: platform.notifications }),
  ] as unknown as LocalCapability<never, unknown>[]);

  return { capabilities, appPolicy, uiPolicy, screenshotPolicy };
}
