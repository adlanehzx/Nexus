# ADR-006 — Browser Use en service Python isolé

**Statut** : Proposé · 2026-09-01

## Contexte

`browser-use` est une bibliothèque Python. Le backend est TypeScript. Le cahier des charges
interdit explicitement que le backend importe le code Python, et impose l'isolation du worker.
S'y ajoutent deux réalités : un Chromium consomme de la mémoire et plante, et il visite par
définition du contenu hostile.

## Décision

`apps/browser-worker` : service FastAPI, conteneur dédié, exposant une API HTTP versionnée
(sessions, act, cancel, health) et publiant sa progression sur un Redis Stream. Le TypeScript ne
le connaît qu'à travers `@nexus/browser-client`, un client typé. Réseau Docker isolé, sans port
publié, egress filtré, aucun secret applicatif dans le conteneur.

Deux niveaux d'outils exposés à l'agent : `browser.act` (haut niveau, boucle `browser-use`,
coûteux, `CONFIRM` dès que mutant) et `browser.navigate/extract/click/type` (bas niveau,
déterministe, bon marché).

## Alternatives

- **Playwright directement en TypeScript.** Supprime Python et le saut réseau — mais on
  réimplémenterait l'intelligence de `browser-use` (perception de la page, résolution d'éléments,
  boucle d'action), qui est précisément la valeur de la bibliothèque. Reste une option de repli si
  `browser-use` s'avère instable ; l'interface `browser.*` ne changerait pas.
- **Pont in-process (`python-shell`, PyO3).** Viole la contrainte, couple les cycles de vie, et un
  crash Chromium ferait tomber le worker agent.
- **Service de navigation SaaS (Browserbase, Steel).** Moins d'exploitation, mais dépendance
  externe, coût récurrent et données de navigation chez un tiers. Envisageable plus tard derrière
  la même interface.

## Conséquences

**Positives** — isolation des pannes et de la sécurité ; scaling indépendant ; possibilité de
remplacer l'implémentation sans toucher à l'agent ; capture d'écran par étape, qui est à la fois
une fonctionnalité et l'outil de débogage principal.

**Négatives, acceptées** — deux écosystèmes à maintenir et à builder (mitigé par des tests de
contrat, cf. [15-testing](../architecture/15-testing.md) §4) ; latence réseau supplémentaire
(négligeable devant les secondes d'une action navigateur) ; image Docker lourde (~1,5 Go avec
Playwright).
