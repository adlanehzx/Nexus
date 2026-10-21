# NEXUS Mission Engine

Moteur local durable de NEXUS. Il possède la file de missions, les dépendances,
les leases, les reprises, le routage entre profils ACP, le contrôle qualité et
le ledger de simulation. Les tours d'agents sont exécutés par le runtime ACP
natif situé dans `services/agent`.

Le service n'accepte aucun secret fournisseur. Les adaptateurs ACP réutilisent
uniquement les authentifications locales de leurs CLI respectifs.

## Planification durable

Le scheduler stocke calendriers et occurrences dans la même base SQLite que les
missions. Il accepte une date unique (`run_at`) ou une expression cron à cinq
champs (`cron_expression`), toujours associée à un fuseau IANA comme
`Europe/Paris`. Une occurrence est soumise avec une clé d'idempotence dérivée du
calendrier et de sa date : un redémarrage entre la soumission et son
enregistrement ne crée donc pas une seconde mission.

```json
POST /v1/schedules
{
  "name": "Veille quotidienne",
  "timezone": "Europe/Paris",
  "cron_expression": "0 8 * * 1-5",
  "catch_up_policy": "latest",
  "max_catch_up": 3,
  "max_concurrency": 1,
  "misfire_grace_seconds": 300,
  "mission": {
    "external_key": "daily-watch",
    "title": "Veille quotidienne",
    "workspace": "/workspace",
    "defaults": {"profile": "codex"},
    "tasks": [{"key": "watch", "instruction": "Produis la veille.", "depends_on": []}]
  }
}
```

Les politiques de rattrapage sont :

- `skip` ignore une occurrence plus ancienne que la grâce configurée ;
- `latest` ne rejoue que l'occurrence manquée la plus récente ;
- `all` rejoue au maximum `max_catch_up` occurrences, les plus récentes.

`POST /v1/schedules/{id}/pause` et `/resume` contrôlent un calendrier sans
perdre sa prochaine échéance. `GET /v1/schedules/{id}/runs` fournit l'historique
et le lien vers chaque mission créée. `max_concurrency` borne les missions non
terminées d'un même calendrier.

Le dispatcher est actif par défaut. Il se configure avec
`NEXUS_ENGINE_SCHEDULER_ENABLED` et `NEXUS_ENGINE_SCHEDULER_POLL_SECONDS`.
Une assertion propriétaire Agent Core, qui expire et ne doit pas devenir un
secret de longue durée, reste refusée dans un calendrier. Pour une tâche
`agent-core`, l'API fournit à la place une délégation opaque et révocable,
liée au calendrier. Juste avant chaque occurrence, le moteur l'échange contre
une assertion courte dont l'API recalcule la portée exacte. Le navigateur ne
peut ni fournir ni lire cette délégation.

## Vérification

```bash
uv sync --extra dev
uv run pytest
```
