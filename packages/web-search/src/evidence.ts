import { createHash } from "node:crypto";
import type { DeduplicatedDocuments, WebCitation, WebDocument } from "./types.js";

const STOP_WORDS = new Set([
  "avec",
  "dans",
  "des",
  "elle",
  "est",
  "les",
  "pour",
  "que",
  "qui",
  "the",
  "this",
  "that",
  "from",
  "and",
  "are",
]);

export function createCitation(document: WebDocument, quote: string, claim?: string): WebCitation {
  const boundedQuote = quote.trim().slice(0, 1_000);
  const startOffset = boundedQuote ? document.content.indexOf(boundedQuote) : -1;
  const endOffset = startOffset < 0 ? -1 : startOffset + boundedQuote.length;
  const exactQuote = startOffset >= 0;
  const claimTokenCoverage = claim === undefined ? null : tokenCoverage(claim, boundedQuote);
  const verified = exactQuote && (claimTokenCoverage === null || claimTokenCoverage >= 0.5);
  const fingerprint = [document.finalUrl, document.sha256, boundedQuote].join("\u0000");
  return {
    id: `cite_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`,
    url: document.finalUrl,
    title: document.metadata.title,
    quote: boundedQuote,
    documentSha256: document.sha256,
    startOffset,
    endOffset,
    verified,
    verification: { exactQuote, claimTokenCoverage },
  };
}

/** Citations extractives : aucune phrase n'est inventée ou paraphrasée. */
export function suggestCitations(document: WebDocument, limit = 5): WebCitation[] {
  const candidates = document.content
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 60)
    .map((paragraph) => paragraph.slice(0, 500));
  return unique(candidates)
    .slice(0, Math.min(Math.max(limit, 0), 10))
    .map((quote) => createCitation(document, quote));
}

export function verifyCitation(
  citation: WebCitation,
  document: WebDocument,
  claim?: string,
): WebCitation {
  if (citation.documentSha256 !== document.sha256 || citation.url !== document.finalUrl) {
    return {
      ...citation,
      startOffset: -1,
      endOffset: -1,
      verified: false,
      verification: {
        exactQuote: false,
        claimTokenCoverage: claim === undefined ? null : tokenCoverage(claim, citation.quote),
      },
    };
  }
  return createCitation(document, citation.quote, claim);
}

export function deduplicateDocuments(documents: WebDocument[]): DeduplicatedDocuments {
  const kept: WebDocument[] = [];
  const duplicates: DeduplicatedDocuments["duplicates"] = [];
  const byCanonical = new Map<string, WebDocument>();
  const byHash = new Map<string, WebDocument>();

  for (const document of documents) {
    const canonicalKey = normalizedCanonical(document.canonicalUrl);
    const canonicalMatch = byCanonical.get(canonicalKey);
    if (canonicalMatch) {
      duplicates.push({
        duplicateUrl: document.finalUrl,
        keptUrl: canonicalMatch.finalUrl,
        reason: "canonical_url",
      });
      continue;
    }
    const hashMatch = byHash.get(document.sha256);
    if (hashMatch) {
      duplicates.push({
        duplicateUrl: document.finalUrl,
        keptUrl: hashMatch.finalUrl,
        reason: "content_hash",
      });
      continue;
    }
    kept.push(document);
    byCanonical.set(canonicalKey, document);
    byHash.set(document.sha256, document);
  }
  return { documents: kept, duplicates };
}

function normalizedCanonical(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function tokenCoverage(claim: string, quote: string): number {
  const claimTokens = meaningfulTokens(claim);
  if (!claimTokens.length) return 1;
  const quoteTokens = new Set(meaningfulTokens(quote));
  const matched = claimTokens.filter((token) => quoteTokens.has(token)).length;
  return Number((matched / claimTokens.length).toFixed(3));
}

function meaningfulTokens(value: string): string[] {
  return unique(
    (
      value
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g) ?? []
    ).filter((token) => !STOP_WORDS.has(token)),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
