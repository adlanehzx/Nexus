# 01 — Monorepo & packages

## 1. Arborescence

```
nexus/
├── apps/
│   ├── api/                 Fastify — REST v1 + WS gateway + auth. Sans logique agent.
│   ├── worker/              BullMQ — exécute les AgentRun et les jobs longs.
│   ├── mobile/              Expo / React Native.
│   ├── desktop/             Tauri v2 + React (UI) + sidecar device-agent.
│   ├── web/                 Vite + React (optionnel, phase 5).
│   ├── device-agent/        Démon Node headless installé sur le PC.
│   └── browser-worker/      Python / FastAPI / browser-use. Hors pipeline TS.
├── packages/
│   ├── contracts/           Zod : DTO API, protocole WS, schémas d'outils. Source de vérité.
│   ├── config/              Chargement + validation d'env par zod. Zéro secret littéral.
│   ├── logger/              Pino, redaction, corrélation.
│   ├── telemetry/           OpenTelemetry : traces, métriques, coûts.
│   ├── errors/              Taxonomie d'erreurs, codes stables, mapping HTTP/WS.
│   ├── db/                  Prisma schema + client + repositories.
│   ├── llm/                 LLMProvider + adapters (anthropic, openai, local).
│   ├── voice/               STTProvider / TTSProvider + adapters.
│   ├── tools-core/          ToolDefinition, ToolRegistry, ToolExecutor, ToolResult.
│   ├── permissions/         PermissionService, risk levels, policies.
│   ├── tools-builtin/       Outils natifs (http, search, calendar, mail, memory, device, browser).
│   ├── mcp/                 Gestion des serveurs MCP → adaptateur ToolRegistry.
│   ├── browser-client/      Client typé du Browser Worker (HTTP + events).
│   ├── device-protocol/     Protocole WS device, partagé api ↔ device-agent.
│   ├── memory/              Assemblage de contexte, compaction, retrieval.
│   ├── agent-core/          Boucle, planner, budgets, politiques de reprise.
│   ├── sdk-client/          Client typé API + WS pour mobile/desktop/web.
│   ├── ui-tokens/           Design tokens partagés (couleurs, espacements, typo).
│   └── testing/             Fakes (LLM, tools, clock), factories, helpers d'intégration.
├── infra/
│   ├── compose/             docker-compose.{yml,prod.yml}, Caddyfile.
│   ├── docker/              Dockerfiles par app.
│   └── scripts/             migrate, seed, backup, restore, healthcheck.
├── docs/
├── turbo.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## 2. Règles de dépendance (vérifiées en CI)

Le graphe est **acyclique et orienté vers le bas**. Une règle enfreinte casse le build.

```
apps/*  ────────────► packages/*        autorisé
packages/agent-core ─► llm, tools-core, memory, contracts, errors, logger
packages/agent-core ─╳ db, mcp, browser-client, tools-builtin   INTERDIT
packages/tools-core ─╳ llm                                       INTERDIT
packages/*          ─╳ apps/*                                    INTERDIT
apps/api            ─╳ agent-core (runtime)                      INTERDIT
```

Trois interdictions méritent d'être justifiées :

- **`agent-core` ne dépend pas de `db`.** La boucle reçoit un port `AgentRunStore` ; l'implémentation
  Prisma vit dans `apps/worker`. C'est ce qui rend la boucle testable sans base de données et
  rejouable sur un état en mémoire.
- **`agent-core` ne connaît pas les outils concrets.** Il ne voit que des `ToolDefinition`.
  Ajouter un serveur MCP ne touche jamais le cœur agent (exigence explicite du cahier des charges).
- **`tools-core` ne dépend pas de `llm`.** Un outil n'est pas un concept LLM ; c'est une capacité
  décrite par un schéma. Le formatage vers le format de tool-calling d'un fournisseur est le rôle
  de l'adaptateur LLM.

Outillage : `eslint-plugin-boundaries` + un test `depcruise` en CI. La règle est du code, pas une
convention orale.

## 3. `@nexus/contracts` : la clef de voûte

Un seul endroit définit chaque forme de donnée qui traverse une frontière réseau, en Zod :

```ts
// esquisse conceptuelle, pas du code définitif
export const ToolCallSchema = z.object({ id, name, args: z.unknown() });
export const WsServerEvent = z.discriminatedUnion("type", [
  AgentTokenEvent,
  ToolStartedEvent,
  ConfirmationRequestedEvent /* ... */,
]);
export type WsServerEvent = z.infer<typeof WsServerEvent>;
```

Bénéfices : le mobile, le desktop, l'API, le worker et le device-agent partagent **les mêmes
types et la même validation runtime**. Le versionnement du protocole se fait ici, avec un champ
`v` dans chaque enveloppe. Le Browser Worker Python ne peut pas importer Zod : on génère pour lui
un JSON Schema depuis les mêmes définitions (`zod-to-json-schema`), et un test de contrat vérifie
que les deux côtés sont d'accord (→ [15-testing](15-testing.md)).

## 4. Build & CI

- **Turborepo** : pipeline `build → typecheck → lint → test → test:integration`, cache local et
  distant. `apps/browser-worker` est une tâche opaque (`uv` + `pytest`) branchée sur le même graphe.
- **TypeScript** : `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly`. Packages internes exportés en source TS (pas de build intermédiaire) via
  `publishConfig`/conditions d'export → itération rapide.
- **Versionnage** : Changesets, uniquement pour l'app mobile/desktop distribuée ; les packages
  internes restent en `workspace:*`.
