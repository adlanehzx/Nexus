# Agent Runtime — BullMQ

> **Not implemented — planned for Phase 2.** This folder reserves its spot in the project structure;
> it contains no mock implementations.

## Purpose

Executes `AgentRun` workflows: observe → reason → plan → act → observe loop, token/execution budgets,
cancellation, resumption after human confirmation, context compaction.

## Note

Separated from the API service because an agent run typically takes 5 to 120 seconds: mixing runs into
the HTTP service would make every deployment destructive and obscure API p99 latency metrics (ADR-003).

## Reference

Architecture: [`docs/architecture/03-agent.md`](../../docs/architecture/03-agent.md)
Roadmap: [`docs/ROADMAP.md`](../../docs/ROADMAP.md)

