# NEXUS

Assistant personnel IA multi-appareils — iPhone, PC, web — capable d'exécuter des actions
réelles : envoyer un email, réserver un vol, lancer les tests d'un projet, piloter un navigateur.

> **État : alpha locale fonctionnelle.** Le Core, le Mission Engine durable, les agents ACP,
> l'authentification, le dashboard, les permissions, la mémoire vectorielle et l'observabilité
> sont intégrés et testés. Les clients distribués, le packaging public et certaines
> intégrations externes restent expérimentaux : voir [docs/ROADMAP.md](docs/ROADMAP.md).

**Principe directeur** — le LLM ne peut rien faire d'autre qu'émettre du texte et _demander_
l'exécution d'un outil. Toute capacité réelle passe par le registre d'outils, est filtrée par le
service de permissions, exécutée par l'exécuteur et tracée. Il n'existe aucun chemin alternatif
entre un modèle et le monde extérieur.

---

## 1. Prérequis

| Outil            | Version                       | Vérifier                 |
| ---------------- | ----------------------------- | ------------------------ |
| Node.js          | **24.20.0** (LTS « Krypton ») | `node -v`                |
| pnpm             | **11.25.0**                   | `pnpm -v`                |
| Docker + Compose | 27+ / v2                      | `docker compose version` |

Le dépôt contient un `.nvmrc`. Avec nvm :

```bash
nvm install 24.20.0 && nvm use 24.20.0     # nvm-windows : lancer un terminal en administrateur
npm install -g pnpm@11.25.0
```

> Node **≥ 22.13** est un minimum strict, pas une préférence : ESLint 10, Prisma 7 et pnpm 11
> refusent de s'exécuter en deçà. `engine-strict` est activé, l'installation échouera clairement.

## 2. Installation

```bash
git clone https://github.com/adlanehzx/Nexus.git nexus && cd nexus
cp .env.example .env         # les valeurs par défaut suffisent en local
pnpm install
pnpm docker:platform         # postgres + redis + migrations + api + dashboard
```

Le dashboard est alors disponible sur `http://localhost:8080`. La migration est
appliquée par un conteneur éphémère avant le démarrage de l'API : aucune commande
Prisma séparée n'est nécessaire.

Les machines supplémentaires s'ajoutent depuis **Supervision → Appareils** :
installateur Windows, lien Android ou worker Docker isolé pour Linux, NAS et
Raspberry Pi. Chaque ticket expire après cinq minutes et l'appareil doit encore
être approuvé dans le dashboard avant de recevoir une tâche.

Les volumes `nexus-runtime-config`, `nexus-artifacts` et
`nexus-observability` conservent les réglages du dashboard, les captures du
navigateur et les journaux lorsque les conteneurs sont recréés.

Vérifier que tout répond :

```bash
curl http://localhost:3000/health          # liveness  → 200
curl http://localhost:3000/api/v1/health   # readiness → 200 + état des dépendances
```

Pour développer avec rechargement à chaud, ne lancer que les données en conteneur :

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis
pnpm --filter @nexus/api dev
```

## 3. Commandes

| Commande                             | Effet                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `pnpm dev`                           | Démarre les services en mode développement (rechargement à chaud)          |
| `pnpm build`                         | Compile tous les paquets (Turborepo, ordonné par le graphe de dépendances) |
| `pnpm typecheck`                     | `tsc --noEmit` sur tout le monorepo                                        |
| `pnpm lint` / `pnpm lint:fix`        | ESLint 10, typé                                                            |
| `pnpm test` / `pnpm test:watch`      | Vitest                                                                     |
| `pnpm format` / `pnpm format:check`  | Prettier                                                                   |
| **`pnpm verify`**                    | **build + lint + typecheck + test — la porte à passer avant de committer** |
| `pnpm db:migrate`                    | Crée et applique une migration (développement)                             |
| `pnpm db:generate`                   | Régénère le client Prisma                                                  |
| `pnpm db:studio`                     | Ouvre Prisma Studio                                                        |
| `pnpm docker:infra`                  | PostgreSQL + Redis, pour exécuter API et agents sur l'hôte                 |
| `pnpm docker:platform`               | Infrastructure + migration + API + dashboard sur `:8080`                   |
| `pnpm docker:up` / `:down` / `:logs` | Pile Docker et ses profils optionnels                                      |
| `pnpm k8s:images` / `k8s:render`     | Images locales et rendu Kubernetes/k3s                                     |
| `pnpm clean`                         | Supprime `dist`, `.turbo` et `node_modules`                                |

## 4. Variables d'environnement

Toutes sont déclarées dans [`.env.example`](.env.example) et **validées au démarrage** par
`@nexus/config` (Zod). Une variable manquante ou mal typée empêche le boot — on préfère un
service qui refuse de démarrer à un service qui échoue à 3 h du matin sur une clé absente.

| Variable                               | Défaut                  | Rôle                                                           |
| -------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `NODE_ENV`                             | `development`           | `development` \| `test` \| `production`                        |
| `LOG_LEVEL`                            | `info`                  | `fatal` … `trace`                                              |
| `API_VERSION`                          | `0.1.0`                 | Version exposée par la readiness (SHA du commit en production) |
| `API_HOST` / `API_PORT`                | `0.0.0.0` / `3000`      | Écoute HTTP                                                    |
| `CORS_ORIGINS`                         | `http://localhost:3000` | Liste séparée par des virgules ; `*` **refusé** en production  |
| `SHUTDOWN_TIMEOUT_MS`                  | `10000`                 | Délai laissé aux requêtes en cours à l'arrêt                   |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `100` / `1 minute`      | Limitation par IP                                              |
| `DATABASE_URL`                         | —                       | **Obligatoire.** URL `postgresql://`                           |
| `REDIS_URL`                            | —                       | **Obligatoire.** URL `redis://`                                |

