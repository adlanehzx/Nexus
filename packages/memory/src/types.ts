import { z } from "zod";

/**
 * Contrats de la mémoire — cf. docs/architecture/10-memory.md.
 *
 * Six choses portent le nom de « mémoire », et les confondre est la première
 * erreur possible dans ce domaine. Elles n'ont ni la même durée de vie, ni le
 * même propriétaire, ni les mêmes règles d'oubli :
 *
 * | Couche                    | Vit où                    | Disparaît quand           |
 * |---------------------------|---------------------------|---------------------------|
 * | 1. Historique de conversation | `ConversationStore`   | jamais (archivé)          |
 * | 2. Contexte court terme   | `ShortTermContext`        | à la fin de la session    |
 * | 3. Mémoire longue durée   | `MemoryProvider`          | quand l'utilisateur oublie|
 * | 4. Préférences            | `MemoryProvider` (couche) | quand elles changent      |
 * | 5. Appareils              | `DeviceRegistry`          | à la révocation           |
 * | 6. Historique des tâches  | `TaskStore`               | à la purge                |
 *
 * **Seules 3 et 4 sont stockées ici.** Les quatre autres ont déjà un propriétaire
 * dans le système, et les recopier créerait deux vérités qui divergeraient. Ce
 * paquet les lit à travers des ports (`sources.ts`) au moment d'assembler le
 * contexte, et ne les possède jamais.
 */

/**
 * Couche à laquelle appartient un souvenir.
 *
 * `WORKING` et `SHORT_TERM` figurent ici pour nommer l'assemblage du contexte,
 * mais aucun enregistrement n'est jamais persisté avec ces couches : ce qui vit
 * le temps d'un tour n'a pas à survivre au tour.
 */
export const memoryLayerSchema = z.enum([
  "WORKING",
  "SHORT_TERM",
  "CONVERSATION",
  "LONG_TERM",
  "PREFERENCE",
]);
export type MemoryLayer = z.infer<typeof memoryLayerSchema>;

/** Couches réellement persistées par `MemoryProvider`. */
export const storableLayerSchema = z.enum(["LONG_TERM", "PREFERENCE"]);
export type StorableLayer = z.infer<typeof storableLayerSchema>;

export const memoryKindSchema = z.enum(["SEMANTIC", "EPISODIC", "PROCEDURAL"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/**
 * Qui a voulu ce souvenir.
 *
 * La distinction n'est pas décorative. Un fait que l'utilisateur a dicté
 * (« retiens que… ») engage sa parole ; un fait que l'agent a déduit d'une
 * conversation engage une inférence, qui peut être fausse. L'interface les
 * affiche différemment, et l'oubli en masse ne traite pas les deux pareil.
 */
export const memoryOriginSchema = z.enum(["USER", "AGENT", "SYSTEM"]);
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;

/**
 * Sensibilité reconnue au moment de l'écriture.
 *
 * Conservée sur l'enregistrement, pas seulement évaluée au passage : c'est ce
 * qui permet à l'interface de signaler un souvenir sensible des mois plus tard,
 * et à une purge de les retrouver tous.
 */
export const sensitivitySchema = z.enum(["ORDINARY", "PERSONAL"]);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

/**
 * Un fait n'est jamais écrasé : il est supersédé. `validFrom`/`validUntil` et
 * `supersededById` conservent l'histoire — on peut donc répondre à
 * « où j'habitais l'an dernier ».
 */
export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  layer: storableLayerSchema.default("LONG_TERM"),
  kind: memoryKindSchema,
  content: z.string().min(1),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()).default([]),
  origin: memoryOriginSchema.default("USER"),
  sensitivity: sensitivitySchema.default("ORDINARY"),
  /**
   * Catégories sensibles reconnues — `sante`, `finance`, `identite`.
   *
   * Les noms de catégories, jamais un extrait du contenu : la liste sert à
   * expliquer et à filtrer, pas à reproduire ce qu'on cherche à protéger.
   */
  sensitiveCategories: z.array(z.string()).default([]),
  sourceRunId: z.string().nullable().default(null),
  sourceConversationId: z.string().nullable().default(null),
  sourceMessageId: z.string().nullable().default(null),
  sourceUri: z.string().nullable().default(null),
  contentHash: z.string().min(1),
  embeddingModel: z.string().nullable().default(null),
  extractedAt: z.date().nullable().default(null),
  validFrom: z.date(),
  validUntil: z.date().nullable().default(null),
  supersededById: z.string().nullable().default(null),
  /** Enregistrement que celui-ci remplace. Le fil de l'histoire d'un fait. */
  supersedesId: z.string().nullable().default(null),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export interface MemoryQuery {
  userId: string;
  text: string;
  kinds?: MemoryKind[];
  limit?: number;
  /** Budget de tokens alloué aux souvenirs dans la fenêtre de contexte. */
  tokenBudget?: number;
}
