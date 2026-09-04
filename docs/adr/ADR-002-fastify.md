# ADR-002 — Fastify comme framework HTTP

**Statut** : Proposé · 2026-09-01

## Contexte

L'API doit servir du REST versionné, des WebSockets, des uploads audio, et générer une
documentation OpenAPI fiable. Elle doit rester une **frontière mince** : validation, auth,
orchestration — la logique métier vit dans les services et les packages.

## Décision

Fastify 5 avec `fastify-type-provider-zod`, `@fastify/websocket`, `@fastify/swagger`,
`@fastify/rate-limit`, `@fastify/helmet`.

## Alternatives

- **NestJS.** Structure fournie, DI intégrée, écosystème riche. Écarté : le poids des décorateurs
  et des modules dépasse le besoin, et son opinion sur la DI entrerait en concurrence avec
  l'injection explicite déjà retenue pour `agent-core`. Le principe « SOLID sans overengineering »
  du cahier des charges tranche ici.
- **Express.** Écosystème le plus large, mais pas de validation de schéma native, typage faible,
  performances moindres, et son modèle de middleware rend l'encapsulation plus difficile.
- **Hono / Elysia.** Excellents et modernes, mais écosystème plus jeune ; on préfère la maturité
  sur la brique la plus exposée.

## Conséquences

**Positives** — un schéma Zod par route sert simultanément à valider, typer et documenter :
la doc OpenAPI ne peut pas mentir. Les plugins encapsulés donnent une isolation naturelle par
domaine. Performances confortables pour du streaming.

**Négatives, acceptées** — aucune structure imposée : la discipline des couches
(routes → services → repositories) doit être tenue par revue et par lint, pas par le framework.
Moins de tutoriels que pour Express ou Nest.
