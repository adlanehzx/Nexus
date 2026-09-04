# 14 — Déploiement

## 1. Cible

Un VPS unique (4 vCPU / 8–16 Go / 100 Go SSD ≈ 25–50 €/mois) faisant tourner l'ensemble en
Docker Compose. Pas de Kubernetes : pour un système mono-utilisateur, l'orchestrateur coûterait
plus de temps d'exploitation que le service lui-même
(→ [ADR-015](../adr/ADR-015-deployment-compose.md)). L'architecture reste néanmoins
« K8s-ready » : services sans état, config par env, healthchecks, migrations découplées.

## 2. Topologie

```mermaid
flowchart TB
  subgraph VPS
    CADDY[Caddy · TLS auto · HTTP/3]
    subgraph net_public["réseau: edge"]
      API1[api ×2]
    end
    subgraph net_internal["réseau: internal (pas d'accès Internet entrant)"]
      WK[worker ×N]
      BW[browser-worker]
      MCP[mcp-runner]
      PG[(postgres 16 + pgvector)]
      RD[(redis 7)]
      MINIO[(minio)]
    end
    OBS[grafana · loki · tempo · prometheus]
  end
  Internet --> CADDY --> API1
  API1 --- PG & RD
  WK --- PG & RD & MINIO
  WK --> BW & MCP
```

Seul Caddy est exposé (443, 80). `browser-worker` et `mcp-runner` n'ont **aucun port publié** et
vivent sur un réseau sans route entrante ; leur egress est filtré.

## 3. Services

| Service          | Image                               | Notes                                                                            |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `caddy`          | caddy:2                             | TLS Let's Encrypt automatique, reverse proxy, WS upgrade, compression            |
| `api`            | node:22-alpine (distroless en prod) | 2 réplicas, healthcheck `/healthz`, non-root                                     |
| `worker`         | idem                                | concurrence BullMQ configurable, arrêt gracieux (drain)                          |
| `browser-worker` | python:3.12 + Playwright            | `shm_size: 1g`, `mem_limit`, seccomp, non-root                                   |
| `mcp-runner`     | node:22-alpine                      | héberge les serveurs MCP stdio, env minimal, réseau restreint                    |
| `postgres`       | pgvector/pgvector:pg16              | volume persistant, `pg_dump` planifié, WAL archivé                               |
| `redis`          | redis:7-alpine                      | AOF `everysec` ; queues et streams sont reconstructibles                         |
| `minio`          | minio                               | artefacts, audio, captures ; migrable vers S3/R2 sans changement de code         |
| `migrate`        | idem api                            | job one-shot avant `api`/`worker` (`depends_on: service_completed_successfully`) |
| `backup`         | alpine + cron                       | dumps chiffrés vers stockage distant                                             |

Chaque service : `restart: unless-stopped`, `healthcheck`, limites CPU/mémoire, logs JSON avec
rotation, utilisateur non-root, système de fichiers en lecture seule quand possible.

## 4. Configuration

Trois niveaux, jamais mélangés :

1. **Build** — versions d'images, features de compilation.
2. **Déploiement** — `.env` sur le VPS (Docker secrets pour les valeurs sensibles), hors dépôt,
   sauvegardé séparément.
3. **Runtime** — réglages modifiables sans redéploiement (providers actifs, budgets, serveurs MCP,
   politiques) en base, éditables depuis l'app.

`@nexus/config` valide tout au démarrage avec Zod. Une variable manquante ou mal typée **empêche
le boot** — on préfère un service qui ne démarre pas à un service qui échoue à 3 h du matin sur
une clef absente.

## 5. Déploiement continu

```
push main
 → CI : install (frozen lockfile) → typecheck → lint → test → build → test:integration (services éphémères)
 → scan : gitleaks, pnpm audit, trivy sur les images
 → build & push images taguées par SHA
 → deploy : ssh VPS → pull → migrate (job) → rolling restart api → restart worker (drain)
 → smoke tests → sinon rollback automatique sur le tag précédent
```

**Migrations** : additives d'abord (expand/contract). Une colonne n'est supprimée qu'un
déploiement après que le code a cessé de la lire. Le job de migration tourne seul, avant les
applications, et un échec bloque le déploiement.

**Arrêt gracieux** : sur `SIGTERM`, l'API cesse d'accepter, draine les WS (avec un événement
`server.shutdown` qui invite les clients à se reconnecter), puis quitte. Le worker termine le run
courant ou le repose en queue (le run est persisté : aucune perte).

## 6. Sauvegarde & restauration

| Donnée                    | Fréquence           | Rétention                | Destination                   |
| ------------------------- | ------------------- | ------------------------ | ----------------------------- |
| PostgreSQL (dump chiffré) | 6 h                 | 30 j + 1 mensuel/12 mois | S3/R2 hors VPS                |
| WAL                       | continu             | 7 j                      | idem (PITR)                   |
| MinIO                     | quotidien           | 30 j                     | idem                          |
| `.env` / secrets          | à chaque changement | —                        | gestionnaire de mots de passe |

La restauration est **testée mensuellement** par un script `infra/scripts/restore-drill.sh` qui
remonte une pile complète depuis un dump. Une sauvegarde jamais restaurée n'est pas une
sauvegarde.

## 7. Environnements

- **Local** : Compose allégé (postgres, redis, minio) + apps en `pnpm dev` avec hot reload ;
  providers LLM/STT/TTS remplaçables par des fakes déterministes (aucune clef requise pour
  lancer le projet).
- **Staging** (optionnel) : même Compose, sous-domaine distinct, données synthétiques.
- **Production** : le VPS.

## 8. Ce qu'il faudra changer si le projet grossit

Non nécessaire aujourd'hui, mais le chemin est dégagé : PostgreSQL managé, Redis managé,
`browser-worker` et `mcp-runner` sur un hôte dédié, workers autoscalés par profondeur de queue,
puis seulement ensuite un orchestrateur. Aucune de ces étapes ne demande de réécriture, parce que
les services sont sans état et communiquent par contrats réseau.
