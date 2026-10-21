# NEXUS Web Search

NEXUS exposes two internal port interfaces: `WebSearchProvider` to discover external sources and
`WebDocumentFetcher` to retrieve and read web pages. The agent core remains agnostic of SearXNG APIs:
it interacts strictly via stable tools: `search.web` and `web.fetch`.

```text
Agent Core → ToolRegistry → search.web → WebSearchProvider → SearXNG
                         ↘ web.fetch  → SafeWebFetcher → Public Web Page
```

This boundary enables replacing or upgrading SearXNG without altering prompts, permissions, or the
orchestrator. The provider normalizes results, truncates content length, and rejects non-HTTP(S) URLs
or credentials embedded in query paths.

`web.fetch` retrieves solely HTML or plaintext, extracting readable text and metadata without running
arbitrary JavaScript, returning:

- Requested URL, final redirected URL, and canonical same-origin URL;
- Complete HTTP redirect chain;
- Page title, author, language, and publication date when present;
- SHA-256 hash of the retrieved document version;
- Bounded text content alongside stable extractive citations.

Citations represent exact verbatim excerpts from the source document. `createCitation` and `verifyCitation`
verify the version hash, URL, byte/character offsets, and minimal lexical coverage against asserted claims.
This validation is deterministic: it prevents fabricated citations, while leaving semantic truth
evaluation to the reasoning model.

`deduplicateDocuments` eliminates redundant sources via normalized canonical URLs and content hashing,
preserving source attribution provenance across duplicates.

## Security Controls

- Zero third-party LLM or search engine API keys required;
- SearXNG binds strictly to the local loopback interface, never publicly exposed;
- JSON format output must be explicitly enabled in `settings.yml`;
- Extracted snippets are treated as untrusted external data, never as system instructions;
- `search.web` and `web.fetch` are read-only, idempotent, and require `browser.navigate` permissions;
- Remote engine instances require HTTPS.

The document fetcher applies defensive checks prior to the initial query and before following every redirect:

- Protocols restricted to HTTP(S), disallowing inline user credentials;
- Outbound ports restricted strictly to 80 and 443;
- Mandatory pre-flight DNS resolution;
- Rejection of loopback, private, link-local, multicast, documentation addresses, and cloud metadata endpoints;
- Rejection of split-horizon DNS responses mixing public and private IP records;
- Enforced limit of at most 5 redirects;
- Hard caps on connection timeouts, `Content-Length`, and maximum streamed bytes;
- MIME types restricted to `text/html`, XHTML, and `text/plain`.

DNS validation precedes the low-level `fetch` call. Because the HTTP client runtime resolves DNS when
establishing TCP sockets, a malicious DNS operator could attempt a time-of-check-to-time-of-use (TOCTOU)
rebinding. For production deployments exposed to untrusted external users, this software-layer defense
should be reinforced with container egress firewall rules blocking private IP ranges and cloud metadata endpoints.

## Content Monitoring and Change Detection

`WebWatchService` conducts **point-in-time document inspections**. The task scheduler dictates
check intervals; the web search package contains zero timers and does not duplicate durable orchestration logic.

The service compares new document fetches against the latest snapshot using:

1. Exact cryptographic content hash;
2. Jaccard similarity across normalized character trigrams;
3. Configurable sensitivity thresholds.

It evaluates to `first_seen`, `unchanged`, or `changed`. The bundled JSON storage adapter writes files
atomically using permissions `0600` inside a `0700` directory, hashing watch keys for filenames.
Only content hashes, metadata, and comparison signatures are persisted — full page body text is not
stored. Multi-node clusters should implement this port via PostgreSQL with distributed advisory locks.

## Docker Deployment

Configure `SEARXNG_URL=http://searxng:8080` for containerized environments, or
`SEARXNG_URL=http://127.0.0.1:18080` when the API runs directly on the host machine.
Generate a random secret for `SEARXNG_SECRET`, then launch:

```bash
pnpm docker:research
pnpm docker:up
```

The `research` profile remains optional: without `SEARXNG_URL`, web search tools are simply not registered,
and all other NEXUS capabilities boot normally.

## Explicit Limitations

- The HTML text extractor is deterministic and lightweight; it does not render dynamic single-page
  applications and does not replace Browser Harness for JavaScript-heavy interfaces;
- PDF, Word, and PowerPoint processing is handled via dedicated document ingestion engines (Docling);
- Lexical citation coverage does not verify factual accuracy or evaluate paraphrases;
- Change detection flags differences, leaving relevance judgments to the mission orchestrator;
- The search package does not dispatch notifications or schedule autonomous cron jobs.

## Dependencies and Licensing

SearXNG runs as a separate decoupled service via its pinned official container image; its code is
neither bundled nor statically linked with NEXUS. SearXNG is licensed under AGPL-3.0-or-later.
Distributing container images or deploying modified network services requires compliance with upstream
licensing terms and providing access to corresponding source code: <https://github.com/searxng/searxng>.
