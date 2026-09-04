import { z } from "zod";

/**
 * Forme des réponses de l'API.
 *
 * Une seule enveloppe pour tout : succès comme échec, liste comme objet. Le
 * client écrit un seul décodeur, et un ajout de champ ne casse rien.
 *
 * ```jsonc
 * { "data": { … }, "meta": { "requestId": "…" } }
 * { "error": { "code": "…", "message": "…", "retryable": false },
 *   "meta": { "requestId": "…" } }
 * ```
 *
 * `requestId` figure dans **chaque** réponse, pas seulement dans les erreurs.
 * C'est ce qui permet à un utilisateur de citer un identifiant pour une requête
 * qui a « bizarrement » réussi, et de retrouver toute son histoire côté serveur.
 */

export const responseMetaSchema = z.object({
  requestId: z.string(),
});

export function ok<T>(data: T, requestId: string): { data: T; meta: { requestId: string } } {
  return { data, meta: { requestId } };
}

/** Enveloppe de liste, avec le curseur de la page suivante. */
export function okList<T>(
  page: { items: T[]; nextCursor: string | null; total: number },
  requestId: string,
): {
  data: T[];
  meta: { requestId: string; nextCursor: string | null; total: number };
} {
  return {
    data: page.items,
    meta: { requestId, nextCursor: page.nextCursor, total: page.total },
  };
}

/** Schéma d'une réponse simple, pour la sérialisation et la documentation. */
export function okSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: responseMetaSchema });
}

/** Schéma d'une réponse paginée. */
export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    meta: responseMetaSchema.extend({
      nextCursor: z.string().nullable(),
      total: z.number().int().nonnegative(),
    }),
  });
}

/**
 * Paramètres de pagination communs.
 *
 * `limit` est plafonné à 100 : sans plafond, `?limit=1000000` transforme une
 * liste en déni de service, et ce n'est pas au client de se retenir.
 */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
