import { z } from "zod";

/**
 * API response format.
 *
 * A single envelope for everything: success as well as failure, lists as well as objects.
 * The client writes a single decoder, and adding a field breaks nothing.
 *
 * ```jsonc
 * { "data": { … }, "meta": { "requestId": "…" } }
 * { "error": { "code": "…", "message": "…", "retryable": false },
 *   "meta": { "requestId": "…" } }
 * ```
 *
 * `requestId` appears in **every** response, not only in errors.
 * This is what allows a user to cite an ID for a request that "mysteriously" succeeded,
 * and trace its entire history server-side.
 */

export const responseMetaSchema = z.object({
  requestId: z.string(),
});

export function ok<T>(data: T, requestId: string): { data: T; meta: { requestId: string } } {
  return { data, meta: { requestId } };
}

/** List envelope, with cursor for the next page. */
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

/** Simple response schema, for serialization and documentation. */
export function okSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: responseMetaSchema });
}

/** Paginated response schema. */
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
 * Common pagination query parameters.
 *
 * `limit` is capped at 100: without a cap, `?limit=1000000` turns a
 * list into a denial of service, and it is not up to the client to hold back.
 */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
