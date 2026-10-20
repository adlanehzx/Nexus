# Recherche web NEXUS

NEXUS expose un contrat interne `WebSearchProvider`. L'agent ne connaît ni
SearXNG ni son API : il voit uniquement l'outil stable `search.web`.

```text
Agent Core → ToolRegistry → search.web → WebSearchProvider → SearXNG
```

Cette frontière permet de remplacer SearXNG sans modifier les prompts, les
permissions ou l'orchestrateur. Le fournisseur normalise les résultats, borne
les contenus et écarte les URL non HTTP(S) ou contenant des credentials.

## Sécurité

- aucune clé LLM ou clé de moteur de recherche ;
- SearXNG n'est jamais publié hors de la boucle locale ;
- le JSON doit être explicitement activé dans `settings.yml` ;
- les extraits sont du contenu externe non fiable, jamais des instructions ;
- `search.web` est en lecture seule, idempotent et exige `browser.navigate` ;
- une instance distante doit utiliser HTTPS.

## Démarrage Docker

Définir `SEARXNG_URL=http://searxng:8080` pour l'API conteneurisée, ou
`SEARXNG_URL=http://127.0.0.1:18080` lorsque l'API tourne directement sur
l'hôte. Générer une valeur aléatoire pour `SEARXNG_SECRET`, puis lancer :

```bash
pnpm docker:research
pnpm docker:up
```

Le profil `research` reste optionnel : sans `SEARXNG_URL`, aucun outil de
recherche n'est enregistré et le reste de NEXUS démarre normalement.

## Dépendance et licence

SearXNG est exécuté comme service séparé depuis son image officielle épinglée ;
son code n'est ni copié ni lié à celui de NEXUS. SearXNG est distribué sous
AGPL-3.0-or-later. Une redistribution de l'image, ou une version modifiée mise à
disposition sur un réseau, doit respecter ses obligations et fournir un accès à
la source correspondante : <https://github.com/searxng/searxng>.
