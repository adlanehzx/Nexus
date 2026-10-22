import { createHash } from "node:crypto";

/** Replaceable port: local hashing, ONNX model, or remote private service. */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

interface TensorLike {
  tolist(): unknown[];
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<TensorLike>;

export interface TransformersEmbeddingProviderOptions {
  model?: string;
  dimensions?: number;
  cacheDir?: string;
  localFilesOnly?: boolean;
  /** Testing hook: avoids downloading models during CI. */
  load?: () => Promise<FeatureExtractor>;
}

/**
 * Multilingual neural embeddings executed locally via ONNX.
 *
 * Lazily loaded on first memory operation. Runs completely offline once downloaded.
 * No text leaves the machine and no API key is required.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly #load: () => Promise<FeatureExtractor>;
  #extractor: Promise<FeatureExtractor> | undefined;

  constructor(options: TransformersEmbeddingProviderOptions = {}) {
    this.model = options.model ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
    this.dimensions = options.dimensions ?? 384;
    if (this.dimensions < 32 || this.dimensions > 4_096) {
      throw new RangeError("embedding dimensions must be between 32 and 4096");
    }
    this.#load =
      options.load ??
      (async () => {
        const { pipeline } = await import("@huggingface/transformers");
        return pipeline("feature-extraction", this.model, {
          device: "cpu",
          dtype: "q8",
          ...(options.cacheDir === undefined ? {} : { cache_dir: options.cacheDir }),
          local_files_only: options.localFilesOnly ?? false,
        });
      });
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (texts.length === 0) return [];
    this.#extractor ??= this.#load();
    const tensor = await (
      await this.#extractor
    )([...texts], {
      pooling: "mean",
      normalize: true,
    });
    const values = tensor.tolist();
    if (!Array.isArray(values) || values.length !== texts.length) {
      throw new Error("Embedding model returned unexpected batch size.");
    }
    return values.map((value) => this.#validateVector(value));
  }

  #validateVector(value: unknown): number[] {
    if (
      !Array.isArray(value) ||
      value.length !== this.dimensions ||
      value.some((item) => typeof item !== "number" || !Number.isFinite(item))
    ) {
      throw new Error(`Embedding model must return ${this.dimensions} finite numbers per text.`);
    }
    return value as number[];
  }
}

/**
 * Local hashing embeddings requiring neither external models nor network access.
 *
 * Feature hashing of words and bigrams provides bounded, deterministic signal
 * that serves as zero-cost baseline fallback.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(options: { dimensions?: number; model?: string } = {}) {
    this.dimensions = options.dimensions ?? 256;
    if (this.dimensions < 32 || this.dimensions > 4_096) {
      throw new RangeError("embedding dimensions must be between 32 and 4096");
    }
    this.model = options.model ?? `nexus-hash-v1-${this.dimensions}`;
  }

  embed(texts: readonly string[]): Promise<readonly number[][]> {
    return Promise.resolve(texts.map((text) => this.#one(text)));
  }

  #one(text: string): number[] {
    const terms = semanticTerms(text);
    const features = [...terms];
    for (let index = 0; index + 1 < terms.length; index += 1) {
      features.push(`${terms[index]}_${terms[index + 1]}`);
    }

    const vector = Array.from<number>({ length: this.dimensions }).fill(0);
    for (const feature of features) {
      const digest = createHash("sha256").update(feature).digest();
      const bucket = digest.readUInt32BE(0) % this.dimensions;
      const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
      vector[bucket] = (vector[bucket] ?? 0) + sign;
    }
    return normalizeVector(vector);
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

export function normalizeMemoryContent(content: string): string {
  return content
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function memoryContentHash(content: string): string {
  // Deduplication key compatible with md5() in PostgreSQL.
  // Security decisions never rely on this hash.
  const normalized = content.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("md5").update(normalized).digest("hex");
}

function semanticTerms(text: string): string[] {
  return normalizeMemoryContent(text)
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2)
    .map((term) => ALIASES[term] ?? term);
}

const ALIASES: Readonly<Record<string, string>> = {
  adore: "aime",
  apprecie: "aime",
  prefere: "aime",
  preference: "aime",
  boulot: "travail",
  emploi: "travail",
  job: "travail",
  domicile: "habite",
  reside: "habite",
  voiture: "auto",
  automobile: "auto",
  velo: "bicyclette",
  love: "like",
  prefer: "like",
  bicycling: "cycling",
  bicycle: "cycling",
  bike: "cycling",
};

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}