`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` ne sont lues que par Docker Compose pour
initialiser le conteneur.

**Aucun secret n'est commité.** `.env` est ignoré par git ; `.env.example` liste les clés, jamais
les valeurs. Les clés des phases ultérieures (fournisseur LLM, `MASTER_KEY` du coffre, jetons du
worker navigateur) y figurent en commentaire et ne sont pas encore validées.

## 5. Architecture

Documentation complète : **[docs/README.md](docs/README.md)** — 16 documents d'architecture,
15 ADR, roadmap et risques.

```
apps/                    clients
  mobile/                iPhone — Expo / React Native ✅
  desktop/               Windows — Vite + Tauri v2    ✅ (coquille Rust non compilée)
  dashboard/             Administration — Vite/React ✅ rôle ADMIN, réglages persistants
  web/                   Vite + React                 → phase 8
services/
  api/                   Fastify — REST v1, WS, auth  ✅
  agent/                 Runtime ACP natif NEXUS      ✅
  browser-worker/        Python — browser-use         ✅
  windows-worker/        Exécutant Windows/Linux      ✅
  android-worker/        Exécutant Redmi Note 10S     ✅ (Kotlin non compilé)
  desktop-worker/        remplacé par windows-worker  —
packages/
  shared/                erreurs, UUID v7             ✅
  config/                validation d'environnement   ✅
  protocol/              enveloppes WS, DTO           ✅
  database/              Prisma + PostgreSQL          ✅
  auth/                  jetons, mots de passe        ✅
  agent-core/            boucle, planner, politiques  ✅ moteur d'agent
  tools/                 registre, exécuteur,         ✅ plan de capacité
                         permissions, confirmations
  llm/                   port + adaptateur Anthropic  ✅
  memory/                port + implémentation mémoire ✅
  mcp/                   clients MCP → ToolRegistry   ✅
  browser-client/        client du Browser Worker     ✅
  mission-control-client/contrat NEXUS ACP/paper      ✅
  worker-core/           runtime commun aux exécutants ✅
  client-core/           cœur client — session, temps  ✅
                         réel, état, voix
  devices/               registre, sélecteur, tâches   ✅
mcp/
  github/  filesystem/   presets de configuration     ✅ (cf. packages/mcp)
infrastructure/docker/   Dockerfiles + compose        ✅
infrastructure/kubernetes/plan de contrôle k3s/K8s    ✅ (agents hors cluster)
```

### NEXUS Mission Engine

NEXUS peut superviser et piloter le service local Mission Control qui orchestre
Antigravity, Claude et Codex et porte le simulateur paper-only. Configurez
`MISSION_CONTROL_URL=http://127.0.0.1:18100` lorsque les deux services tournent
sur le même hôte. Le tableau de bord affiche alors la santé des workers, les
profils ACP, l'intégrité du journal d'audit et une chronologie unifiée des
missions. Les mêmes missions sont projetées dans `Tâches`, `Runs agent` et
`Outils`; les souvenirs utilisateur sont injectés dans le planificateur ACP.

Les migrations de production sont additives et s'appliquent avec :

```bash
pnpm --filter @nexus/database migrate:deploy
```

Les conversations, messages, notifications et runs Agent Core sont alors persistés dans PostgreSQL ;
les journaux rédigés et bornés vivent dans `var/observability`.

Architecture et limites de sécurité :
[`docs/architecture/23-nexus-mission-engine.md`](docs/architecture/23-nexus-mission-engine.md).

### Navigateur autonome sans clé API

NEXUS utilise le `browser-harness` officiel de Browser Use avec un Chromium local dédié. Codex ou
Claude fournit le raisonnement via l'abonnement ACP déjà connecté : aucune clé Gemini, OpenAI,
Anthropic ou Browser Use n'est nécessaire. Installation reproductible :

```bash
./scripts/setup-browser-use.sh
```

Le script installe la version épinglée du harness, désactive télémétrie et enregistrements, crée
un profil Chromium séparé, enregistre les skills Codex/Claude et active le service systemd user.
L'onglet **Browser Use** du dashboard expose ensuite le diagnostic réel. Les actions sont
sérialisées sur ce navigateur local ; le parallélisme isolé de Browser Use Cloud n'est pas activé.

Les paquets marqués « contrats seuls » ne contiennent **que** des types et des schémas — aucune
implémentation fictive. Ils fixent la forme sur laquelle les phases suivantes s'accorderont.

### Règles de dépendance

