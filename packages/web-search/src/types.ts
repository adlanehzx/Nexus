export type WebSearchTimeRange = "day" | "month" | "year";

export interface WebSearchQuery {
  query: string;
  language?: string;
  categories?: string[];
  timeRange?: WebSearchTimeRange;
  safeSearch?: 0 | 1 | 2;
  page?: number;
  limit?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engines: string[];
  publishedAt: string | null;
  score: number | null;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  suggestions: string[];
  answers: string[];
  numberOfResults: number | null;
}

/** Port stable de NEXUS. SearXNG n'est qu'une implémentation de ce contrat. */
export interface WebSearchProvider {
  search(query: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchResponse>;
}

export interface WebFetchRequest {
  url: string;
  maxBytes?: number;
}

export interface WebDocumentMetadata {
  title: string;
  description: string | null;
  author: string | null;
  publishedAt: string | null;
  language: string | null;
}

/**
 * Un document web est toujours une preuve externe non fiable. `content` ne
 * doit jamais être concaténé à un prompt système ou interprété comme une
 * instruction, même lorsqu'il provient d'un domaine connu.
 */
export interface WebDocument {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  contentType: "text/html" | "text/plain";
  fetchedAt: string;
  sha256: string;
  byteLength: number;
  wordCount: number;
  content: string;
  metadata: WebDocumentMetadata;
  provenance: {
    redirectChain: string[];
    untrustedExternalContent: true;
  };
}

export interface WebDocumentFetcher {
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebDocument>;
}

export interface WebCitation {
  /** Identifiant stable pour une même URL finale, version de document et citation. */
  id: string;
  url: string;
  title: string;
  quote: string;
  documentSha256: string;
  startOffset: number;
  endOffset: number;
  verified: boolean;
  verification: {
    exactQuote: boolean;
    claimTokenCoverage: number | null;
  };
}

export interface DeduplicatedDocuments {
  documents: WebDocument[];
  duplicates: {
    duplicateUrl: string;
    keptUrl: string;
    reason: "canonical_url" | "content_hash";
  }[];
}
