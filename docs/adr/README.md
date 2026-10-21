# Architecture Decision Records

Each ADR documents **one** architectural decision: its context, the considered alternatives and
the reasons they were set aside, and the accepted consequences. An ADR is never rewritten — it is
_superseded_ by a new one. This ensures that six months down the line, the team understands why a
choice was made rather than second-guessing it blindly.

Format: Context · Decision · Alternatives · Consequences · Status.

| #                                    | Decision                                                   | Status   |
| ------------------------------------ | ---------------------------------------------------------- | -------- |
| [001](ADR-001-monorepo.md)           | Monorepo pnpm + Turborepo                                  | Proposed |
| [002](ADR-002-fastify.md)            | Fastify as HTTP framework                                  | Proposed |
| [003](ADR-003-durable-agent-loop.md) | Durable agent loop, worker separated from API              | Proposed |
| [004](ADR-004-llm-provider.md)       | `LLMProvider` abstraction, no SDK outside adapters         | Proposed |
| [005](ADR-005-mcp-as-adapter.md)     | MCP as a tool source, not architectural core               | Proposed |
| [006](ADR-006-browser-worker.md)     | Browser Use in an isolated Python service                  | Proposed |
| [007](ADR-007-device-agent-node.md)  | Device Agent in headless Node, not Rust                    | Proposed |
| [008](ADR-008-desktop-tauri.md)      | Desktop in Tauri v2 rather than Electron                   | Proposed |
| [009](ADR-009-ws-protocol.md)        | Single typed WebSocket, resumable by `seq`                 | Proposed |
| [010](ADR-010-permissions.md)        | Deny by default, evaluated risk, hash-bound confirmation   | Proposed |
| [011](ADR-011-memory-pgvector.md)    | pgvector rather than a dedicated vector database           | Proposed |
| [012](ADR-012-voice-decoupled.md)    | Voice decoupled from the agent                             | Proposed |
| [013](ADR-013-secrets.md)            | Envelope encryption + `SecretStore` port                   | Proposed |
| [014](ADR-014-contracts-first.md)    | Zod contracts as single source of truth                    | Proposed |
| [015](ADR-015-deployment-compose.md) | Docker Compose on VPS, no Kubernetes                       | Proposed |
