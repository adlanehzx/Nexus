import { createHash } from "node:crypto";
import { DependencyError, ValidationError } from "@nexus/shared";
import { assertPublicWebUrl, type HostResolver } from "./network-policy.js";
import type { WebDocument, WebDocumentFetcher, WebFetchRequest } from "./types.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 300_000;
const MAX_REDIRECTS = 5;

export interface SafeWebFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: typeof globalThis.fetch;
  resolver?: HostResolver;
  now?: () => Date;
  pdfParser?: PdfParser;
}

type PdfParser = (
  bytes: Uint8Array,
  url: URL,
) => Promise<{ content: string; metadata: WebDocument["metadata"] }>;

/**
 * Read-only client. DNS resolution is validated before each request
 * and each redirect. Content remains explicitly marked untrusted.
 */
export class SafeWebFetcher implements WebDocumentFetcher {
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #resolver: HostResolver | undefined;
  readonly #now: () => Date;
  readonly #pdfParser: PdfParser;

  constructor(options: SafeWebFetcherOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBytes = clampBytes(options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#resolver = options.resolver;
    this.#now = options.now ?? (() => new Date());
    this.#pdfParser = options.pdfParser ?? parsePdf;
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebDocument> {
    const maxBytes = clampBytes(request.maxBytes ?? this.#maxBytes);
    const requested = await this.#validate(request.url);
    let current = requested;
    const redirectChain: string[] = [];
    const combined = AbortSignal.any([
      ...(signal === undefined ? [] : [signal]),
      AbortSignal.timeout(this.#timeoutMs),
    ]);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      let response: Response;
      try {
        response = await this.#fetch(current, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/pdf;q=0.95,text/plain;q=0.9",
            "user-agent": "NEXUS-WebResearch/1.0 (+local read-only fetcher)",
          },
          signal: combined,
        });
      } catch (error) {
        throw unavailable("La page web est injoignable.", error);
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw unavailable("Web redirect does not specify a destination.");
        if (redirects === MAX_REDIRECTS) {
          throw unavailable("Web page contains too many redirects.");
        }
        redirectChain.push(current.toString());
        current = await this.#validate(new URL(location, current));
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw unavailable(`Web page returned HTTP ${String(response.status)}.`);
      }

      const contentType = parseContentType(response.headers.get("content-type"));
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge();
      }
      const bytes = await readBoundedBody(response, maxBytes);
      const extracted =
        contentType === "application/pdf"
          ? {
              ...(await this.#pdfParser(bytes, current)),
              canonicalUrl: current.toString(),
            }
          : extractTextDocument(bytes, response.headers.get("content-type"), contentType, current);
      const content = extracted.content.slice(0, MAX_TEXT_CHARS);
      if (!content) throw unavailable("La page web ne contient aucun texte exploitable.");
      const sha256 = createHash("sha256").update(content).digest("hex");

      return {
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        canonicalUrl: extracted.canonicalUrl,
        contentType,
        fetchedAt: this.#now().toISOString(),
        sha256,
        byteLength: bytes.byteLength,
        wordCount: words(content).length,
        content,
        metadata: extracted.metadata,
        provenance: {
          redirectChain,
          untrustedExternalContent: true,
        },
      };
    }
    throw unavailable("La page web contient trop de redirections.");
  }

