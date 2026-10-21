import { memoryContentHash } from "./embedding.js";
import type { MemoryProvider } from "./provider.js";
import { ConservativeTokenCounter, type TokenCounter } from "./tokens.js";

export interface ContextArtifact {
  id: string;
  userId: string;
  mediaType: string;
  content: string;
  contentHash: string;
  createdAt: Date;
  sourceRunId?: string;
}

export interface ContextArtifactStore {
  put(artifact: ContextArtifact): Promise<void>;
  get(input: { userId: string; id: string }): Promise<ContextArtifact | undefined>;
}

/** Local development store; production can provide PostgreSQL/S3. */
export class InMemoryContextArtifactStore implements ContextArtifactStore {
  readonly #artifacts = new Map<string, ContextArtifact>();

  put(artifact: ContextArtifact): Promise<void> {
    this.#artifacts.set(`${artifact.userId}:${artifact.id}`, artifact);
    return Promise.resolve();
  }

  get(input: { userId: string; id: string }): Promise<ContextArtifact | undefined> {
    return Promise.resolve(this.#artifacts.get(`${input.userId}:${input.id}`));
  }
}

export interface CompactedContext {
  text: string;
  originalTokens: number;
  compactedTokens: number;
  artifactId?: string;
}

/**
 * Offloads oversized content from prompt before summarization.
 * The original text remains addressable as an artifact with a reference in the summary.
 */
export class ContextCompactor {
  readonly #memory: MemoryProvider;
  readonly #artifacts: ContextArtifactStore;
  readonly #tokens: TokenCounter;
  readonly #now: () => Date;

  constructor(options: {
    memory: MemoryProvider;
    artifacts: ContextArtifactStore;
    tokens?: TokenCounter;
    now?: () => Date;
  }) {
    this.#memory = options.memory;
    this.#artifacts = options.artifacts;
    this.#tokens = options.tokens ?? new ConservativeTokenCounter();
    this.#now = options.now ?? (() => new Date());
  }

  async compact(input: {
    userId: string;
    text: string;
    maxTokens: number;
    model?: string;
    sourceRunId?: string;
  }): Promise<CompactedContext> {
    const originalTokens = this.#tokens.count(input.text, input.model);
    if (originalTokens <= input.maxTokens) {
      return { text: input.text, originalTokens, compactedTokens: originalTokens };
    }

    const contentHash = memoryContentHash(input.text);
    const artifactId = `context-${contentHash.slice(0, 24)}`;
    await this.#artifacts.put({
      id: artifactId,
      userId: input.userId,
      mediaType: "text/plain",
      content: input.text,
      contentHash,
      createdAt: this.#now(),
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
    });

    let summary = await this.#memory.summarize({
      userId: input.userId,
      text: input.text,
      maxChars: Math.max(64, input.maxTokens * 3),
    });
    const marker = `[full content: artifact ${artifactId}]`;
    const markerTokens = this.#tokens.count(marker, input.model);
    const target = Math.max(0, input.maxTokens - markerTokens);
    while (this.#tokens.count(summary, input.model) > target && summary.length > 32) {
      summary = summary.slice(0, Math.max(32, Math.floor(summary.length * 0.8))).trimEnd();
    }
    const text = `${summary}\n${marker}`;
    return {
      text,
      originalTokens,
      compactedTokens: this.#tokens.count(text, input.model),
      artifactId,
    };
  }
}
