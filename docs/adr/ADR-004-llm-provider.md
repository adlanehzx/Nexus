# ADR-004 — `LLMProvider` Abstraction

**Status**: Proposed · 2026-09-01

## Context

The LLM landscape changes quarterly: pricing, capabilities, tool-calling formats, availability.
The architectural requirements dictate that providers be interchangeable and that "the rest of the
application never directly depends on an LLM SDK".

## Decision

A single port in `@nexus/llm`:

```ts
interface LLMProvider {
  readonly id: string;
  readonly capabilities: { tools: boolean; vision: boolean; json: boolean; maxContext: number };
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>; // text | tool_call | usage | done
  structuredOutput<T>(req, schema: ZodType<T>): Promise<T>;
  countTokens(input: TokenCountInput): Promise<number>;
}
```

Vendor SDKs are imported **only** in `packages/llm/src/adapters/*`. A lint rule prohibits
`@anthropic-ai/*`, `openai`, etc. elsewhere in the repository. Messages and tool calls flow in a
neutral format (`@nexus/contracts`); each adapter translates bidirectionally.

An `LLMRouter` layered above selects the model per task (planning, direct response, compaction
summaries, classification), enforcing cascade fallbacks and budgets.

## Alternatives

- **Vercel AI SDK / LangChain.** Pre-existing abstraction — but we would inherit their data models
  and breaking changes; LangChain additionally imposes an agent design philosophy we do not want
  (our loop is explicit and persisted, cf. ADR-003). A clean 4-method interface we own is smaller
  than the surface area of external SDK APIs we avoid.
- **Direct vendor SDK calls.** Quick to start, costly at the first provider change, and violates the
  explicit requirement of the specifications.

## Consequences

**Positive** — Changing a model is a one-line configuration update; multi-provider fallbacks operate
seamlessly during outages; a scripted `FakeLLM` allows testing `agent-core` without network access;
token counting and cost tracking are centralized.

**Negative, accepted** — The abstraction represents the lowest common denominator: provider-specific
innovations (prompt caching, server-side tool execution, thinking mode) require extending
`capabilities` rather than being consumed immediately. This is an accepted cost, mitigated by typed
`providerOptions` per adapter that `agent-core` never inspects.
