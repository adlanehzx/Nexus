# ADR-001 — Monorepo pnpm + Turborepo

**Statut** : Proposé · 2026-09-01

## Contexte

Sept applications (api, worker, mobile, desktop, web, device-agent, browser-worker) partagent des
types, un protocole WebSocket, des schémas d'outils et des codes d'erreur. Ces contrats changent
souvent au début du projet. Le risque principal est la **dérive** : le mobile parlant une version
du protocole que le serveur ne parle plus.

## Décision

Un monorepo pnpm workspaces + Turborepo, avec `@nexus/contracts` comme package pivot et des règles
de dépendance vérifiées en CI. `apps/browser-worker` (Python) vit dans le même dépôt mais garde sa
chaîne d'outils propre (`uv`, `pytest`), branchée sur le graphe Turborepo comme tâche opaque.

## Alternatives

- **Polyrepo + packages npm publiés.** Chaque changement de contrat demande publication, bump et
  synchronisation sur 5 dépôts. Rédhibitoire à ce stade du projet.
- **Nx.** Plus riche (générateurs, graphe, plugins) mais plus prescriptif et plus lourd à
  apprendre ; Turborepo suffit pour un cache de tâches et un graphe de dépendances.
- **npm/yarn workspaces.** pnpm est retenu pour son store lié en dur (installation rapide, disque
  économisé) et son isolation stricte des dépendances, qui empêche les dépendances fantômes —
  précieux quand 7 apps cohabitent.

## Conséquences

**Positives** — un changement de contrat casse la compilation de tous les consommateurs
immédiatement ; refactoring atomique ; une seule CI ; onboarding simple.

**Négatives, acceptées** — CI plus longue sans cache correct (mitigation : cache distant
Turborepo) ; Expo/Metro demande une configuration spécifique pour résoudre les packages du
workspace (`disableHierarchicalLookup`, `watchFolders`) ; le dépôt grossit ; la discipline des
règles de dépendance doit être automatisée, sinon elle sera violée.
