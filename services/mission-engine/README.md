# NEXUS Mission Engine

Moteur local durable de NEXUS. Il possède la file de missions, les dépendances,
les leases, les reprises, le routage entre profils ACP, le contrôle qualité et
le ledger de simulation. Les tours d'agents sont exécutés par le runtime ACP
natif situé dans `services/agent`.

Le service n'accepte aucun secret fournisseur. Les adaptateurs ACP réutilisent
uniquement les authentifications locales de leurs CLI respectifs.

## Vérification

```bash
uv sync --extra dev
uv run pytest
```
