import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidUiController, UiSelector } from "../ports.js";
import type { UiPolicy } from "../policy/ui-policy.js";
import { AccessibilityDisabledError, UiNodeNotFoundError } from "../errors.js";

/**
 * `android.ui.click`, `android.ui.input`, `android.ui.scroll`.
 *
 * Ces trois capacités reposent sur le **service d'accessibilité**, seul
 * mécanisme légitime d'Android pour agir sur l'interface d'une autre
 * application. Trois conséquences tenues partout dans ce fichier :
 *
 *  1. le service doit être **activé par l'utilisateur** dans les réglages du
 *     système — aucune API ne permet de l'activer par programme, et ce worker
 *     ne cherche pas à contourner cette règle ;
 *  2. sa disponibilité est vérifiée **à chaque appel**, pas seulement au
 *     démarrage : l'utilisateur peut le désactiver pendant qu'une tâche tourne ;
 *  3. rien n'est collecté au passage. Le service lit la hiérarchie de vues pour
 *     trouver l'élément demandé, agit, et n'en conserve rien.
 */

const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("viewId"), value: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("text"), value: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("contentDescription"), value: z.string().min(1).max(256) }),
  z.object({
    kind: z.literal("coordinates"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
]);

export const clickInputSchema = z.object({ selector: selectorSchema });

export const inputTextSchema = z.object({
  selector: selectorSchema,
  /**
   * Texte à saisir.
   *
   * Ne figure dans aucun journal, aucun événement, aucun résultat. C'est le
   * chemin normal d'un mot de passe.
   */
  text: z.string().min(1).max(4_096),
});

export const scrollInputSchema = z.object({
  direction: z.enum(["up", "down", "left", "right"]),
  /** Nombre de gestes de défilement. Borné par la politique. */
  amount: z.number().int().min(1).max(20).default(1),
});

export type ClickInput = z.infer<typeof clickInputSchema>;
export type InputTextInput = z.infer<typeof inputTextSchema>;
export type ScrollInput = z.infer<typeof scrollInputSchema>;

export interface UiDependencies {
  controller: AndroidUiController;
  policy: UiPolicy;
}

const selectorJsonSchema = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "viewId" }, value: { type: "string" } },
      required: ["kind", "value"],
      description: "Identifiant de vue Android — le plus stable, à préférer.",
    },
    {
      type: "object",
      properties: { kind: { const: "text" }, value: { type: "string" } },
      required: ["kind", "value"],
      description: "Texte affiché par l'élément.",
    },
    {
      type: "object",
      properties: { kind: { const: "contentDescription" }, value: { type: "string" } },
      required: ["kind", "value"],
      description: "Description d'accessibilité de l'élément.",
    },
  ],
} as const;

/**
 * Vérifie que le service d'accessibilité est actif, maintenant.
 *
 * Appelé au début de chaque exécution et non une fois pour toutes : entre
 * l'annonce des capacités et l'arrivée d'une tâche, l'utilisateur a pu désactiver
 * le service — c'est même un geste qu'on souhaite qu'il fasse librement.
 */
async function assertAccessibility(
  dependencies: UiDependencies,
  capability: string,
): Promise<void> {
  if (!(await dependencies.controller.isAccessibilityEnabled())) {
    throw new AccessibilityDisabledError(capability);
  }
}

/** Résout un sélecteur en nœud, en refusant ce qui n'accepte pas l'action. */
async function resolveNode(
  dependencies: UiDependencies,
  selector: UiSelector,
  action: "click" | "input",
) {
  // Un clic par coordonnées ne passe par aucun nœud : c'est précisément ce qui
  // le rend risqué, et pourquoi la politique le refuse par défaut.
  if (selector.kind === "coordinates") return undefined;

  const node = await dependencies.controller.findNode(selector);
  if (node === undefined) throw new UiNodeNotFoundError(selector.kind);

  dependencies.policy.assertNodeAccepts(node, action);
  return node;
}

export function createUiClickCapability(
  dependencies: UiDependencies,
): LocalCapability<ClickInput, { clicked: boolean; selectorKind: string }> {
  return {
    name: "android.ui.click",
    description:
      "Appuie sur un élément de l'écran du téléphone Android, désigné par son identifiant " +
      "de vue, son texte ou sa description. Requiert le service d'accessibilité NEXUS.",
    inputSchema: clickInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: { selector: selectorJsonSchema },
      required: ["selector"],
    },
    riskLevel: "MEDIUM",

    probe: () => dependencies.controller.isAccessibilityEnabled(),

    execute: async (input, context) => {
      await assertAccessibility(dependencies, "android.ui.click");
      const selector = dependencies.policy.assertSelectorAllowed(input.selector);
      await resolveNode(dependencies, selector, "click");

      context.onProgress({ label: `appui sur ${selector.kind}` });
      const result = await dependencies.controller.click(selector, context.signal);

      return { clicked: result.clicked, selectorKind: selector.kind };
    },
  };
}

export function createUiInputCapability(
  dependencies: UiDependencies,
): LocalCapability<InputTextInput, { entered: boolean; characters: number }> {
  return {
    name: "android.ui.input",
    description:
      "Saisit du texte dans un champ de l'écran du téléphone Android. " +
      "Requiert le service d'accessibilité NEXUS.",
    inputSchema: inputTextSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        selector: selectorJsonSchema,
        text: { type: "string", description: "Texte à saisir dans le champ" },
      },
      required: ["selector", "text"],
    },
    riskLevel: "MEDIUM",

    /**
     * `text` ne doit apparaître dans aucun journal.
     *
     * Le champ est légitimement nommé — la rédaction générique, qui reconnaît
     * `password` ou `token`, ne peut rien pour lui. Seule la capacité sait ce
     * qu'il transporte, et c'est le chemin normal d'un mot de passe.
     */
    secretArguments: ["text"],

    probe: () => dependencies.controller.isAccessibilityEnabled(),

    execute: async (input, context) => {
      await assertAccessibility(dependencies, "android.ui.input");
      const selector = dependencies.policy.assertSelectorAllowed(input.selector);
      const text = dependencies.policy.assertTextAllowed(input.text);
      await resolveNode(dependencies, selector, "input");

      // La progression ne dit que le nombre de caractères. Ni le texte, ni un
      // extrait, ni sa première lettre.
      context.onProgress({ label: `saisie de ${String(text.length)} caractères` });

      const result = await dependencies.controller.inputText(selector, text, context.signal);

      // Le résultat non plus ne porte pas le texte : il traverse le réseau,
      // entre dans le journal d'exécution du cœur, et s'affiche sur l'iPhone.
      return { entered: result.entered, characters: result.characters };
    },
  };
}

export function createUiScrollCapability(
  dependencies: UiDependencies,
): LocalCapability<ScrollInput, { scrolled: boolean; direction: string; amount: number }> {
  return {
    name: "android.ui.scroll",
    description:
      "Fait défiler l'écran du téléphone Android dans une direction donnée. " +
      "Requiert le service d'accessibilité NEXUS.",
    inputSchema: scrollInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        direction: { enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Nombre de gestes de défilement" },
      },
      required: ["direction"],
    },
    riskLevel: "LOW",

    probe: () => dependencies.controller.isAccessibilityEnabled(),

    execute: async (input, context) => {
      await assertAccessibility(dependencies, "android.ui.scroll");
      const { direction, amount } = dependencies.policy.assertScrollAllowed(
        input.direction,
        input.amount,
      );

      context.onProgress({ label: `défilement ${direction}` });
      const result = await dependencies.controller.scroll(direction, amount, context.signal);

      return { scrolled: result.scrolled, direction, amount };
    },
  };
}