  #validate(value: string | URL): Promise<URL> {
    return this.#resolver === undefined
      ? assertPublicWebUrl(value)
      : assertPublicWebUrl(value, this.#resolver);
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const readResult = (await reader.read()) as {
        done: boolean;
        value?: Uint8Array;
      };
      if (readResult.done) break;
      const value = readResult.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function extractHtml(
  html: string,
  pageUrl: URL,
): {
  content: string;
  canonicalUrl: string;
  metadata: WebDocument["metadata"];
} {
  const title = first(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const description = meta(html, "description") ?? metaProperty(html, "og:description");
  const author = meta(html, "author") ?? metaProperty(html, "article:author");
  const publishedAt =
    metaProperty(html, "article:published_time") ?? meta(html, "date") ?? timeValue(html);
  const language = first(html, /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  const canonical = first(
    html,
    /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*canonical[^"']*["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i,
  );
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/article|\/section|\/h[1-6]|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  let canonicalUrl = pageUrl.toString();
  if (canonical) {
    try {
      const candidate = new URL(decodeEntities(canonical), pageUrl);
      // Cross-domain canonical links can pollute provenance and deduplication.
      if (
        (candidate.protocol === "http:" || candidate.protocol === "https:") &&
        candidate.origin === pageUrl.origin &&
        !candidate.username &&
        !candidate.password
      ) {
        candidate.hash = "";
        canonicalUrl = candidate.toString();
      }
    } catch {
      // Invalid canonical: final URL remains source of truth.
    }
  }
  return {
    content: normalizeText(body),
    canonicalUrl,
    metadata: {
      title: cleanMetadata(title) || pageUrl.hostname,
      description: nullableMetadata(description),
      author: nullableMetadata(author),
      publishedAt: nullableMetadata(publishedAt),
      language: nullableMetadata(language),
    },
  };
}

function meta(html: string, name: string): string | null {
  return attributeContent(html, "name", name);
}

function metaProperty(html: string, property: string): string | null {
  return attributeContent(html, "property", property);
}

function attributeContent(html: string, attribute: string, value: string): string | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return first(
    html,
    new RegExp(
      `<meta\\b(?=[^>]*\\b${attribute}\\s*=\\s*["']${escaped}["'])[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`,
      "i",
    ),
  );
}

function timeValue(html: string): string | null {
  return first(html, /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i);
}

function first(input: string, pattern: RegExp): string | null {
  return pattern.exec(input)?.[1] ?? null;
}

function normalizeText(value: string): string {
  return decodeEntities(value)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
    if (key.startsWith("#x")) return safeCodePoint(Number.parseInt(key.slice(2), 16), entity);
    if (key.startsWith("#")) return safeCodePoint(Number.parseInt(key.slice(1), 10), entity);
    return named[key.toLowerCase()] ?? entity;
  });
}

function safeCodePoint(codePoint: number, fallback: string): string {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function parseContentType(value: string | null): WebDocument["contentType"] {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "text/html";
  if (mime === "text/plain") return "text/plain";
  if (mime === "application/pdf") return "application/pdf";
  throw new ValidationError({
    message: `Unsupported web content type: ${mime ?? "missing"}`,
    userMessage: "Ce type de contenu web n’est pas encore pris en charge.",
  });
}

function extractTextDocument(
  bytes: Uint8Array,
  contentTypeHeader: string | null,
  contentType: "text/html" | "text/plain",
  current: URL,
) {
  const decoded = new TextDecoder(detectCharset(contentTypeHeader), { fatal: false }).decode(bytes);
  return contentType === "text/html"
    ? extractHtml(decoded, current)
    : {
        content: normalizeText(decoded),
        canonicalUrl: current.toString(),
        metadata: emptyMetadata(),
      };
}

async function parsePdf(
  bytes: Uint8Array,
  url: URL,
): Promise<{ content: string; metadata: WebDocument["metadata"] }> {
  const { PDFParse } = await import("pdf-parse");
  // pdf.js transfers buffer to its worker. In Node, copying elements
  // ensures an independent ordinary ArrayBuffer.
  const parser = new PDFParse({ data: Uint8Array.from(bytes) });
  try {
    // Sequential calls prevent duplicate buffer transfers to PDF.js worker.
    const text = await parser.getText();
    const info = await parser.getInfo();
    const pageText = text.pages
      .map((page) => `--- page ${String(page.num)} ---\n${page.text.trim()}`)
      .join("\n\n");
    const documentInfo = (info.info ?? {}) as Record<string, unknown>;
    return {
      content: normalizeText(pageText),
      metadata: {
        title:
          metadataString(documentInfo.Title) ?? url.pathname.split("/").at(-1) ?? "PDF document",
        description: metadataString(documentInfo.Subject),
        author: metadataString(documentInfo.Author),
        publishedAt: info.getDateNode().CreationDate?.toISOString() ?? null,
        language: null,
      },
    };
  } catch (error) {
    throw unavailable("PDF document could not be parsed.", error);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function metadataString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, 1_000) || null;
}

function detectCharset(value: string | null): "utf-8" | "windows-1252" {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(value ?? "")?.[1]?.toLowerCase();
  return charset === "iso-8859-1" || charset === "windows-1252" ? "windows-1252" : "utf-8";
}

function cleanMetadata(value: string | null): string {
  return decodeEntities(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function nullableMetadata(value: string | null): string | null {
  return cleanMetadata(value) || null;
}

function emptyMetadata(): WebDocument["metadata"] {
  return {
    title: "Text document",
    description: null,
    author: null,
    publishedAt: null,
    language: null,
  };
}

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

function clampBytes(value: number): number {
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError("maxBytes must be a positive integer");
  return Math.min(value, ABSOLUTE_MAX_BYTES);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function tooLarge(): ValidationError {
  return new ValidationError({
    message: "Web response exceeded the configured byte limit",
    userMessage: "That web page is too large to be parsed safely.",
  });
}

function unavailable(message: string, cause?: unknown): DependencyError {
  return new DependencyError({
    message,
    userMessage: "That web page cannot be fetched right now.",
    ...(cause === undefined ? {} : { cause }),
  });
}
