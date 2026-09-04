# ADR-009 — WebSocket unique, typé, reprenable

**Statut** : Proposé · 2026-09-01

## Contexte

Le mobile doit recevoir en temps réel : tokens, démarrage d'outil, progression, résultat, demande
de confirmation, réponse finale, erreurs. Il le fait sur un réseau mobile instable, en économisant
sa batterie, et parfois sur plusieurs appareils simultanés (téléphone + PC sur la même
conversation).

## Décision

1. **Une connexion** par client, multiplexée par canaux (`conversation:*`, `run:*`, `user:*`).
2. **`ws` natif**, pas de Socket.IO.
3. **Enveloppe typée et versionnée** (`v`, `id`, `type`, `ts`, `seq`, `channel`, `payload`),
   définie par une union discriminée Zod dans `@nexus/contracts`, validée aux deux bouts. Un type
   inconnu est ignoré, jamais fatal — les vieux clients survivent aux nouveaux événements.
4. **Reprise par `seq`** : les événements d'un run sont conservés 15 min dans un Redis Stream ;
   `subscribe { since }` rejoue ce qui manque. Une coupure réseau ne perd pas la réponse en cours.
5. **Coalescence des tokens** (~50 ms / 40 caractères) et **buffer borné** : sous pression, on
   sacrifie le streaming, jamais les événements d'état.
6. **Deux endpoints séparés** : `/ws/client` et `/ws/device`.

## Alternatives

- **SSE + POST.** Plus simple, traverse mieux les proxies, reconnexion native avec `Last-Event-ID`.
  Écarté : unidirectionnel, donc il faudrait un second canal pour l'audio en flux et les
  confirmations, et deux mécanismes valent moins qu'un seul bien fait.
- **Socket.IO.** Reconnexion et rooms fournies, mais protocole propriétaire, surcoût de payload,
  et clients non-JS (device agent Rust éventuel, tests Python) plus difficiles.
- **gRPC / Connect streaming.** Excellent typage, mais support navigateur et React Native
  laborieux, et outillage disproportionné ici.
- **Un socket par run.** Coût de connexion et de batterie prohibitif sur mobile.

## Conséquences

**Positives** — un seul canal à sécuriser, monitorer et déboguer ; typage partagé ; reprise propre ;
messages « echo » vers les autres appareils gratuits grâce aux canaux.

**Négatives, acceptées** — il faut implémenter soi-même reconnexion, heartbeat, backpressure et
reprise (≈ 300 lignes, testées) ; les WebSockets tolèrent mal certains proxys d'entreprise
(mitigation possible : repli SSE en lecture seule, non prévu en v1) ; le rejeu impose un stockage
d'événements borné dans le temps.
