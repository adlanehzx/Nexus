# NEXUS — Documentation d'architecture

Assistant personnel IA multi-appareils (iPhone, PC, web) capable d'agir réellement
via un système d'outils gouverné par des permissions.

> **Statut : PROPOSITION — en attente de validation. Aucun code applicatif écrit.**

## Table des matières

### Architecture

| #   | Document                                                          | Contenu                                                  |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| 00  | [Vue d'ensemble](architecture/00-overview.md)                     | Contexte, contraintes, vue système, flux de bout en bout |
| 01  | [Monorepo & packages](architecture/01-monorepo-packages.md)       | Découpage pnpm/Turborepo, règles de dépendance           |
| 02  | [Backend](architecture/02-backend.md)                             | API Fastify, worker, Redis, découpage en couches         |
| 03  | [Agent](architecture/03-agent.md)                                 | Boucle agentique durable, planner, budgets, reprise      |
| 04  | [Outils & MCP](architecture/04-tools-mcp.md)                      | ToolRegistry, Executor, adaptateurs, MCP                 |
| 05  | [Browser Use](architecture/05-browser-use.md)                     | Worker Python isolé, protocole, sandbox                  |
| 06  | [Devices](architecture/06-devices.md)                             | Device Agent, auth, heartbeat, tâches, annulation        |
| 07  | [Modèle de données](architecture/07-data-model.md)                | Entités, relations, index, rétention                     |
| 08  | [Protocole WebSocket](architecture/08-websocket-protocol.md)      | Enveloppes, événements, reprise, backpressure            |
| 09  | [Sécurité & permissions](architecture/09-security-permissions.md) | AuthN/Z, risk levels, confirmations, secrets             |
| 10  | [Mémoire](architecture/10-memory.md)                              | 5 couches, compaction, pgvector, oubli                   |
| 11  | [Voix](architecture/11-voice.md)                                  | STT/TTS découplés, barge-in, streaming                   |
| 12  | [Clients](architecture/12-clients.md)                             | Mobile Expo, desktop Tauri, web                          |
| 13  | [Observabilité](architecture/13-observability.md)                 | Logs, traces, métriques, coûts, audit                    |
| 14  | [Déploiement](architecture/14-deployment.md)                      | Docker Compose, VPS, migrations, backups                 |
| 15  | [Stratégie de test](architecture/15-testing.md)                   | Pyramide, fakes, contrats, évals agent                   |

### Décisions

- [Index des ADR](adr/README.md) — 15 décisions structurantes

### Pilotage

- [Roadmap par phases](ROADMAP.md)
- [Risques techniques](RISKS.md)

## Principe directeur

> **Le LLM ne peut rien faire d'autre qu'émettre du texte et demander l'exécution d'un outil.**
> Toute capacité réelle passe par le `ToolRegistry`, filtrée par le `PermissionService`,
> exécutée par le `ToolExecutor`, tracée dans `ToolExecution`. Il n'existe aucun chemin
> alternatif entre un modèle et le monde extérieur.
