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
