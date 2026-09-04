import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidScreenshotProvider } from "../ports.js";
import type { ScreenshotPolicy } from "../policy/screenshot-policy.js";
import { AndroidPermissionDeniedError } from "../errors.js";

/**
 * `android.ui.screenshot`.
 *
 * Le mécanisme retenu est `AccessibilityService.takeScreenshot()`, disponible
 * depuis Android 11. C'est **le moins privilégié des deux chemins légitimes**,
 * et le choix mérite d'être justifié :
 *
 * | | `takeScreenshot()` | `MediaProjection` |
 * | --- | --- | --- |
 * | Permission | le service d'accessibilité, déjà activé | dialogue système dédié |
 * | Portée | une image, sur appel | un flux vidéo continu |
 * | Jeton | aucun | valide bien après la capture |
 * | Service de premier plan | non | oui, permanent |
 *
 * `MediaProjection` donne un flux ; nous avons besoin d'une image. Prendre le
 * flux « parce qu'il marche partout » installerait sur le téléphone une
 * autorisation d'enregistrement d'écran permanente pour un besoin ponctuel.
 *
 * Le prix de ce choix est assumé : sous Android 10 et antérieur, la capacité
 * n'est simplement pas annoncée. Le Redmi Note 10S est livré sous Android 11,
 * la question ne se pose pas pour lui.
 */

export const screenshotInputSchema = z.object({
  /** Plus grand côté de l'image renvoyée. Borné par la politique. */
  maxDimension: z.number().int().min(240).max(2_048).optional(),
});

export type ScreenshotInput = z.infer<typeof screenshotInputSchema>;

export interface ScreenshotResult {
  /** Image encodée en base64. Jamais journalisée, jamais écrite sur disque. */
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
      "Prend une capture de l'écran du téléphone Android, à la demande. " +
      "Requiert le service d'accessibilité NEXUS et Android 11 ou plus récent.",
    inputSchema: screenshotInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        maxDimension: {
          type: "number",
          description: "Plus grand côté de l'image renvoyée, en pixels",
        },
      },
    },
    // MEDIUM et non SAFE : lire un écran n'écrit rien, mais une capture montre
    // ce que l'utilisateur regarde — un message privé, un code à usage unique.
    riskLevel: "MEDIUM",

    probe: () => dependencies.provider.isAvailable(),

    execute: async (input, context): Promise<ScreenshotResult> => {
      if (!(await dependencies.provider.isAvailable())) {
        throw new AndroidPermissionDeniedError(
          "screenshot",
          "Activez le service d'accessibilité NEXUS, et vérifiez qu'Android 11 ou plus " +
            "récent est installé.",
        );
      }

      // La cadence est vérifiée avant la capture : c'est ce qui empêche une
      // suite de tâches d'approcher un enregistrement continu par accumulation.
      dependencies.policy.assertCaptureAllowed();

      const maxDimension = Math.min(
        input.maxDimension ?? dependencies.policy.maxDimension,
        dependencies.policy.maxDimension,
      );

      context.onProgress({ label: "capture de l'écran" });
      const shot = await dependencies.provider.capture(maxDimension, context.signal);

      dependencies.policy.assertWithinLimits(shot);

      // L'image ne passe par aucun journal, aucun fichier temporaire : elle est
      // renvoyée directement et le tampon natif est libéré côté Kotlin.
      return {
        image: shot.base64,
        format: shot.format,
        width: shot.width,
        height: shot.height,
        bytes: shot.bytes,
      };
    },

    /**
     * Le résultat ne doit pas être conservé.
     *
     * Il traverse le cœur pour atteindre le client qui l'a demandé, et s'arrête
     * là : le journal d'exécution en garde la trace, pas l'image. Une capture
     * d'écran de téléphone dans une table d'audit est une fuite qui survit des
     * mois à la demande qui l'a produite.
     */
    sensitiveResult: true,
  };
}
