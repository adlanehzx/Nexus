# ADR-014 — Les contrats Zod sont la source de vérité unique

**Statut** : Proposé · 2026-09-01

## Contexte

Cinq consommateurs (mobile, desktop, web, device-agent, browser-worker) dépendent des mêmes
formes de données : DTO d'API, événements WebSocket, schémas d'outils, codes d'erreur. Chacune
peut être décrite au mauvais endroit — types TypeScript d'un côté, validation de l'autre, doc
OpenAPI écrite à la main — avec la garantie qu'elles divergeront.

## Décision

`@nexus/contracts` définit **une fois** chaque forme, en Zod, et tout le reste en dérive :

```
Zod schema
 ├── type TypeScript          z.infer
 ├── validation runtime       .parse() aux frontières, dans les deux sens
 ├── documentation OpenAPI    @fastify/swagger via fastify-type-provider-zod
 ├── JSON Schema              zod-to-json-schema → outils LLM, contrat Python
 └── modèles Pydantic         générés pour apps/browser-worker, vérifiés par test de contrat
```

Règles : aucune interface dupliquée à la main ; toute enveloppe réseau porte un champ de version ;
la validation s'applique **aussi en réception côté client** (un serveur peut être en avance sur
l'app mobile du store).

## Alternatives

- **Types TypeScript seuls.** Effacés à l'exécution : aucune protection contre une réponse
  malformée, un vieux client ou un serveur MCP hostile.
- **OpenAPI comme source, types générés.** Fonctionne pour le REST, mais couvre mal le protocole
  WebSocket et les schémas d'outils dynamiques, et l'outillage de génération ajoute une étape de
  build fragile.
- **tRPC.** Excellent en TypeScript de bout en bout, mais notre API doit être consommée par du
  Python et rester conventionnellement REST/versionnée pour d'éventuels clients tiers.
- **Protobuf.** Typage fort et multilingue, mais outillage lourd et mauvaise ergonomie côté
  React Native pour un gain limité ici.

## Conséquences

**Positives** — un changement de contrat casse la compilation de tous les consommateurs
immédiatement, au lieu de casser la production silencieusement ; la doc OpenAPI ne peut pas mentir ;
la frontière Python est couverte par un test automatique.

**Négatives, acceptées** — Zod ajoute un coût runtime (négligeable devant un appel LLM, mesuré sur
les chemins chauds comme le fanout WebSocket où l'on valide en développement et échantillonne en
production) ; les schémas récursifs demandent des annotations explicites ; il faut une discipline
de versionnement (`v` dans l'enveloppe, règles d'évolution additive uniquement).
