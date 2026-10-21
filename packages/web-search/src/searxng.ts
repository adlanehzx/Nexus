import { DependencyError } from "@nexus/shared";
import { z } from "zod";
import type {
  WebSearchProvider,
  WebSearchQuery,
  WebSearchResponse,
  WebSearchResult,
} from "./types.js";

const searxResultSchema = z
  .object({
    title: z.string().nullish(),
    url: z.string().nullish(),
    content: z.string().nullish(),
    engines: z.array(z.string()).nullish(),
    engine: z.string().nullish(),
    publishedDate: z.string().nullish(),
    score: z.number().finite().nullish(),
  })
  .passthrough();

const searxResponseSchema = z
  .object({
    query: z.string().optional(),
    number_of_results: z.number().finite().nonnegative().optional(),
    results: z.array(searxResultSchema).default([]),
    suggestions: z.array(z.string()).optional(),
    answers: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  })
  .passthrough();

export interface SearxngClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class SearxngClient implements WebSearchProvider {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: SearxngClientOptions) {
    this.#baseUrl = validatedBaseUrl(options.baseUrl);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async search(query: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchResponse> {
    const body = new URLSearchParams({ q: query.query, format: "json" });
    if (query.language !== undefined) body.set("language", query.language);
    if (query.categories?.length) body.set("categories", query.categories.join(","));
    if (query.timeRange !== undefined) body.set("time_range", query.timeRange);
    body.set("safesearch", String(query.safeSearch ?? 1));
    body.set("pageno", String(query.page ?? 1));

    const combined = AbortSignal.any([
      ...(signal === undefined ? [] : [signal]),
      AbortSignal.timeout(this.#timeoutMs),
    ]);

    let response: Response;
    try {
      response = await this.#fetch(new URL("search", this.#baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: combined,
      });
    } catch (error) {
      throw unavailable("SearXNG est injoignable.", error);
    }

    if (!response.ok) {
      throw unavailable(`SearXNG a refusé la recherche (HTTP ${String(response.status)}).`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw unavailable("SearXNG a renvoyé une réponse illisible.", error);
    }

    const parsed = searxResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw unavailable("SearXNG a renvoyé un format de réponse inattendu.");
    }

    const limit = Math.min(Math.max(query.limit ?? 10, 1), 20);
    const results = parsed.data.results
      .map(normalizeResult)
      .filter((result): result is WebSearchResult => result !== undefined)
      .slice(0, limit);

    return {
      query: parsed.data.query ?? query.query,
      results,
      suggestions: unique(parsed.data.suggestions ?? []).slice(0, 10),
      answers: unique((parsed.data.answers ?? []).map(renderAnswer)).slice(0, 5),
      numberOfResults: parsed.data.number_of_results ?? null,
    };
  }
}

function validatedBaseUrl(value: string): URL {
  if (!URL.canParse(value)) throw new TypeError("SearXNG baseUrl must be a valid URL");
  const url = new URL(value);
  if (url.username || url.password)
    throw new TypeError("SearXNG baseUrl must not contain credentials");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("SearXNG baseUrl must use HTTP(S)");
  }
  if (url.protocol === "http:" && !isPrivateServiceName(url.hostname)) {
    throw new TypeError("A remote SearXNG instance must use HTTPS");
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function isPrivateServiceName(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    !hostname.includes(".") ||
    hostname.endsWith(".internal")
  );
}

function normalizeResult(input: z.infer<typeof searxResultSchema>): WebSearchResult | undefined {
  if (!input.title || !input.url || !URL.canParse(input.url)) return undefined;
  const url = new URL(input.url);
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    return undefined;
  }
  const engines = input.engines ?? (input.engine == null ? [] : [input.engine]);
  return {
    title: bounded(input.title, 500),
    url: url.toString(),
    snippet: bounded(input.content ?? "", 2_000),
    engines: unique(engines).slice(0, 10),
    publishedAt: input.publishedDate ?? null,
    score: input.score ?? null,
  };
}

function renderAnswer(value: string | Record<string, unknown>): string {
  return bounded(typeof value === "string" ? value : JSON.stringify(value), 2_000);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => bounded(value, 500)).filter(Boolean))];
}

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function unavailable(message: string, cause?: unknown): DependencyError {
  return new DependencyError({
    message,
    userMessage: "Local web search is temporarily unavailable.",
    ...(cause === undefined ? {} : { cause }),
  });
}
