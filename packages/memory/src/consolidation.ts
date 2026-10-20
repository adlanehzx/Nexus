import type { MemoryProvider } from "./provider.js";
import type { MemoryRecord } from "./types.js";

export interface DuplicateGroup {
  canonical: MemoryRecord;
  duplicates: readonly MemoryRecord[];
}

/** Détecte puis consolide uniquement des doublons exacts, jamais des paraphrases. */
export class MemoryConsolidator {
  readonly #provider: MemoryProvider;

  constructor(provider: MemoryProvider) {
    this.#provider = provider;
  }

  async plan(userId: string): Promise<readonly DuplicateGroup[]> {
    const records = (
      await this.#provider.search({ userId, query: "", limit: 10_000, includeSuperseded: false })
    ).map((hit) => hit.record);
    const groups = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const key = `${record.layer}:${record.kind}:${record.contentHash}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => {
        const ordered = [...group].sort(
          (left, right) =>
            right.importance - left.importance ||
            right.confidence - left.confidence ||
            left.validFrom.getTime() - right.validFrom.getTime(),
        );
        return { canonical: ordered[0]!, duplicates: ordered.slice(1) };
      });
  }

  /** Applique seulement les groupes explicitement approuvés par leur canonique. */
  async apply(
    userId: string,
    groups: readonly DuplicateGroup[],
    approvedCanonicalIds: readonly string[],
  ) {
    const approved = new Set(approvedCanonicalIds);
    let deleted = 0;
    for (const group of groups) {
      if (!approved.has(group.canonical.id)) continue;
      const tags = [
        ...new Set([...group.canonical.tags, ...group.duplicates.flatMap((item) => item.tags)]),
      ];
      await this.#provider.update({
        userId,
        id: group.canonical.id,
        importance: Math.max(
          group.canonical.importance,
          ...group.duplicates.map((item) => item.importance),
        ),
        confidence: Math.max(
          group.canonical.confidence,
          ...group.duplicates.map((item) => item.confidence),
        ),
        tags,
      });
      for (const duplicate of group.duplicates) {
        if (await this.#provider.delete({ userId, id: duplicate.id })) deleted += 1;
      }
    }
    return { deleted };
  }
}
