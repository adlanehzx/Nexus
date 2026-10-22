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
 * Assembly of the Android worker.
 *
 * Single point wiring policies, system ports, and capabilities.
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
