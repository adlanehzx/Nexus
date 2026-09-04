# Architecture Decision Records

Chaque ADR documente **une** décision structurante : son contexte, les alternatives écartées et
leurs raisons, et les conséquences acceptées. Un ADR n'est jamais réécrit — il est _superseded_
par un nouveau. C'est ce qui permet, dans six mois, de comprendre pourquoi un choix a été fait
plutôt que de le refaire à l'aveugle.

Format : Contexte · Décision · Alternatives · Conséquences · Statut.

| #                                    | Décision                                                   | Statut  |
| ------------------------------------ | ---------------------------------------------------------- | ------- |
| [001](ADR-001-monorepo.md)           | Monorepo pnpm + Turborepo                                  | Proposé |
| [002](ADR-002-fastify.md)            | Fastify comme framework HTTP                               | Proposé |
| [003](ADR-003-durable-agent-loop.md) | Boucle agentique durable, worker séparé de l'API           | Proposé |
| [004](ADR-004-llm-provider.md)       | Abstraction `LLMProvider`, aucun SDK hors adaptateur       | Proposé |
| [005](ADR-005-mcp-as-adapter.md)     | MCP comme source d'outils, pas comme cœur                  | Proposé |
| [006](ADR-006-browser-worker.md)     | Browser Use en service Python isolé                        | Proposé |
| [007](ADR-007-device-agent-node.md)  | Device Agent en Node headless, pas en Rust                 | Proposé |
| [008](ADR-008-desktop-tauri.md)      | Desktop en Tauri v2 plutôt qu'Electron                     | Proposé |
| [009](ADR-009-ws-protocol.md)        | WebSocket unique, typé, reprenable par `seq`               | Proposé |
| [010](ADR-010-permissions.md)        | Deny par défaut, risque calculé, confirmation liée au hash | Proposé |
| [011](ADR-011-memory-pgvector.md)    | pgvector plutôt qu'une base vectorielle dédiée             | Proposé |
| [012](ADR-012-voice-decoupled.md)    | Voix découplée de l'agent                                  | Proposé |
| [013](ADR-013-secrets.md)            | Chiffrement enveloppe + port `SecretStore`                 | Proposé |
| [014](ADR-014-contracts-first.md)    | Contrats Zod comme source de vérité unique                 | Proposé |
| [015](ADR-015-deployment-compose.md) | Docker Compose sur VPS, pas de Kubernetes                  | Proposé |
