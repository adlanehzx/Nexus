import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidScreenshotProvider } from "../ports.js";
import type { ScreenshotPolicy } from "../policy/screenshot-policy.js";
import { AndroidPermissionDeniedError } from "../errors.js";

/**
 * `android.ui.screenshot`.
 */

export const screenshotInputSchema = z.object({
  /** Maximum dimension of returned image. Capped by policy. */
  maxDimension: z.number().int().min(240).max(2_048).optional(),
});

export type ScreenshotInput = z.infer<typeof screenshotInputSchema>;

export interface ScreenshotResult {
  /** Base64-encoded image. Never logged, never written to disk. */
  image: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ScreenshotDependencies {
  provider: AndroidScreenshotProvider;
  policy: ScreenshotPolicy;
}

export function createScreenshotCapability(
  dependencies: ScreenshotDependencies,
): LocalCapability<ScreenshotInput, ScreenshotResult> {
  return {
    name: "android.ui.screenshot",
    description:
      "Captures the Android phone screen on demand. " +
      "Requires NEXUS accessibility service and Android 11 or newer.",
    inputSchema: screenshotInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        maxDimension: {
          type: "number",
          description: "Maximum dimension of returned image, in pixels",
        },
      },
    },
    riskLevel: "MEDIUM",

    probe: () => dependencies.provider.isAvailable(),

    execute: async (input, context): Promise<ScreenshotResult> => {
      if (!(await dependencies.provider.isAvailable())) {
        throw new AndroidPermissionDeniedError(
          "screenshot",
          "Enable the NEXUS accessibility service, and verify that Android 11 or newer is installed.",
        );
      }

      dependencies.policy.assertCaptureAllowed();

      const maxDimension = Math.min(
        input.maxDimension ?? dependencies.policy.maxDimension,
        dependencies.policy.maxDimension,
      );

      context.onProgress({ label: "screen capture" });
      const shot = await dependencies.provider.capture(maxDimension, context.signal);

      dependencies.policy.assertWithinLimits(shot);

      return {
        image: shot.base64,
        format: shot.format,
        width: shot.width,
        height: shot.height,
        bytes: shot.bytes,
      };
    },

    sensitiveResult: true,
  };
}
