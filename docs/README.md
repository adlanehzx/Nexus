# NEXUS — Architecture documentation

A multi-device personal AI assistant (iPhone, PC, web) able to act for real, through a tool system
governed by permissions.

> **Status: active alpha implementation.** These documents describe the target architecture; the
> service READMEs and the CI jobs listed in the root [README](../README.md#7-testing-and-proof)
> say what is actually delivered.

## Contents

### Architecture — foundations

| #   | Document                                                          | Contents                                               |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| 00  | [Overview](architecture/00-overview.md)                           | Context, constraints, system view, end-to-end flow     |
| 01  | [Monorepo & packages](architecture/01-monorepo-packages.md)       | pnpm/Turborepo layout, dependency rules                |
| 02  | [Backend](architecture/02-backend.md)                             | Fastify API, worker, Redis, layering                   |
| 03  | [Agent](architecture/03-agent.md)                                 | Durable agent loop, planner, budgets, resumption       |
| 04  | [Tools & MCP](architecture/04-tools-mcp.md)                       | ToolRegistry, Executor, adapters, MCP                  |
| 05  | [Browser Use](architecture/05-browser-use.md)                     | Isolated Python worker, protocol, sandbox              |
| 06  | [Devices](architecture/06-devices.md)                             | Device agent, auth, heartbeat, tasks, local policy     |
| 07  | [Data model](architecture/07-data-model.md)                       | Entities, relations, indexes, retention                |
| 08  | [WebSocket protocol](architecture/08-websocket-protocol.md)       | Envelopes, events, resumption, backpressure            |
| 09  | [Security & permissions](architecture/09-security-permissions.md) | AuthN/Z, risk levels, confirmations, pause, secrets    |
| 10  | [Memory](architecture/10-memory.md)                               | Five layers, compaction, pgvector, forgetting          |
| 11  | [Voice](architecture/11-voice.md)                                 | Decoupled STT/TTS, barge-in, local whisper.cpp & Piper |
| 12  | [Clients](architecture/12-clients.md)                             | Expo mobile, Tauri desktop, web, offline mode          |
| 13  | [Observability](architecture/13-observability.md)                 | Logs, traces, metrics, cost, audit                     |
| 14  | [Deployment](architecture/14-deployment.md)                       | Docker Compose, VPS, migrations, backups               |
| 15  | [Testing strategy](architecture/15-testing.md)                    | Pyramid, fakes, contracts, security evals              |

### Architecture — as implemented

These describe what exists, with the gaps named rather than hidden.

| #   | Document                                                                               |
| --- | -------------------------------------------------------------------------------------- |
| 16  | [Agent Core](architecture/16-agent-core.md)                                            |
| 17  | [MCP system](architecture/17-mcp.md)                                                   |
| 18  | [Browser Use](architecture/18-browser-use.md)                                          |
| 19  | [Multi-device architecture](architecture/19-multi-devices.md)                          |
| 20  | [Windows worker](architecture/20-windows-worker.md)                                    |
| 21  | [Android worker](architecture/21-android-worker.md)                                    |
| 22  | [API and realtime](architecture/22-api-realtime.md)                                    |
| 23  | [NEXUS Mission Engine](architecture/23-nexus-mission-engine.md)                        |
| 24  | [Web search](architecture/24-web-search.md)                                            |
| 25  | [Operating an instance](architecture/25-exploitation.md)                               |
| 26  | [Provider multi-accounts](architecture/26-provider-multi-accounts.md)                  |
| 27  | [Intelligent agent routing](architecture/27-intelligent-agent-routing.md)              |
| 28  | [Enhanced inter-agent collaboration](architecture/28-enhanced-agent-collaboration.md)  |
| 29  | [MCP container isolation and SBOM](architecture/29-mcp-container-isolation-sbom.md)    |
| 30  | [Google Workspace integration](architecture/30-google-workspace-integration.md)        |
| 32  | [Official LinkedIn integration](architecture/32-linkedin-official-integration.md)      |
| 31  | [Advanced document processing](architecture/31-advanced-document-processing-memory.md) |
| 32  | [Local Activepieces automation](architecture/32-activepieces-local-saas-bridge.md)     |
| 33  | [Unified external notifications](architecture/33-external-notifications.md)            |

### Decisions

- [ADR index](adr/README.md) — 15 structural decisions

### Operations

- [Packaging, signing and release](operations/packaging.md)
- [Testing on physical devices](operations/physical-devices.md)
- [Tailscale network](network/TAILSCALE.md)

### Planning

- [Roadmap by phase](ROADMAP.md)
- [Technical risks](RISKS.md)
- [Implementation rush coordination](rush/README.md)

## The guiding principle

> **The model can do nothing except emit text and ask for a tool to run.**
> Every real capability goes through the `ToolRegistry`, is filtered by the `PermissionService`,
> executed by the `ToolExecutor` and traced in `ToolExecution`. There is no alternative path
> between a model and the outside world.
