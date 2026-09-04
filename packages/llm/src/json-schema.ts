import { z } from "zod";

/**
 * Convertit un schéma Zod en JSON Schema pour la description d'outil.
 *
 * Zod 4 fournit `toJSONSchema` nativement — aucune dépendance supplémentaire.
 * On force `io: "input"` : c'est bien la forme **attendue en entrée** qu'on
 * décrit au modèle, pas la forme produite après transformations.
 *
 * `$schema` est retiré : les fournisseurs ne l'attendent pas dans un schéma
 * d'outil, et sa présence fait échouer certains validateurs stricts.
 */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  const { $schema: _schema, ...rest } = json;
  return rest;
}
