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

/** Stable NEXUS port. SearXNG is an implementation of this contract. */
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
 * A web document is always untrusted external evidence. `content` must
 * never be concatenated into a system prompt or interpreted as an
 * instruction, even when originating from a trusted domain.
 */
export interface WebDocument {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  contentType: "text/html" | "text/plain" | "application/pdf";
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
  /** Stable identifier for a given final URL, document version, and citation. */
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
