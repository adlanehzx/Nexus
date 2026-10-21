import { classify } from "./sensitivity.js";
import type { MemoryService } from "./service.js";
import type { MemoryKind, StorableLayer } from "./types.js";

export interface MemoryCandidate {
  content: string;
  kind: MemoryKind;
  layer: StorableLayer;
  confidence: number;
  tags: readonly string[];
  /** Inferred extraction is never written silently. */
  requiresReview: true;
  sensitive: boolean;
  sourceRunId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
}

/**
 * Deterministic and controlled extraction of high-value facts.
 *
 * Performs no writes directly: returns a list of proposed memory items for
 * user inspection or policy approval. Prohibited secrets are filtered out
 * before reaching this candidate list. An LLM-based extractor can implement
 * the same contract.
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
      const normalized = content.toLowerCase();
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
  return /\b(?:je|j'|mon|ma|mes|nous|i|my|we|our)\s*(?:prefere|préfère|aime|adore|travaille|habite|utilise|veux|souhaite|suis|ai|prefer|like|love|work|live|use|want|wish|am|have)\b/i.test(
    text,
  );
}

function isPreference(text: string): boolean {
  return /\b(?:prefere|préfère|aime|adore|veux|souhaite|toujours|jamais|prefer|like|love|want|wish|always|never)\b/i.test(
    text,
  );
}

function inferKind(text: string): MemoryKind {
  if (/\b(?:toujours|jamais|quand|procédure|procedure|always|never|when)\b/i.test(text)) {
    return "PROCEDURAL";
  }
  if (/\b(?:hier|aujourd'hui|demain|la semaine|en \d{4}|yesterday|today|tomorrow|last week|next week|in \d{4})\b/i.test(text)) {
    return "EPISODIC";
  }
  return "SEMANTIC";
}
