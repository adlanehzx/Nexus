# 08 — Protocole WebSocket

## 1. Décisions de base

- **Une seule connexion** par client, multiplexée par canaux (`conversation:{id}`, `run:{id}`,
  `user:{id}`, `device:{id}`). Ouvrir un socket par run est un anti-pattern mobile : coûteux en
  batterie, fragile en réseau cellulaire.
- **WebSocket natif** (`ws`), pas Socket.IO : un protocole propriétaire n'apporte rien ici et
  complique le client Python/Rust éventuel (→ [ADR-009](../adr/ADR-009-ws-protocol.md)).
- **Deux endpoints** : `/ws/client` (utilisateurs) et `/ws/device` (Device Agents). Séparer les
  surfaces d'authentification et de messages évite les confusions de privilèges.
- **JSON par défaut**, MessagePack négociable ; les payloads audio passent en frames binaires.

## 2. Enveloppe

Chaque message, dans les deux sens, a la même forme :

```jsonc
{
  "v": 1, // version du protocole ; incompatibilité → close(4400)
  "id": "01J...", // ULID du message (dédup côté client)
  "type": "agent.token",
  "ts": "2026-09-01T10:00:00.123Z",
  "seq": 42, // monotone par canal ; base de la reprise
  "channel": "run:01J...",
  "payload": {},
}
```

Un `z.discriminatedUnion('type', ...)` dans `@nexus/contracts` définit l'ensemble ; le client et
le serveur valident à la réception. Un message inconnu est ignoré et journalisé, jamais fatal :
c'est ce qui permet d'ajouter des événements sans casser les vieux clients mobiles.

## 3. Établissement de connexion

```
1. Client   WSS /ws/client?v=1  (pas de token dans l'URL : il finirait dans les logs)
2. Serveur  attend le premier frame ; 5 s de grâce
3. Client   { type: "auth", payload: { accessToken } }
4. Serveur  { type: "connection.ready", payload: { sessionId, serverTime, limits, features } }
5. Client   { type: "subscribe", payload: { channels: ["conversation:X"], since: { "run:Y": 41 } } }
6. Serveur  rejoue les événements manquants depuis le Redis Stream, puis passe en direct
```

`since` est ce qui rend le protocole **reprenable** : un tunnel qui passe en 4G ne perd pas la
réponse en cours. Les événements sont conservés 15 minutes dans un Redis Stream par run.

## 4. Client → Serveur

| Type                                         | Payload                                                      | Notes                           |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------- |
| `auth`                                       | `{ accessToken }`                                            | obligatoire en premier          |
| `subscribe` / `unsubscribe`                  | `{ channels[], since? }`                                     | autorisation vérifiée par canal |
| `message.send`                               | `{ conversationId, content, clientMessageId, attachments? }` | `clientMessageId` = idempotence |
| `run.cancel`                                 | `{ runId, reason? }`                                         |                                 |
| `confirmation.respond`                       | `{ confirmationId, decision, remember?, nonce }`             | miroir de l'API REST            |
| `voice.start` / `voice.chunk` / `voice.stop` | frames binaires                                              | streaming STT                   |
| `typing`                                     | `{ conversationId }`                                         | présence multi-appareils        |
| `ping`                                       | `{}`                                                         | heartbeat applicatif, 25 s      |

## 5. Serveur → Client

