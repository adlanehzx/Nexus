# ADR-015 — Docker Compose sur un VPS, pas de Kubernetes

**Statut** : Proposé · 2026-09-01

## Contexte

Le système compte une dizaine de services (api, worker, browser-worker, mcp-runner, postgres,
redis, minio, caddy, observabilité). Il sert **un utilisateur**, éventuellement quelques-uns.
Le cahier des charges demande une architecture « facilement déployable sur VPS ».

## Décision

Docker Compose sur un VPS unique (4 vCPU / 8–16 Go), Caddy en frontal pour le TLS automatique,
réseaux Docker séparés (`edge` exposé, `internal` sans route entrante), migrations en job
one-shot avant démarrage des applications, sauvegardes chiffrées hors VPS avec restauration
testée mensuellement.

## Alternatives

- **Kubernetes (k3s ou managé).** Autoscaling, rolling updates, self-healing, secrets natifs.
  Écarté : pour un service mono-utilisateur, l'orchestrateur consommerait plus de temps
  d'exploitation et de ressources que l'application. C'est le cas d'école de la complexité qui ne
  paie pas son coût.
- **PaaS (Railway, Fly.io, Render).** Zéro exploitation, déploiement simple — mais coût supérieur à
  cette taille, contraintes sur les processus longs et les conteneurs lourds (Playwright),
  et dépendance à un fournisseur. Reste une option pour un environnement de staging.
- **Serverless.** Incompatible avec des runs agent de plusieurs minutes, des WebSockets persistants
  et un pool de navigateurs préchauffés.

## Conséquences

**Positives** — coût prévisible (25–50 €/mois) ; un `docker compose up` reproduit la production en
local ; aucune dépendance cloud ; surface d'attaque et de compréhension réduite.

**Négatives, acceptées** — **point unique de défaillance** : si le VPS tombe, tout tombe. Accepté
pour un assistant personnel, avec sauvegardes hors site et une procédure de restauration testée.
Pas d'autoscaling (la concurrence des workers est un réglage manuel). Le déploiement est un script
SSH, pas un système déclaratif : il doit être idempotent et versionné.

## Chemin de sortie

L'architecture reste « K8s-ready » : services sans état, configuration par environnement,
healthchecks, migrations découplées, communication par contrats réseau. Migrer consisterait à
écrire des manifestes, pas à réécrire du code. Ordre de scalabilité si le besoin apparaît :
PostgreSQL managé → Redis managé → browser-worker sur un hôte dédié → workers autoscalés →
orchestrateur.
