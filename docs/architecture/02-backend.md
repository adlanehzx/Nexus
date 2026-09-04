# 02 — Backend

## 1. Deux processus, deux responsabilités

|                             | `apps/api`                                    | `apps/worker`                          |
| --------------------------- | --------------------------------------------- | -------------------------------------- |
| Rôle                        | Frontière réseau : REST, WS, auth, validation | Exécution des runs agent et jobs longs |
| Durée des opérations        | millisecondes                                 | secondes à minutes                     |
| Scaling                     | horizontal, sticky non requis                 | horizontal par concurrence de queue    |
| Peut-il appeler un LLM ?    | non                                           | oui                                    |
| Peut-il exécuter un outil ? | non                                           | oui                                    |

Séparer les deux n'est pas de la sophistication gratuite : un run agent dure 5 à 120 secondes et
consomme de la mémoire de contexte. Le mélanger avec le service HTTP rend les déploiements
destructeurs (un redéploiement tue les runs en cours) et le p99 de l'API illisible. Avec la
séparation, un déploiement d'API ne perd aucun run, et un run interrompu est repris par un autre
worker puisque son état est en base.

## 2. Couches de `apps/api`

```
routes/         Fastify. Schémas zod (validation + génération OpenAPI). Zéro logique.
  v1/auth  v1/conversations  v1/messages  v1/agent  v1/tools
  v1/devices  v1/tasks  v1/memory  v1/permissions  v1/confirmations  v1/voice
plugins/        auth JWT, rate-limit, request-id, cors, helmet, sensible, otel
services/       cas d'usage applicatifs (orchestration, transactions)
gateway/        WS : sessions client + sessions device, fanout Redis, reprise par seq
repositories/   Prisma. Seule couche qui connaît le SQL.
```

Règle : une route ne parle jamais à Prisma directement. Elle appelle un service. Le service
possède la transaction. C'est ce qui permet à `POST /agent/runs` d'être atomique (message +
run + job) via le pattern **outbox** (§4).

## 3. Bibliothèques retenues

| Besoin       | Choix                                        | Justification courte                                         |
| ------------ | -------------------------------------------- | ------------------------------------------------------------ |
| HTTP         | Fastify 5                                    | Perf, plugins encapsulés, validation schéma native           |
| Validation   | Zod + `fastify-type-provider-zod`            | Types inférés des schémas, une seule définition              |
| Doc API      | `@fastify/swagger` généré depuis les schémas | Doc toujours vraie ou absente                                |
| ORM          | Prisma                                       | Migrations, typage, pgvector via `Unsupported` + raw queries |
| Queue        | BullMQ                                       | Retry, backoff, priorités, repeatable, dépendances de jobs   |
| Cache/PubSub | ioredis                                      | Un seul Redis pour queues, pubsub, streams, rate-limit       |
| WS           | `@fastify/websocket` (ws)                    | Pas de Socket.IO : protocole propriétaire inutile ici        |
| Auth         | JWT courts + refresh rotatif                 | Voir [09-security](09-security-permissions.md)               |
| Logs         | Pino                                         | JSON structuré, redaction native                             |

## 4. Fiabilité : outbox, idempotence, verrous

**Outbox.** Écrire en base _et_ publier un job sont deux systèmes ; on ne peut pas les rendre
atomiques. On écrit donc `OutboxEvent` dans la même transaction que la donnée métier, et un
dispatcher lit l'outbox et enfile le job. Au pire un job part deux fois — d'où l'idempotence.

**Idempotence.** Trois niveaux :

1. _API_ — en-tête `Idempotency-Key` sur toutes les mutations ; table `IdempotencyKey`
   (clé, hash de requête, réponse, TTL 24 h). Un retry réseau du mobile ne crée pas deux runs.
2. _Jobs_ — `jobId` déterministe (`run:{runId}:step:{n}`) ; BullMQ dédoublonne.
3. _Outils_ — chaque exécution porte une clé dérivée de `(runId, stepIndex, tool, hash(args))`.
   Un outil à effet de bord _doit_ la propager à l'API externe quand celle-ci le supporte, et
   sinon consulter `ToolExecution` avant d'agir. Voir [04-tools](04-tools-mcp.md).

**Verrous.** Un run a un verrou Redis (`lock:run:{id}`, TTL renouvelé) : un seul worker le fait
avancer. Cela protège contre le double-traitement après une reprise de confirmation.

## 5. Erreurs

Une taxonomie unique dans `@nexus/errors` :

```
AppError { code, httpStatus, severity, retryable, userMessage, context }
 ├── ValidationError        400  jamais retryable
 ├── AuthError              401/403
 ├── NotFoundError          404
 ├── ConflictError          409  (idempotence, version)
 ├── PermissionDeniedError  403  → observation réinjectée à l'agent, pas un crash
 ├── ConfirmationRequired   -    signal de contrôle, pas une erreur
 ├── ToolExecutionError     -    { toolName, phase, retryable }
 ├── ProviderError          502  { provider, upstreamCode } retryable si 429/5xx
 ├── TimeoutError           504  retryable
 └── BudgetExceededError    -    arrête le run proprement, résultat partiel conservé
```

Trois principes : (1) `userMessage` est toujours safe à afficher, `context` jamais ; (2) un code
d'erreur est un contrat public et ne change pas ; (3) une erreur d'outil n'est pas une panne du
run — elle devient une observation que le modèle peut traiter (retry avec d'autres arguments,
outil alternatif, ou abandon expliqué).

## 6. Rate limiting & quotas

- Par IP sur `/auth/*` (anti-bruteforce), par utilisateur sur `/agent/runs`.
- Quotas métier distincts du rate limit : tokens/jour, coût/jour, runs concurrents, exécutions
  d'outils/heure et par niveau de risque. Stockés en Redis, reflétés dans `Budget`, exposés dans
  `/api/v1/me/usage`. Un dépassement retourne 429 avec `retryAfter`, et le worker refuse de
  démarrer le run.
