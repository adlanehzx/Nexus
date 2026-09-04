import { uuidv7 } from "@nexus/shared";
import type { MemoryRecord } from "./types.js";
import type {
  MemoryHit,
  MemoryProvider,
  MemorySearchQuery,
  MemoryStoreInput,
  MemorySummarizeInput,
  MemoryUpdateInput,
} from "./provider.js";

/**
 * Fournisseur de mémoire en mémoire vive.
 *
 * Ce n'est pas un bouchon de test : c'est une implémentation réelle, utilisable
 * en développement, et la référence de comportement à laquelle l'implémentation
 * pgvector de la phase 6 devra se conformer.
 *
 * La recherche est lexicale (chevauchement de termes pondéré par l'importance et
 * la fraîcheur). Elle rate les paraphrases — c'est précisément ce que la
 * recherche hybride vectorielle corrigera, sans changer cette interface.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  readonly #records = new Map<string, MemoryRecord>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  store(input: MemoryStoreInput): Promise<MemoryRecord> {
    const now = this.#now();
    const record: MemoryRecord = {
      id: uuidv7(now.getTime()),
      userId: input.userId,
      layer: input.layer ?? "LONG_TERM",
      kind: input.kind,
      content: input.content,
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.8,
      tags: [...(input.tags ?? [])],
      origin: input.origin ?? "USER",
      sensitivity: input.sensitivity ?? "ORDINARY",
      sensitiveCategories: [...(input.sensitiveCategories ?? [])],
      validFrom: now,
      validUntil: null,
      supersededById: null,
      supersedesId: null,
    };
    this.#records.set(record.id, record);
    return Promise.resolve(record);
  }

  /**
   * Corrige un souvenir.
   *
   * Deux chemins, et la distinction est celle de la nature du changement :
   * réviser ce qui est **affirmé** supersède, corriger ce qui est **annoté**
   * s'applique sur place.
   */
  update(input: MemoryUpdateInput): Promise<MemoryRecord | undefined> {
    const existing = this.#owned(input.userId, input.id);
    if (existing === undefined) return Promise.resolve(undefined);

    const changesContent = input.content !== undefined && input.content !== existing.content;

    if (!changesContent) {
      const patched: MemoryRecord = {
        ...existing,
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
        ...(input.layer === undefined ? {} : { layer: input.layer }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
      };
      this.#records.set(patched.id, patched);
      return Promise.resolve(patched);
    }

    const now = this.#now();
    const replacement: MemoryRecord = {
      ...existing,
      id: uuidv7(now.getTime()),
      content: input.content ?? existing.content,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
      ...(input.layer === undefined ? {} : { layer: input.layer }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      validFrom: now,
      validUntil: null,
      supersededById: null,
      supersedesId: existing.id,
    };

    // L'ancien n'est pas détruit : il cesse d'être vrai à partir de maintenant.
    this.#records.set(existing.id, {
      ...existing,
      validUntil: now,
      supersededById: replacement.id,
    });
    this.#records.set(replacement.id, replacement);

    return Promise.resolve(replacement);
  }

  delete(input: { userId: string; id: string }): Promise<boolean> {
    if (this.#owned(input.userId, input.id) === undefined) return Promise.resolve(false);
    return Promise.resolve(this.#records.delete(input.id));
  }

  search(query: MemorySearchQuery): Promise<MemoryHit[]> {
    const terms = tokenize(query.query);
    const now = this.#now().getTime();
    const limit = query.limit ?? 8;
    const hits: MemoryHit[] = [];

    for (const record of this.#records.values()) {
      if (record.userId !== query.userId) continue;
      if (query.kinds !== undefined && !query.kinds.includes(record.kind)) continue;
      if (query.layers !== undefined && !query.layers.includes(record.layer)) continue;

      // Un fait supersédé ou périmé ne remonte plus, mais reste conservé :
      // on peut encore répondre à « où j'habitais l'an dernier ».
      if (query.includeSuperseded !== true) {
        if (record.supersededById !== null) continue;
        if (record.validUntil !== null && record.validUntil.getTime() <= now) continue;
      }

      // Requête vide : on parcourt. C'est l'écran de gestion, où l'utilisateur
      // veut voir ce que NEXUS retient de lui sans deviner un mot-clé.
      if (terms.length === 0) {
        hits.push({ record, score: recency(record, now) });
        continue;
      }

      const recordTerms = new Set(tokenize(record.content));
      const overlap = terms.filter((term) => recordTerms.has(term)).length;
      if (overlap === 0) continue;

      const lexical = overlap / terms.length;
      hits.push({
        record,
        score: 0.7 * lexical + 0.2 * record.importance + 0.1 * recency(record, now),
      });
    }

    hits.sort((left, right) => right.score - left.score || compareIds(left, right));
    return Promise.resolve(hits.slice(0, limit));
  }

  /**
   * Résumé extractif : les premières phrases jusqu'au budget.
   *
   * Volontairement non génératif — un `MemoryProvider` ne doit pas dépendre d'un
   * LLM. L'implémentation de production branchera un modèle rapide derrière
   * cette même signature.
   */
  summarize(input: MemorySummarizeInput): Promise<string> {
    const budget = input.maxChars ?? 500;
    const sentences = input.text
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);

    const kept: string[] = [];
    let length = 0;
    for (const sentence of sentences) {
      if (length + sentence.length > budget) break;
      kept.push(sentence);
      length += sentence.length + 1;
    }

    return Promise.resolve(kept.length > 0 ? kept.join(" ") : input.text.slice(0, budget));
  }

  /** Nombre de souvenirs stockés — diagnostic et tests. */
  get size(): number {
    return this.#records.size;
  }

  /**
   * Récupère un enregistrement **appartenant à cet utilisateur**.
   *
   * Un seul endroit vérifie la propriété, et les quatre méthodes qui manipulent
   * un identifiant passent par lui. Une vérification répétée à quatre endroits
   * finit toujours par manquer au cinquième.
   */
  #owned(userId: string, id: string): MemoryRecord | undefined {
    const record = this.#records.get(id);
    return record?.userId === userId ? record : undefined;
  }
}

/**
 * Fraîcheur d'un souvenir, de 0 à 1. Demi-vie de 30 jours.
 *
 * Un souvenir ancien reste pertinent, mais un souvenir récent le devance à
 * pertinence lexicale égale.
 */
function recency(record: MemoryRecord, now: number): number {
  const ageDays = (now - record.validFrom.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / 30);
}

/** Départage deux scores égaux. Un tri instable ferait sauter la liste à chaque rendu. */
function compareIds(left: MemoryHit, right: MemoryHit): number {
  return left.record.id < right.record.id ? 1 : -1;
}

/** Mots de 3 caractères ou plus, sans accents ni casse. */
function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
}
