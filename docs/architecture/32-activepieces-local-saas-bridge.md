# 32. Automatisation Locale Activepieces et Actions SaaS

## 1. Contexte et Objectifs

Activepieces offre à NEXUS un écosystème de centaines de connecteurs SaaS prêts à l'emploi (Slack, Discord, Notion, Stripe, GitHub, Airtable, etc.) orchestrables localement :
1. **Déploiement local isolé** :
   - Déploiement conteneurisé via `infrastructure/docker/docker-compose.activepieces.yml`.
   - Boucle locale stricte `127.0.0.1:8080` sans aucune exposition extérieure ni fuite sur Tailscale.
   - Secrets et clés API résolus dynamiquement depuis le trousseau sécurisé NEXUS (`vault://nexus/...`).
2. **Pont NEXUS → Activepieces (`@nexus/activepieces`)** :
   - `ActivepiecesBridgeClient` assure la communication avec l'API REST locale d'Activepieces et ses webhooks.
   - Déclenchement de flux (flows) synchrone ou asynchrone avec suivi d'exécution (`pollRun`).
   - Exécution ciblée d'actions sur n'importe quelle pièce SaaS enregistrée.
3. **Gating de sécurité et confirmation humaine obligatoire** :
   - Toute action externe irréversible (envoi de message public Slack/Discord, débit financier Stripe, suppression de ressource, etc.) déclenche **OBLIGATOIREMENT** une demande de confirmation humaine avec résumé clair de l'action.
   - Les actions de pure consultation (lecture de pages, listage de bases) restent directes sans blocage.
4. **Réinjection des résultats dans les missions NEXUS** :
   - Les sorties structurées (identifiants d'objets distants, données extraites) sont retournées directement aux agents et missions sous forme de `ToolResult`.

## 2. Outils Natifs pour les Agents NEXUS

| Outil | Domaine | Niveau de Risque | Confirmation Humaine | Description |
|---|---|---|---|---|
| `activepieces.list_flows` | `terminal.execute` | `SAFE` | Non | Liste les flux d'automatisation locaux disponibles |
| `activepieces.trigger_flow` | `terminal.execute` | `HIGH` | Conditionnelle (`isSensitive`) | Déclenche un flux complet via webhook ou identifiant |
| `activepieces.execute_action` | `terminal.execute` | `HIGH` | **Dynamique / Obligatoire si sensible** | Exécute une action SaaS directe (Slack, Stripe, Notion, etc.) |
| `activepieces.get_run` | `terminal.execute` | `SAFE` | Non | Interroge l'état et la sortie d'un run |

## 3. Déploiement Local Isolé

Pour démarrer la pile locale Activepieces isolée :
```bash
docker compose -f infrastructure/docker/docker-compose.activepieces.yml up -d
```
L'interface et l'API sont confinées à l'adresse de bouclage `http://127.0.0.1:8080`.
