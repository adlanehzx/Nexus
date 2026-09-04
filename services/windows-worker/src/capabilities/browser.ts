import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { PolicyViolationError } from "../errors.js";

/**
 * `browser.open`.
 *
 * Volontairement minuscule, et **ce n'est pas un doublon de Browser Use**. La
 * distinction :
 *
 *  - **Browser Use** pilote un navigateur : il lit une page, clique, remplit un
 *    formulaire, comprend ce qu'il voit. C'est un worker spécialisé, avec sa
 *    propre isolation de session.
 *  - **`browser.open`** ouvre une page *devant l'utilisateur*, sur son écran.
 *    C'est une action de restitution, pas d'automatisation.
 *
 * Les confondre reviendrait à donner deux chemins d'automatisation du web, dont
 * l'un sans aucune des protections de l'autre.
 */

export const browserOpenInputSchema = z.object({
  url: z.string().url().max(2_048),
});

export type BrowserOpenInput = z.infer<typeof browserOpenInputSchema>;

/**
 * Schémas d'URL acceptés.
 *
 * `file://` ouvrirait un fichier local hors de toute politique de chemins ;
 * `javascript:` exécuterait du code dans le navigateur de l'utilisateur.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface BrowserDependencies {
  runner: ProcessRunner;
  env: Record<string, string | undefined>;
}

export function createBrowserOpenCapability(
  dependencies: BrowserDependencies,
): LocalCapability<BrowserOpenInput, { url: string; opened: boolean }> {
  return {
    name: "browser.open",
    description:
      "Ouvre une page web dans le navigateur de l'utilisateur, sur son écran. " +
      "N'automatise rien : pour naviguer ou interagir, NEXUS utilise son worker navigateur dédié.",
    inputSchema: browserOpenInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Adresse http(s) à ouvrir" } },
      required: ["url"],
    },
    riskLevel: "LOW",

    execute: async (input) => {
      const url = new URL(input.url);
      if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new PolicyViolationError({
          rule: "browser.protocol",
          message: `Schéma d'URL refusé : ${url.protocol}`,
          userMessage: "Seules les adresses http et https peuvent être ouvertes.",
          context: { protocol: url.protocol },
        });
      }

      // `start` passe par le shell ; on invoque directement le gestionnaire
      // d'URL de Windows, avec l'adresse en argument séparé.
      const outcome = await dependencies.runner.run({
        executable: "rundll32",
        args: ["url.dll,FileProtocolHandler", url.toString()],
        env: {},
        timeoutMs: 10_000,
      });

      return { url: url.toString(), opened: outcome.status === "completed" };
    },
  };
}
