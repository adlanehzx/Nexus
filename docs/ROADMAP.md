# Roadmap

## Principe d'ordonnancement

Chaque phase se termine par une **démonstration utilisable**, pas par un lot de code. On construit
en tranches verticales : à la fin de la phase 1 on peut réellement parler à l'assistant depuis un
téléphone, même si presque rien n'est fini derrière.

Deux règles qui décident de l'ordre :

1. **Les permissions arrivent avec le premier outil, pas après.** Rétrofitter un système
   d'autorisation sur un agent qui agit déjà est le refactoring le plus douloureux du projet — et
   entre-temps, l'agent peut faire de vrais dégâts.
2. **Le protocole avant les clients.** WebSocket, contrats et boucle durable sont figés tôt, parce
   que cinq consommateurs en dépendront.

Les durées supposent **une personne à temps partiel** et sont indicatives : ce sont des ordres de
grandeur pour séquencer, pas des engagements.

---

## Phase 0 — Fondations · ~1,5 semaine

**Objectif** — un squelette qui compile, se teste et se déploie, avant toute fonctionnalité.

- Monorepo pnpm + Turborepo, TypeScript strict, ESLint + règles de frontières, Prettier.
- `@nexus/contracts`, `config`, `logger`, `errors`, `testing` (versions minimales).
- Prisma : schéma initial (User, Session, Conversation, Message), migrations, seed.
- Docker Compose local (postgres+pgvector, redis, minio) + Dockerfiles.
- CI : install → typecheck → lint → test → build, gitleaks, `pnpm audit`.
- `/healthz`, logs structurés, `correlationId` de bout en bout.

**Critère de sortie** — `pnpm dev` démarre tout ; `pnpm test` passe ; un déploiement bidon part sur
le VPS et répond en HTTPS.

---

## Phase 1 — Conversation de bout en bout · ~2 semaines

**Objectif** — parler à l'assistant depuis l'iPhone, en streaming. Aucun outil.

