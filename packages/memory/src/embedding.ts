import { createHash } from "node:crypto";

/** Port remplaçable : local aujourd'hui, modèle ONNX ou service privé demain. */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

/**
 * Embeddings locaux sans modèle ni réseau.
 *
 * Le feature hashing de mots et bigrammes n'a pas la finesse d'un modèle
 * neuronal, mais donne un signal sémantique reproductible, borné et gratuit.
 * Il constitue le repli permanent ; le port permet de brancher FastEmbed sans
 * toucher au magasin ni à l'assembleur.
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
  // Ce n'est ni une signature ni une protection d'intégrité : seulement une
  // clé de déduplication compatible avec md5(), disponible dans PostgreSQL sans
  // extension. Les décisions de sécurité ne reposent jamais sur cette valeur.
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
};

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}
