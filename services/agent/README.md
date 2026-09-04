# Agent Runtime — BullMQ

> **Non implémenté — prévu en phase 2.** Ce dossier réserve sa place dans la structure ;
> il ne contient aucune implémentation fictive.

## Rôle

Exécute les `AgentRun` : boucle observe → reason → plan → act → observe, budgets,
annulation, reprise après confirmation, compaction du contexte.

## Note

Séparé de l'API parce qu'un run dure de 5 à 120 secondes : le mélanger au service HTTP
rendrait chaque déploiement destructeur et le p99 de l'API illisible (ADR-003).

## Référence

Architecture : [`docs/architecture/03-agent.md`](../../docs/architecture/03-agent.md)
Roadmap : [`docs/ROADMAP.md`](../../docs/ROADMAP.md)
