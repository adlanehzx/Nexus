import type { MemoryKind, MemoryOrigin, MemoryRecord, StorableLayer } from "./types.js";

export interface MemorySearchQuery {
  userId: string;
  /**
   * Texte libre : la requête de l'utilisateur, ou un extrait du tour courant.
   *
   * **Vide = tout parcourir**, du plus récent au plus ancien. C'est ce dont a
   * besoin l'écran de gestion de la mémoire, où l'utilisateur veut voir ce que
   * NEXUS retient de lui sans avoir à deviner un mot-clé. Ajouter une méthode
   * `list` séparée reviendrait à écrire deux fois le filtrage par utilisateur et
   * par validité — c'est-à-dire à écrire deux fois la frontière de sécurité.
   */
  query: string;
  kinds?: readonly MemoryKind[];
  layers?: readonly StorableLayer[];
  limit?: number;
  /** Inclut les faits supersédés ou périmés. Pour l'historique d'un fait. */
  includeSuperseded?: boolean;
}

export interface MemoryHit {
  record: MemoryRecord;
  /** Score de pertinence normalisé dans [0, 1]. */
  score: number;
}

export interface MemoryStoreInput {
  userId: string;
  kind: MemoryKind;
  content: string;
  layer?: StorableLayer;
  origin?: MemoryOrigin;
  importance?: number;
  confidence?: number;
  tags?: readonly string[];
  sourceRunId?: string;
  /** Sensibilité déjà arbitrée par `MemoryService`. */
  sensitivity?: MemoryRecord["sensitivity"];
  sensitiveCategories?: readonly string[];
}

/**
 * Ce qu'une mise à jour peut changer.
 *
 * `content` est à part : le modifier **supersède** l'enregistrement au lieu de
 * l'écraser (cf. `update`). Le reste est de la métadonnée, et se corrige sur
 * place.
 */
export interface MemoryUpdateInput {
  userId: string;
  id: string;
  content?: string;
  importance?: number;
  confidence?: number;
  tags?: readonly string[];
  layer?: StorableLayer;
  kind?: MemoryKind;
}

export interface MemorySummarizeInput {
  userId: string;
  /** Contenu à résumer — transcript de conversation, ou lot de souvenirs. */
  text: string;
  /** Longueur cible du résumé. Indicative, pas contractuelle. */
  maxChars?: number;
}

/**
 * Port `MemoryProvider`.
 *
 * Le cœur agent ne connaît que cette interface : ni pgvector, ni Redis, ni
 * modèle d'embedding. Passer d'une implémentation en mémoire à PostgreSQL +
 * pgvector (phase 6) est un changement d'adaptateur, pas de la boucle.
 *
 * **Toutes les méthodes portent `userId`, y compris celles qui reçoivent déjà un
 * identifiant d'enregistrement.** C'est redondant, et c'est voulu : un
 * identifiant devinable ne doit pas suffire à lire ou détruire le souvenir de
 * quelqu'un d'autre. La frontière est vérifiée au même endroit pour les cinq
 * méthodes, ce qui la rend impossible à oublier dans une seule.
 */
export interface MemoryProvider {
  search(query: MemorySearchQuery): Promise<MemoryHit[]>;
  store(input: MemoryStoreInput): Promise<MemoryRecord>;
  /**
   * Corrige un souvenir.
   *
   * Un changement de `content` ne modifie pas l'enregistrement : il en crée un
   * neuf et marque l'ancien comme supersédé, en gardant le fil entre les deux.
   * C'est ce qui permet de répondre à « où j'habitais l'an dernier » — question
   * parfaitement ordinaire à laquelle un écrasement rend toute réponse
   * impossible.
   *
   * Une correction de métadonnée — importance, étiquettes — s'applique sur
   * place : elle ne change pas ce qui est affirmé.
   *
   * @returns l'enregistrement courant, ou `undefined` s'il n'existe pas ou
   *   n'appartient pas à `userId`. Les deux cas sont volontairement
   *   indiscernables : distinguer « inconnu » de « pas à vous » indiquerait à un
   *   curieux quels identifiants existent.
   */
  update(input: MemoryUpdateInput): Promise<MemoryRecord | undefined>;
  delete(input: { userId: string; id: string }): Promise<boolean>;
  summarize(input: MemorySummarizeInput): Promise<string>;
}