Vérifiées par la revue et le graphe Turborepo ; elles ne sont pas décoratives :

```
agent-core ──▶ llm · tools · memory · protocol · shared     autorisé
agent-core ──╳ database · mcp · browser-client              interdit
tools      ──╳ llm                                          interdit
api        ──▶ agent-core (composition et routes uniquement) autorisé
```

`agent-core` reçoit un port `AgentRunStore` plutôt que Prisma : c'est ce qui rend la boucle
testable sans base de données et rejouable sur un état en mémoire.

L'API est le composition root : elle injecte les ports PostgreSQL, les outils,
les permissions et les confirmations, puis expose `/api/v1/agent-core/runs`.
Le cœur reste donc indépendant de Fastify et de Prisma même s'il est désormais
exécutable depuis NEXUS.

### Moteur d'agent

Le cœur est implémenté et testé : boucle durable, registre d'outils, permissions
avec refus par défaut, confirmations liées à l'empreinte des arguments, annulation,
budgets, reprise sur erreur avec backoff, et traçage sans secrets.

Documentation : [`packages/agent-core/README.md`](packages/agent-core/README.md) ·
[`docs/architecture/16-agent-core.md`](docs/architecture/16-agent-core.md)

```ts
const { record, confirmation } = await orchestrator.run({
  userId,
  conversationId,
  message: "Envoie un message à Marie",
});
// record.status === "waiting_for_confirmation" → montrer `confirmation`
await orchestrator.resume(record.runId, "approved");
```

## 6. Développement local

### Structure d'un paquet

```
packages/<nom>/
  src/index.ts          point d'entrée public
  test/*.test.ts        tests
  tsconfig.json         typecheck (src + test)
  tsconfig.build.json   compilation (src uniquement) → dist/
  package.json          exports pointant vers dist/
```

Chaque paquet **déclare ce qu'il utilise** : `node-linker=isolated` interdit les dépendances
fantômes. Si un import échoue après un `pnpm install`, la dépendance manque au `package.json` du
paquet — c'est le mécanisme qui fonctionne, pas un bug.

### Conventions

- **ESM strict.** `"type": "module"`, `moduleResolution: NodeNext` : les imports relatifs portent
  l'extension `.js` même en TypeScript.
- **TypeScript strict**, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` et
  `erasableSyntaxOnly`.
- **Zod est la source de vérité** des formes de données : un schéma sert à la fois de validateur,
  de type et de documentation OpenAPI. La doc de l'API ne peut donc pas mentir.
- **Les logs sont des événements**, pas des phrases : le champ `event` est une énumération stable.
- **Un `correlationId` par requête**, accepté depuis l'amont ou généré, renvoyé dans l'en-tête
  `x-request-id` et présent dans chaque log.

### Ajouter une route

1. Décrire l'entrée et la sortie dans `@nexus/protocol` (Zod).
2. Créer le module de route dans `services/api/src/routes/v1/`, typé `FastifyPluginCallbackZod`.
3. L'enregistrer dans `src/app.ts` sous le préfixe `/api/v1`.
4. Ajouter un test dans `services/api/test/` via `app.inject()` — aucun port, aucun service externe.

### Base de données

```bash
pnpm db:migrate --name ajout_table_x   # crée et applique une migration
pnpm db:generate                        # après modification du schéma
```

Prisma 7 : l'URL de connexion ne vit plus dans `schema.prisma`. Les migrations la lisent dans
`packages/database/prisma.config.ts`, et le client la reçoit via le driver adapter `pg`
(`src/client.ts`). Les identifiants sont des **UUID v7 générés côté application**
(`uuidv7()` de `@nexus/shared`) : triés par le temps, donc sans fragmentation d'index.

### Tests

- **Unitaires** — fonctions pures, sans E/S : configuration, erreurs, identifiants, schémas.
- **Smoke API** — `app.inject()` avec PostgreSQL et Redis injectés, ce qui permet de tester le
  chemin dégradé (503 quand une dépendance tombe) sans pouvoir le provoquer autrement.

## 7. Docker

```bash
pnpm docker:up      # postgres + redis + api, avec dépendances conditionnées aux healthchecks
pnpm docker:logs
pnpm docker:down
```

L'image de l'API est construite en trois étapes (dépendances → build → runtime). L'image finale
ne contient que le JavaScript compilé et les dépendances de production : ni sources TypeScript,
ni outils de build. Elle tourne en utilisateur `node`, avec `dumb-init` en PID 1 pour que
`SIGTERM` atteigne réellement le processus et déclenche l'arrêt gracieux.

## 8. État d'avancement

| Phase | Contenu                                                   | État        |
| ----- | --------------------------------------------------------- | ----------- |
| 0     | Fondations : monorepo, CI locale, API, Docker             | ✅ terminée |
| 1     | Conversation de bout en bout, auth, WebSocket, mobile     | à venir     |
| 2     | Agent, outils, permissions, confirmations                 | à venir     |
| 3–8   | Mobile, devices, MCP + navigateur, mémoire, voix, desktop | à venir     |

Détail et critères de sortie : [docs/ROADMAP.md](docs/ROADMAP.md).
