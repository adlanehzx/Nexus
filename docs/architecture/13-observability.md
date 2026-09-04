# 13 — Observabilité

Un agent est un système non déterministe qui prend des décisions coûteuses et irréversibles. Sans
observabilité, il est indébuggable : on ne peut ni reproduire une erreur, ni expliquer une action,
ni maîtriser un coût. C'est une exigence structurelle, pas un confort de production.

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

| Famille     | Métriques                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Agent       | `runs_total{status}`, `run_duration_seconds`, `run_iterations`, `runs_active`, `partial_ratio`                          |
| LLM         | `llm_requests_total{provider,model,status}`, `llm_tokens_total{direction}`, `llm_latency_seconds`, `llm_cost_usd_total` |
| Outils      | `tool_executions_total{tool,status,risk}`, `tool_duration_seconds{tool}`, `tool_retries_total`                          |
| Permissions | `permission_decisions_total{effect,risk}`, `confirmations_total{status}`, `confirmation_response_seconds`               |
| Temps réel  | `ws_connections`, `ws_messages_total{type}`, `ws_dropped_frames_total`, `ws_resume_total`                               |
| Devices     | `devices_online`, `device_task_duration_seconds`, `device_policy_denied_total`                                          |
| Infra       | latences HTTP, profondeur des queues, pool PG, mémoire, `outbox_lag_seconds`                                            |

**Le coût est une métrique de premier plan**, pas une donnée de facturation à consulter en fin de
mois : `llm_cost_usd_total` par utilisateur et par run, exposé dans l'app (`/me/usage`) et
alertable. Un agent qui boucle doit se voir en quelques minutes.

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

L'écran admin « Run Inspector » (et l'export JSON) reconstitue, à partir de `AgentStep` :
prompt exact envoyé à chaque itération, réponse brute du modèle, arguments d'outil avant et après
validation, décision de permission et son motif, résultat d'outil complet, tokens et coût par
étape. C'est le bénéfice direct de la boucle persistée : **on peut rejouer un run** avec un autre
modèle ou un autre prompt et comparer, ce qui est la base des évaluations
(→ [15-testing](15-testing.md) §5).

## 7. Stack

Dev : logs console jolis (`pino-pretty`), Jaeger, Prometheus.
Prod VPS : Grafana + Loki + Tempo + Prometheus en Compose, ou un SaaS (Grafana Cloud / Axiom) si
l'on veut éviter l'exploitation. Sentry pour les erreurs applicatives et les crashs mobiles.
