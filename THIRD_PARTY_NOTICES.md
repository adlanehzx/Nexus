# Dépendances et services tiers

Le code propre à NEXUS est distribué sous `AGPL-3.0-or-later`. Chaque dépendance conserve sa
propre licence ; `pnpm licenses list --prod` produit l'inventaire exact de l'arbre JavaScript de la
version installée et les fichiers `uv.lock` figent les arbres Python.

## Dépendances distribuées

L'arbre JavaScript contient principalement des composants MIT, Apache-2.0, ISC et BSD, ainsi que
des composants MPL-2.0, EPL-2.0, LGPL-3.0-or-later et des licences doubles. Ces licences ne sont
pas remplacées par la licence NEXUS. Les images et paquets publiés incluent un SBOM SPDX pour
identifier chaque composant et sa version.

## Services optionnels séparés

Browser Use, SearXNG, Grafana, Loki, Tempo, Prometheus, PostgreSQL/pgvector et les serveurs MCP
sont lancés comme processus ou conteneurs distincts. Ils ne deviennent pas du code NEXUS et
restent soumis à leurs licences respectives, y compris lorsqu'une licence copyleft ou AGPL
s'applique au service. Leur activation est optionnelle via les profils Docker ou la configuration.

Les CLI ACP (Codex, Claude Code, Antigravity et leurs adaptateurs) ne sont ni redistribuées ni
vendues par ce dépôt. L'utilisateur les installe et s'authentifie auprès de leur fournisseur selon
leurs propres conditions. NEXUS ne transforme pas un abonnement en droit de redistribution.

Avant une release, l'inventaire doit être revu et toute licence inconnue ou non commerciale doit
bloquer la publication.
