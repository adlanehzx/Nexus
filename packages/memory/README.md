# @nexus/memory

Persistent memory defaults to an on-device local multilingual ONNX model
(`paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions) with pgvector/HNSW indexes.
Zero text is transmitted to external cloud services and zero API keys are required.

Upon initial invocation, the model is downloaded to the directory configured by
`MEMORY_EMBEDDING_CACHE_DIR`. Following this initial download, configuring
`MEMORY_EMBEDDING_LOCAL_ONLY=true` guarantees strictly offline operation. The deterministic
hash backend remains available via `MEMORY_EMBEDDING_BACKEND=hash` for resource-constrained
environments; its vectors are not written to the 384D pgvector column.

Six distinct mechanisms are often referred to as "memory". Conflating them is the most common
architectural mistake in agent design, which this package is designed to prevent:

| #   | Layer                      | Owner                                        | Eviction Policy                    |
| --- | -------------------------- | -------------------------------------------- | ---------------------------------- |
| 1   | Conversation History       | `ConversationStore` (API)                    | Indefinite — user archived         |
| 2   | Short-Term Working Context | `ShortTermContext` **here**                  | On TTL expiration or session close |
| 3   | Long-Term Memory           | `MemoryProvider` **here**                    | Upon explicit user deletion        |
| 4   | User Preferences           | `MemoryProvider` **here**, `PREFERENCE` tier | When modified or superseded        |
| 5   | Device Fleet Metadata      | `DeviceRegistry` (`@nexus/devices`)          | Upon device revocation             |
| 6   | Task Execution History     | `TaskStore` (`@nexus/devices`)               | Upon scheduled purge               |

**Only layers 2, 3, and 4 reside in this package.** The other three maintain explicit owners elsewhere
in the architecture. Duplicating them would create split-brain state that drifts over time.
`sources.ts` declares them as **read-only ports** that the API wires to genuine repositories.

Practical benefit: Context assembly is tested without a live database, device registry, or task coordinator.

---

## The Rule of Silence

> **Nothing sensitive is remembered without explicit awareness.**

Three deterministic classifications:

| Verdict     | Scope                                                                      | System Behavior                                        |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `FORBIDDEN` | Passwords, API tokens, session keys, recovery seed phrases, payment cards  | **Always rejected**                                    |
| `PERSONAL`  | Health, financial balances, legal identity, home address, personal beliefs | Stored **only if** caller sets `acknowledgedSensitive` |
| `ORDINARY`  | General user facts, technical preferences, working notes                   | Stored normally                                        |

`FORBIDDEN` has **zero user override exemptions**. NEXUS is not a password manager: it does not
provide hardware-backed encryption at rest, automatic rotation, or zero-knowledge revocation.
Accepting credential payloads would create a pseudo-vault unprotected by proper vault guarantees.

Classification is **strictly deterministic**, never delegated to probabilistic models. A neural
classifier with a 99% accuracy rate leaks a password 1% of the time. The engine reuses `redactText`
from `@nexus/shared` — improvements to log redaction immediately protect memory ingestion.

`acknowledgedSensitive` contains **zero default-to-true flags** anywhere in the repository.

---

## Service Layer Architecture

```
Route / Agent Core  ──▶  MemoryService  ──▶  MemoryProvider
                          (Policy Layer)      (Storage Store)
```

`MemoryProvider` persists whatever it receives — that is its role. `MemoryService` enforces whether it
should be persisted. Bypassing the service layer would undermine the rule of silence;
`services/api/test/memory.test.ts` validates this guarantee end-to-end.

### The Five Core Methods

| Method      | Semantics                                                                            |
| ----------- | ------------------------------------------------------------------------------------ |
| `search`    | Empty query = browse chronological entries from newest to oldest                     |
| `store`     | Enforces sensitivity policy prior to persisting new items                            |
| `update`    | Modifying **content** supersedes the record; modifying **metadata** updates in place |
| `delete`    | Removes entry and associated vector index                                            |
| `summarize` | Extractive summary, non-generative: this port does not depend on LLMs                |

All methods require `userId`, including those accepting a record ID. This redundancy is deliberate:
guessable UUIDs must never allow reading or deleting another tenant's memories.

### Superseding vs. Destructive Overwriting

Updating "Lives in Lyon" to "Lives in Paris" does not overwrite the record: it creates a new entry and
timestamps the prior one. "Where did I live last year?" is a natural query that destructive overwrites
render impossible to answer.

---

## Explicit Commands

"Remember that…" and "Forget…" do **not** route through probabilistic LLM parsing.

A user stating "forget my address" expects that address deleted immediately, not hoping an LLM interpreted
the prompt correctly. Deterministic regex parsing may occasionally miss creative phrasing — which the
user rephrases — whereas neural parsing can fail silently.

Recognition is **anchored to the beginning of the message** and demands an imperative syntax.
Statements like "I remember the train was late" do not trigger memory mutation.

Three safeguards on forget operations:

- By **ID**: Unambiguous targeted removal;
- By **Text**: Deletes only if match confidence significantly exceeds the nearest candidate; otherwise
  returns candidate records for interactive selection;
- **Clear All**: Demands explicit confirmation. A forgotten fact can be re-stated; an entire wiped
  memory store cannot be reconstructed.

---

## Hybrid Retrieval and Provenance

Every memory record carries a normalized content hash, an embedding vector, the embedding model name,
and source tracking metadata (runId, conversationId, messageId). Raw source message bodies are not
duplicated into provenance fields.

`EmbeddingProvider` serves as the extension port. The `LocalHashEmbeddingProvider` fallback is local,
deterministic, and requires zero downloads. It hashes word tokens and character bigrams to compute
hybrid lexical-vector scores. FastEmbed or pgvector can replace it without modifying `MemoryService`
or `ContextAssembler`.

The PostgreSQL schema stores dense vectors in a `DOUBLE PRECISION[]` column when operating without pgvector,
allowing standard `postgres:17-alpine` images to run without compilation errors. An HNSW pgvector index
acts as a drop-in production optimization; the application contract remains decoupled from storage engines.

`ControlledMemoryExtractor` never persists inferred facts automatically: it generates candidate entries
marked `requiresReview`, filters sensitive content, and invokes `storeApproved` only for approved items.
`MemoryConsolidator` follows the same principle: read-only consolidation plans applied to approved groups.
Automated consolidation of paraphrases remains prohibited to prevent merging subtle contradictions.

## Context Window Assembly

`ContextAssembler` aggregates the six layers, **each within dedicated token allocations**.

A single shared token budget degrades unpredictably: a lengthy conversation history exhausts the window,
pushing out user preferences that arrived at the end. Explicit section allocations guarantee that a long
dialogue does not cause NEXUS to forget core user preferences.

Two bounds are evaluated: character length and token counts. `TokenCounter` allows adapters to inject
exact model tokenizers; `ConservativeTokenCounter` acts as a local fallback estimator.
`ContextWindowPlanner` reserves output tokens and safety headroom per model specification.

`ContextCompactor` relocates large outputs into `ContextArtifactStore` **before** summarizing them.
The prompt receives the summary and artifact reference ID; original bodies remain retrievable under
strict `userId` boundaries.

Two critical implementation details:

- **Preferences** are queried using an empty query string — invariant behavioral rules have no reason
  to lexically match the active user message;
- **Provenance** accompanies every retrieved fact. "User explicitly stated" vs. "Inferred from discussion"
  carry different authority, allowing the reasoning model to weigh confidence appropriately.

---

## Test Suites

106 unit tests without database or network dependencies, plus 5 PostgreSQL integration tests enabled
when `DATABASE_URL` is configured.

| Test File                  | Coverage Focus                                                            |
| -------------------------- | ------------------------------------------------------------------------- |
| `test/provider.test.ts`    | Store, search, update, delete, supersession, multi-user isolation         |
| `test/sensitivity.test.ts` | The three sensitivity tiers, explicit commands, false positive rejection  |
| `test/service.test.ts`     | Policy enforcement: denials, consents, forget handling, audit logging     |
| `test/context.test.ts`     | Layer separation, token budgets, short-term context handling              |
| `test/semantic.test.ts`    | Local hybrid scoring, provenance, extraction, tokens, artifact management |

Additionally, `services/api/test/memory.test.ts` validates that the service layer cannot be bypassed.