- Auth : inscription, connexion, JWT + refresh rotatif, `expo-secure-store`.
- API v1 : `/auth`, `/conversations`, `/messages`.
- `@nexus/llm` : port `LLMProvider` + un adaptateur réel + `FakeLLM`.
- WS Gateway : enveloppes typées, auth, canaux, heartbeat, reconnexion, reprise par `seq`.
- `apps/worker` + BullMQ : run minimal (pas de boucle d'outils), streaming de tokens.
- Mobile Expo : écran conversation, composer, streaming, historique. UI volontairement brute.

**Critère de sortie** — j'envoie « raconte-moi une blague » depuis mon iPhone, la réponse s'écrit
en direct, je coupe le Wi-Fi et je le rétablis : le flux reprend sans perte.

---

## Phase 2 — Agent, outils et permissions · ~3 semaines · **phase la plus critique**

**Objectif** — l'agent agit réellement, sous contrôle.

- `@nexus/agent-core` : boucle durable, `AgentRun` / `AgentStep`, budgets, itérations, timeout,
  annulation, retry, résultat partiel, replanification sur échec.
- `tools-core` : `ToolDefinition`, `ToolRegistry`, `ToolExecutor` (validation, idempotence,
  timeout, circuit breaker, redaction, artefacts).
- `permissions` : `RiskEvaluator`, `PermissionService`, grants scopés, deny par défaut.
- Confirmations : suspension durable du run, `payloadHash`, `nonce`, expiration, reprise.
- Premiers outils : `search.web`, `weather.get`, `http.request`, `memory.*`, `calendar.*`, `mail.*`.
- OAuth Google (calendrier, Gmail) + coffre à credentials chiffré.
- UI mobile : cartes d'outils, cartes de confirmation, bouton d'annulation.
- Tests unitaires exhaustifs sur la boucle et la table de vérité des permissions.

**Critère de sortie** — « regarde mes emails et dis-moi lesquels sont importants » fonctionne ;
« envoie un message à X » ouvre une carte de confirmation montrant le texte exact ; refuser
l'annule proprement ; tuer le worker au milieu d'un run et le redémarrer reprend le run.

---

## Phase 3 — Application mobile réelle · ~2,5 semaines

**Objectif** — passer d'un prototype à une application qu'on a envie d'ouvrir.

- Design system (`@nexus/ui-tokens`), animations d'état (réflexion / exécution / attente).
- Écrans Historique, Tâches, Permissions, Mémoire, Settings.
- Envoi optimiste, mode hors ligne, file de réémission.
- Notifications push (confirmations, fins de run), actions depuis la notification.
- Build TestFlight, Sentry, télémétrie de crash.

**Critère de sortie** — l'application est utilisée quotidiennement sans passer par un terminal.

---

## Phase 4 — Device Agent · ~2,5 semaines

**Objectif** — l'assistant agit sur le PC depuis le téléphone.

- `@nexus/device-protocol`, canal `/ws/device`, appairage Ed25519 par QR code.
- Démon Node : politique locale YAML, jail de chemins, allowlist shell, classifieur de commandes.
- Outils `device.fs.*`, `device.shell.exec`, `device.process.*`, `device.git.*`, `device.docker.*`.
- Heartbeat, reconnexion, reprise de tâche, annulation, streaming stdout.
- Installation en service Windows, signature du binaire.
- UI Devices : statut, logs en direct, édition de la politique, bouton pause.

**Critère de sortie** — « ouvre mon projet LeynAI et lance les tests » depuis l'iPhone affiche la
sortie des tests en direct ; « regarde pourquoi Docker ne démarre pas » remonte un diagnostic ;
une commande hors politique est refusée par le PC et expliquée par l'agent.

---

## Phase 5 — MCP et Browser Use · ~2,5 semaines

**Objectif** — extensibilité et navigation web.

- `McpManager` : stdio + HTTP/SSE, découverte, traduction JSON Schema → Zod, supervision, hot
  reload, conteneur `mcp-runner` isolé. UI d'ajout de serveur.
- `apps/browser-worker` : FastAPI + browser-use, contrat OpenAPI, tests de contrat TS ↔ Python.
- Outils `browser.act` et `browser.navigate/extract/click/type`, progression avec captures d'écran.
- Isolation réseau, filtrage d'egress, budgets de session.

**Critère de sortie** — « va sur ce site et récupère les informations » affiche la navigation
étape par étape ; ajouter un serveur MCP depuis l'app rend ses outils disponibles sans
redéploiement, en `CONFIRM` par défaut.

---

## Phase 6 — Mémoire et tâches planifiées · ~2 semaines

**Objectif** — l'assistant se souvient et agit dans le temps.

- pgvector + HNSW, recherche hybride RRF, extraction post-run, déduplication, supersession.
- Compaction du contexte, `ConversationSummary`, `artifact.read`.
- Écran Mémoire (voir, éditer, épingler, oublier).
- `Task` planifiées et récurrentes (« chaque matin, résume mes mails ») via BullMQ repeatable.
- Job d'oubli hebdomadaire.

**Critère de sortie** — l'assistant se souvient d'un fait donné trois semaines plus tôt ; une
conversation de 200 messages reste utilisable et à coût stable ; une routine matinale s'exécute
seule et notifie.

---

## Phase 7 — Voix · ~2 semaines

**Objectif** — parler et être répondu à voix haute.

- Ports STT/TTS + adaptateurs cloud, mode dictée avec transcription éditable.
- Puis streaming : `voice.chunk`, endpointing, TTS phrase par phrase, barge-in.
- Réglages de voix, mode « ne jamais conserver l'audio », adaptateurs locaux (whisper.cpp, Piper).

**Critère de sortie** — conversation vocale mains libres avec moins de 1,5 s de latence perçue ;
une action `CRITICAL` refuse l'approbation vocale et exige un geste.

---

## Phase 8 — Desktop, web et durcissement · ~3 semaines

**Objectif** — rendre le système présentable, observable et robuste.

- App Tauri v2 : UI partagée, tray, raccourci global, fenêtre spotlight, supervision du démon.
- Web (Vite) pour l'accès occasionnel.
- Observabilité complète : OTel + Grafana/Loki/Tempo/Prometheus, tableau de bord coûts, alertes.
- Run Inspector, export de run, rejeu.
- Suite d'évals agent (~50 scénarios) + évals de sécurité (injections), en nocturne.
- Audit de sécurité, tests de restauration, documentation d'exploitation, runbooks.

**Critère de sortie** — un run échoué se diagnostique en moins de 5 minutes ; les évals nocturnes
passent au vert ; une restauration complète depuis sauvegarde est réalisée en conditions réelles.

---

## Vue d'ensemble

| Phase                      | Durée   | Cumul | Livre                       |
| -------------------------- | ------- | ----- | --------------------------- |
| 0 · Fondations             | 1,5 sem | 1,5   | squelette déployable        |
| 1 · Conversation           | 2 sem   | 3,5   | **parler à l'assistant**    |
| 2 · Agent + permissions    | 3 sem   | 6,5   | **il agit, sous contrôle**  |
| 3 · Mobile                 | 2,5 sem | 9     | **application quotidienne** |
| 4 · Devices                | 2,5 sem | 11,5  | **il agit sur le PC**       |
| 5 · MCP + Browser          | 2,5 sem | 14    | **extensible et web**       |
| 6 · Mémoire + tâches       | 2 sem   | 16    | **il se souvient**          |
| 7 · Voix                   | 2 sem   | 18    | **on lui parle**            |
| 8 · Desktop + durcissement | 3 sem   | 21    | **fiable et observable**    |

≈ **5 mois à temps partiel**, avec un produit utile dès la semaine 6,5.

## Coupes possibles si le temps manque

Dans cet ordre : le web (phase 8), le mode conversation vocale continue (garder la dictée),
le desktop Tauri (le mobile + le démon suffisent), les tâches récurrentes. **Ne jamais couper** :
les permissions, les confirmations, la boucle durable, l'audit. Ce sont eux qui rendent le reste
utilisable sans danger.
