# Contribuer à NEXUS

Merci de contribuer. NEXUS exécute des agents et des outils sur des données réelles : une
modification correcte fonctionnellement peut rester dangereuse. Toute contribution doit donc
préserver le refus par défaut, les confirmations humaines et la non-divulgation des secrets.

## Environnement

1. Installez les versions déclarées dans `.nvmrc` et `package.json#packageManager`.
2. Copiez `.env.example` vers `.env` et n'y mettez que des identifiants de développement.
3. Lancez `pnpm install`, puis `pnpm db:generate`.
4. Avant une pull request, lancez `pnpm verify` et `pnpm format:check`.
5. Pour une modification de persistance, lancez aussi `pnpm test:pg` sur un PostgreSQL pgvector.

Le Mission Engine Python se vérifie avec :

```bash
cd services/mission-engine
uv sync --frozen --extra dev
uv run pytest -q
```

## Règles de contribution

- Ajoutez un test qui échoue avant le correctif et réussit après.
- N'ajoutez jamais de secret, jeton, cookie, export de navigateur ou chemin utilisateur absolu.
- N'affaiblissez pas une permission ou une confirmation pour faire passer un scénario.
- Documentez les migrations, les variables d'environnement et les choix d'architecture durables.
- Conservez les paquets indépendants du framework : l'API reste le point de composition.
- Une dépendance nouvelle doit avoir une version bornée, une licence compatible et une raison
  explicite. Les services sous licence réseau forte restent optionnels et séparés.

Les changements sensibles (authentification, cryptographie, exécution de commandes, MCP,
sandbox, mises à jour) exigent une revue de sécurité. Signalez une vulnérabilité en privé selon
[`SECURITY.md`](SECURITY.md), jamais dans une issue publique.
