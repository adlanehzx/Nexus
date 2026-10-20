import { classify } from "./sensitivity.js";
import type { MemoryService } from "./service.js";
import type { MemoryKind, StorableLayer } from "./types.js";

export interface MemoryCandidate {
  content: string;
  kind: MemoryKind;
  layer: StorableLayer;
  confidence: number;
  tags: readonly string[];
  /** Une extraction n'est jamais écrite silencieusement. */
  requiresReview: true;
  sensitive: boolean;
  sourceRunId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
}

/**
 * Extraction déterministe et contrôlée de faits à forte valeur.
 *
 * Elle ne fait aucune écriture : le résultat est une liste de propositions à
 * afficher ou à faire approuver par une politique. Les secrets sont éliminés
 * avant même cette liste. Un extracteur LLM pourra implémenter le même contrat.
 */
export class ControlledMemoryExtractor {
  extract(input: {
    text: string;
    sourceRunId?: string;
    sourceConversationId?: string;
    sourceMessageId?: string;
    limit?: number;
  }): MemoryCandidate[] {
    const limit = Math.max(0, Math.min(input.limit ?? 8, 25));
    const candidates: MemoryCandidate[] = [];
    const seen = new Set<string>();

    for (const raw of input.text.split(/(?<=[.!?])\s+|\n+/)) {
      const content = raw.replace(/^[-*]\s*/, "").trim();
      if (!isDurableFirstPersonFact(content)) continue;
      const normalized = content.toLocaleLowerCase("fr");
      if (seen.has(normalized)) continue;

      const verdict = classify(content);
      if (verdict.verdict === "FORBIDDEN") continue;
      seen.add(normalized);
      candidates.push({
        content,
        kind: inferKind(content),
        layer: isPreference(content) ? "PREFERENCE" : "LONG_TERM",
        confidence: 0.72,
        tags: ["extracted"],
        requiresReview: true,
        sensitive: verdict.verdict === "PERSONAL",
        ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
        ...(input.sourceConversationId === undefined
          ? {}
          : { sourceConversationId: input.sourceConversationId }),
        ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }

  async storeApproved(input: {
    userId: string;
    service: MemoryService;
    candidates: readonly MemoryCandidate[];
    approvedIndexes: readonly number[];
    now?: Date;
  }): Promise<readonly string[]> {
    const approved = new Set(input.approvedIndexes);
    const stored: string[] = [];
    for (const [index, candidate] of input.candidates.entries()) {
      if (!approved.has(index)) continue;
      const record = await input.service.remember({
        userId: input.userId,
        content: candidate.content,
        kind: candidate.kind,
        layer: candidate.layer,
        origin: "AGENT",
        confidence: candidate.confidence,
        tags: candidate.tags,
        acknowledgedSensitive: candidate.sensitive,
        extractedAt: input.now ?? new Date(),
        ...(candidate.sourceRunId === undefined ? {} : { sourceRunId: candidate.sourceRunId }),
        ...(candidate.sourceConversationId === undefined
          ? {}
          : { sourceConversationId: candidate.sourceConversationId }),
        ...(candidate.sourceMessageId === undefined
          ? {}
          : { sourceMessageId: candidate.sourceMessageId }),
      });
      stored.push(record.id);
    }
    return stored;
  }
}

function isDurableFirstPersonFact(text: string): boolean {
  if (text.length < 8 || text.length > 500 || text.endsWith("?")) return false;
  return /\b(?:je|j'|mon|ma|mes|nous)\s*(?:prefere|préfère|aime|adore|travaille|habite|utilise|veux|souhaite|suis|ai)\b/i.test(
    text,
  );
}

function isPreference(text: string): boolean {
  return /\b(?:prefere|préfère|aime|adore|veux|souhaite|toujours|jamais)\b/i.test(text);
}

function inferKind(text: string): MemoryKind {
  if (/\b(?:toujours|jamais|quand|procédure|procedure)\b/i.test(text)) return "PROCEDURAL";
  if (/\b(?:hier|aujourd'hui|demain|la semaine|en \d{4})\b/i.test(text)) return "EPISODIC";
  return "SEMANTIC";
}
