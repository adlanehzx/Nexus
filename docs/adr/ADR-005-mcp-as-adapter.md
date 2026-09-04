# ADR-005 — MCP comme source d'outils, pas comme cœur de l'architecture

**Statut** : Proposé · 2026-09-01

## Contexte

MCP standardise l'exposition d'outils à un modèle et donne accès à un écosystème de serveurs
existants (GitHub, filesystem, bases de données…). La tentation est d'en faire le modèle
d'intégration unique : « tout est MCP ». Le cahier des charges demande, lui, de pouvoir
« connecter plusieurs MCP servers sans modifier l'agent core ».

## Décision

MCP est **un adaptateur de `ToolSource` parmi cinq** (builtin, MCP, browser, device, HTTP).
`McpManager` connecte les serveurs (stdio ou HTTP/SSE), découvre leurs outils et les traduit en
`ToolDefinition` internes : JSON Schema → Zod, erreurs MCP → `ToolError`, nom → `mcp.{slug}.{tool}`.

Trois règles de gouvernance :

1. Un outil MCP découvert arrive en **`CONFIRM`** par défaut ; l'abaisser est une décision humaine
   persistée, jamais déduite de la description fournie par le serveur.
2. La description d'un serveur tiers est une **entrée non fiable** (injection de prompt possible) :
   tronquée, échappée, incapable de modifier le prompt système.
3. Les serveurs stdio tournent dans un conteneur dédié, sans réseau par défaut, avec un
   environnement minimal — aucune variable d'env du backend n'est héritée.

## Alternatives

- **Tout exposer via MCP, y compris nos outils natifs.** Uniformité séduisante, mais on paierait
  une sérialisation et un saut de processus pour des appels internes, on perdrait le typage Zod
  de bout en bout, et l'architecture serait couplée à l'évolution d'un protocole tiers.
- **Ignorer MCP, tout écrire à la main.** On perd l'écosystème et l'extensibilité que l'utilisateur
  demande explicitement.

## Conséquences

**Positives** — ajouter un serveur MCP depuis l'app ne touche ni `agent-core` ni le code : c'est
une ligne en base. Les outils MCP héritent gratuitement des permissions, confirmations, timeouts,
audit et circuit breakers. Si MCP change, un seul package bouge.

**Négatives, acceptées** — coût de traduction JSON Schema → Zod (cas limites : `oneOf`, schémas
récursifs — on refuse alors l'outil avec un message clair plutôt que de deviner). Un serveur MCP
lent ou instable dégrade l'expérience : mitigé par le circuit breaker et le retrait automatique
de ses outils du registre.