| Type                            | Payload                                                                  | Sémantique                                    |
| ------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| `connection.ready`              | `{ sessionId, limits, features }`                                        | après auth                                    |
| `message.created`               | `Message`                                                                | echo, y compris vers les **autres** appareils |
| `run.started`                   | `{ runId, mode, budget }`                                                |                                               |
| `run.status`                    | `{ runId, status, iteration }`                                           | transitions de la machine à états             |
| `agent.thinking`                | `{ runId, label }`                                                       | alimente l'animation mobile                   |
| `agent.plan`                    | `{ runId, steps[] }`                                                     | plan affiché et mis à jour                    |
| `agent.token`                   | `{ runId, messageId, delta, index }`                                     | streaming ; coalescé (§7)                     |
| `agent.message`                 | `Message`                                                                | message assistant complet et persisté         |
| `tool.started`                  | `{ execId, runId, tool, title, riskLevel, argsPreview }`                 | `argsPreview` rédigé                          |
| `tool.progress`                 | `{ execId, pct?, label?, chunk?, screenshotUrl? }`                       | browser, shell, upload                        |
| `tool.result`                   | `{ execId, ok, summary, artifacts[], durationMs }`                       |                                               |
| `confirmation.requested`        | `{ confirmationId, title, summary, diff?, riskLevel, expiresAt, nonce }` | déclenche la carte + push                     |
| `confirmation.resolved`         | `{ confirmationId, decision, by }`                                       | ferme la carte sur tous les appareils         |
| `run.completed`                 | `{ runId, messageId, usage }`                                            |                                               |
| `run.failed`                    | `{ runId, error: { code, userMessage } }`                                | jamais de stack trace                         |
| `run.cancelled` / `run.partial` | `{ runId, summary }`                                                     |                                               |
| `device.status`                 | `{ deviceId, status }`                                                   | badge de disponibilité                        |
| `memory.updated`                | `{ memoryId, kind }`                                                     | « j'ai retenu que… »                          |
| `error`                         | `{ code, message, retryable, correlationId }`                            | erreur de protocole                           |
| `pong`                          | `{ serverTime }`                                                         |                                               |

## 6. Canal device (`/ws/device`)

| Sens | Type                                 | Rôle                                                            |
| ---- | ------------------------------------ | --------------------------------------------------------------- |
| →    | `device.auth`                        | challenge signé Ed25519                                         |
| ←    | `device.ready`                       | politique attendue, version de protocole                        |
| →    | `device.heartbeat`                   | 20 s ; charge, version, tâches en cours                         |
| ←    | `device.task.assign`                 | `{ taskId, tool, args, idemKey, deadline }`                     |
| →    | `device.task.accepted` / `.rejected` | rejet motivé (policy, capacité)                                 |
| →    | `device.task.progress`               | stdout/stderr en chunks, pourcentage                            |
| →    | `device.task.result`                 | `{ ok, output, exitCode, metrics }`                             |
| ←    | `device.task.cancel`                 | annulation coopérative                                          |
| ←    | `device.policy.sync`                 | le serveur demande la politique locale courante (lecture seule) |

Le serveur ne peut **jamais** modifier la politique locale par ce canal. C'est intentionnel.

## 7. Backpressure, coalescence, limites

- **Coalescence des tokens** : les deltas sont agrégés par fenêtre de ~50 ms ou 40 caractères.
  Envoyer un frame par token détruit la batterie du mobile pour aucun gain perceptible.
- **Buffer borné** : si le client ne consomme pas (`bufferedAmount` > 1 Mo), on dégrade — on
  cesse d'envoyer `agent.token` et on ne garde que les événements d'état ; le texte complet
  arrivera dans `agent.message`. Perdre du streaming est acceptable, perdre l'état ne l'est pas.
- **Limites** : 1 Mo par frame, 20 messages/s par connexion, 5 connexions par utilisateur.
- **Heartbeat** : ping applicatif 25 s, timeout 60 s. Le mobile en arrière-plan ferme sa
  connexion et bascule sur les **push notifications** pour les confirmations et les fins de run.

## 8. Codes de fermeture

| Code | Sens                                                                |
| ---- | ------------------------------------------------------------------- |
| 4400 | version de protocole incompatible → le client doit se mettre à jour |
| 4401 | auth manquante ou invalide                                          |
| 4403 | canal non autorisé                                                  |
| 4408 | timeout d'authentification                                          |
| 4429 | rate limit dépassé                                                  |
| 4500 | erreur serveur → reconnexion avec backoff                           |

Le client reconnecte avec backoff exponentiel + jitter (1 s → 30 s), **sauf** sur 4400 et 4401
(4401 déclenche d'abord un rafraîchissement de token, puis une seule nouvelle tentative).
