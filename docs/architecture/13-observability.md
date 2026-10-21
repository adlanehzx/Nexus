# 13 — Observabilité

Un agent est un système non déterministe qui prend des décisions coûteuses et irréversibles. Sans
observabilité, il est indébuggable : on ne peut ni reproduire une erreur, ni expliquer une action,
ni maîtriser un coût. C'est une exigence structurelle, pas un confort de production.

## État implémenté

- métriques OpenTelemetry exposées au format Prometheus sur un port séparé ;
- spans HTTP et export OTLP optionnel vers le Collector puis Tempo ;
- compteurs de runs, jetons, outils, erreurs, bascules explicites et latence par agent ;
- coût API **équivalent** uniquement si l'administrateur fournit une table de prix ;
- page Runs avec agrégats, latence moyenne/p95, erreurs et rejeu d'analyse ;
- stack locale optionnelle Prometheus, Grafana, Loki, Tempo, Collector et Alloy ;
- collecte des journaux Docker en lecture seule, sans monter la socket Docker.

Lancement :

```bash
pnpm docker:observability
```

Grafana écoute uniquement sur `http://127.0.0.1:3300`. Changez
`GRAFANA_ADMIN_PASSWORD` dans `.env` avant tout usage autre qu'une machine de développement.
L'API n'exporte les traces que lorsque `OTEL_EXPORTER_OTLP_ENDPOINT` est défini ; le script ci-dessus
le positionne vers le Collector interne. Les métriques restent disponibles sans la stack.

## 1. Corrélation

Un identifiant unique traverse toute la chaîne et apparaît dans **chaque** log, span et métrique :

```
correlationId  →  requête HTTP → job BullMQ → run agent → appel LLM
               →  exécution d'outil → tâche device → appel browser worker
               →  événement WebSocket rendu par le client
```

Il est affiché discrètement dans l'UI en cas d'erreur : l'utilisateur peut le citer, et une seule
recherche donne l'histoire complète. Champs de corrélation secondaires : `userId`, `runId`,
`conversationId`, `execId`, `deviceId`.

## 2. Logs (Pino → JSON)

```jsonc
{
  "level": "info",
  "time": "…",
  "correlationId": "…",
  "userId": "…",
  "runId": "…",
  "component": "tool-executor",
  "event": "tool.completed",
  "tool": "mail.send",
  "riskLevel": "CONFIRM",
  "durationMs": 412,
  "ok": true,
}
```

Règles : un log est un **événement**, pas une phrase (`event` est une énumération stable) ·
redaction native sur `authorization`, `cookie`, `password`, `token`, `apiKey`, `email` (hors
contexte métier) · aucun contenu de message utilisateur en `info` (uniquement en `debug`, désactivé
en production) · les erreurs portent toujours `code` + `correlationId`.

## 3. Traces (OpenTelemetry)

Une trace par run, avec la hiérarchie de spans qui reflète la boucle :

```
run.execute                                   [12.4 s]
├── context.assemble                          [ 0.2 s]  tokens=8412
├── llm.generate  model=… iteration=1         [ 2.1 s]  in=8412 out=142 cost=0.021
├── permission.check tool=mail.list           [ 0.01s]  effect=ALLOW
├── tool.execute  mail.list                   [ 1.2 s]  ok=true
├── llm.generate  iteration=2                 [ 3.4 s]
├── confirmation.wait                         [ 4.2 s]  ← temps humain, isolé
└── tool.execute  mail.send                   [ 1.3 s]
```

Isoler `confirmation.wait` est important : sans cela, toute mesure de latence agent est polluée
par le temps de réflexion humain et devient ininterprétable.

Exporteur OTLP → Grafana Tempo (ou Jaeger en dev). Échantillonnage : 100 % des runs échoués,
100 % des runs avec outil `CRITICAL`, 10 % du reste.

## 4. Métriques (Prometheus)

| Famille     | Métriques                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Agent       | `nexus_agent_runs_total{agent,status}`, `nexus_agent_run_duration_seconds`, `nexus_agent_fallbacks_total` |
| LLM         | `nexus_agent_tokens_total{agent,direction}`, `nexus_agent_api_equivalent_cost_usd_total`                  |
| Outils      | `nexus_tool_calls_total{tool,status,agent}`                                                               |
| Permissions | `permission_decisions_total{effect,risk}`, `confirmations_total{status}`, `confirmation_response_seconds` |
| Temps réel  | `ws_connections`, `ws_messages_total{type}`, `ws_dropped_frames_total`, `ws_resume_total`                 |
| Devices     | `devices_online`, `device_task_duration_seconds`, `device_policy_denied_total`                            |
| Infra       | latences HTTP, profondeur des queues, pool PG, mémoire, `outbox_lag_seconds`                              |

Le coût affiché est un **équivalent API configurable**, jamais une facture déduite de l'abonnement
CLI. Sans `MODEL_PRICING_JSON`, NEXUS affiche « non configuré » au lieu d'inventer un montant.

## 5. Alertes qui comptent

| Alerte                    | Seuil             | Pourquoi                             |
| ------------------------- | ----------------- | ------------------------------------ |
| Taux d'échec de run       | > 10 % sur 15 min | régression fonctionnelle             |
| Coût horaire              | > 3× la médiane   | boucle infinie ou abus               |
| Confirmations expirées    | > 20 %            | les push ou l'UX ne fonctionnent pas |
| Runs bloqués en `RUNNING` | > 10 min          | worker mort sans libérer le verrou   |
| Profondeur de queue       | > 100             | worker sous-dimensionné              |
| Erreurs `PROVIDER`        | > 5 %             | provider LLM dégradé → bascule       |
| `outbox_lag`              | > 60 s            | dispatcher en panne                  |
| Device hors ligne         | inattendu         | perte de capacité                    |

## 6. Débogage d'un run

L'écran admin « Runs agent » expose le statut, la réponse finale, les outils, les arguments rédigés,
les erreurs et les métriques. Il ne sérialise jamais le transcript, les blocs de raisonnement du
fournisseur ni les secrets. Cette frontière est testée.

Le rejeu crée une nouvelle conversation reliée au run source et fixe `maxToolCalls` à zéro. C'est
donc un **rejeu d'analyse** : même si le modèle réclame un outil à effet externe, l'outil n'est pas
exécuté. Un rejeu avec effets doit passer par une nouvelle mission et ses confirmations normales.

## 7. Stack

La stack Compose fournie vise une installation personnelle mono-machine. Elle conserve ses données
dans des volumes nommés et ne publie que Grafana et Prometheus sur la boucle locale. Pour un VPS,
ajouter TLS, sauvegardes, rétention explicite et authentification amont avant exposition réseau.
