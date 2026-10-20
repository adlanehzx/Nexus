export * from "./client.js";
export * as Prisma from "./generated/prisma/models.js";
export { $Enums } from "./generated/prisma/client.js";

/**
 * Types d'entrée JSON de Prisma.
 *
 * Réexportés parce que les magasins ont besoin de nommer ce que Prisma attend
 * dans une colonne `Json`. Sans eux, le seul moyen d'y écrire une valeur du
 * domaine était un `as any` — qui fait taire le compilateur sur bien plus que
 * la question posée.
 */
export type {
  InputJsonObject,
  InputJsonValue,
} from "./generated/prisma/internal/prismaNamespace.js";

/**
 * Sentinelle de `NULL` SQL pour une colonne `Json` nullable.
 *
 * Prisma distingue deux absences dans une colonne JSON : `DbNull`, qui est un
 * `NULL` SQL, et `JsonNull`, qui est la valeur JSON `null` **stockée**. Passer
 * un `null` JavaScript n'exprime ni l'un ni l'autre et est refusé par les
 * types d'entrée — d'où ce réexport, pour que les magasins puissent dire
 * laquelle des deux ils veulent.
 */
export { DbNull } from "./generated/prisma/internal/prismaNamespace.js";
