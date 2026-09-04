import { Validator } from "@cfworker/json-schema";
import { z } from "zod";

/**
 * Validation des arguments d'un outil MCP.
 *
 * Un serveur MCP déclare ses entrées en **JSON Schema**, pas en Zod. Plutôt que
 * de traduire — traduction toujours partielle, qui finirait par accepter ce que
 * le serveur refuse ou l'inverse —, on valide contre le schéma d'origine avec un
 * vrai validateur JSON Schema, et on enveloppe le résultat dans un type Zod pour
 * que `ToolDefinition` reste homogène.
 *
 * `@cfworker/json-schema` est déjà une dépendance du SDK MCP : c'est le même
 * validateur que celui utilisé côté serveur, donc le même verdict des deux côtés.
 */

/** Draft par défaut de MCP. */
const DEFAULT_DRAFT = "2020-12" as const;

export interface JsonSchemaValidationIssue {
  path: string;
  message: string;
}

function formatIssues(errors: readonly { instanceLocation: string; error: string }[]): string {
  return errors
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.instanceLocation === "#" ? "(racine)" : issue.instanceLocation} — ${issue.error}`,
    )
    .join(" ; ");
}

/**
 * Construit un `z.ZodType` qui valide contre un JSON Schema.
 *
 * Le validateur est compilé une fois, à la découverte de l'outil, pas à chaque
 * appel.
 */
export function zodFromJsonSchema(
  schema: Record<string, unknown>,
  draft: "4" | "7" | "2019-09" | "2020-12" = DEFAULT_DRAFT,
): z.ZodType<unknown> {
  const validator = new Validator(schema, draft);

  // `superRefine` plutôt que `z.custom` : il donne accès au contexte d'erreur,
  // donc un message qui NOMME le champ fautif. C'est ce message que le modèle
  // reçoit en observation — « paramètres invalides » ne l'aiderait pas à corriger.
  return z.unknown().superRefine((value, ctx) => {
    const result = validator.validate(value);
    if (result.valid) return;
    ctx.addIssue({ code: "custom", message: formatIssues(result.errors) });
  });
}

/**
 * Normalise un schéma d'outil avant de le décrire au modèle.
 *
 * Deux corrections seulement, et aucune invention : un objet sans `properties`
 * en reçoit un vide (certains serveurs l'omettent, ce que plusieurs
 * fournisseurs LLM refusent), et `$schema` est retiré — les API d'outils ne
 * l'attendent pas.
 */
export function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;

  if (rest.type === "object" && rest.properties === undefined) {
    return { ...rest, properties: {} };
  }
  return rest;
}
