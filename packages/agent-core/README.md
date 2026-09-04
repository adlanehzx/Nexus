# @nexus/agent-core

Moteur d'agent : reçoit une demande utilisateur, produit une réponse finale, en
utilisant dynamiquement les outils disponibles — sous permissions.

**État : implémenté et testé.** 43 tests dans ce paquet, 37 dans `@nexus/tools`.

---

## Le contrat en une phrase

> Le modèle ne peut rien faire d'autre qu'émettre du texte et **demander**
> l'exécution d'un outil. Un appel d'outil ne provient jamais que d'un bloc
> structuré renvoyé par le fournisseur — aucun texte n'est analysé pour en
> déduire une action.

## Pièces

| Pièce               | Rôle                                                              | Fichier               |
| ------------------- | ----------------------------------------------------------------- | --------------------- |
| `AgentOrchestrator` | Cycle de vie : créer, reprendre, annuler, tracer                  | `src/orchestrator.ts` |
| `AgentLoop`         | La boucle elle-même : observer → raisonner → autoriser → exécuter | `src/loop.ts`         |
| `AgentContext`      | Ce que le modèle voit : système, souvenirs, transcript            | `src/context.ts`      |
| `AgentState`        | État sérialisable d'un run — la base de la suspension             | `src/state.ts`        |
| `Planner`           | Traduit l'état en appel LLM, et la réponse en décision typée      | `src/planner.ts`      |
| `ExecutionPolicy`   | Budgets et garde-fous, sous forme de **données**                  | `src/policy.ts`       |
| `AgentRunStore`     | Port de persistance (implémentation mémoire fournie)              | `src/store.ts`        |
| `AgentEventEmitter` | Trace en direct : itérations, outils, confirmations               | `src/events.ts`       |
| `redact`            | Masquage des secrets avant toute journalisation                   | `src/redaction.ts`    |

Le plan de capacité — `ToolRegistry`, `ToolExecutor`, `PermissionService`,
`ConfirmationService`, `ToolDefinition` — vit dans [`@nexus/tools`](../tools).
`agent-core` ne dépend ni de la base de données, ni de MCP, ni d'un SDK de
fournisseur (ADR-003, ADR-004).

## Boucle

```
        ┌──────────────────────────────────────────────────────────┐
        ▼                                                          │
  gardes ─▶ raisonner ─▶ décision ─┬─ réponse finale ─▶ COMPLETED   │
  budget    (LLM)                  │                               │
  délai                            └─ appels d'outils              │
  annulation                              │                        │
  échecs                                  ▼                        │
                                    résoudre l'outil                │
                                    valider les arguments (Zod)     │
                                    anti-boucle                     │
                                    PermissionService               │
                                      ├─ DENY    ─▶ observation ────┤
                                      ├─ CONFIRM ─▶ WAITING_FOR_    │
                                      │            CONFIRMATION     │
                                      │            (worker libéré)  │
                                      └─ ALLOW   ─▶ ToolExecutor ───┘
                                                   timeout · retry ·
                                                   backoff · validation
```

**Un échec n'est pas un plantage.** Outil inconnu, arguments invalides,
permission refusée, exécution ratée, sortie non conforme : tout redevient une
observation que le modèle traite au tour suivant. La boucle ne s'arrête que sur
un budget épuisé, une annulation, ou une panne du fournisseur.

## États

`pending → running → { completed | incomplete | failed | cancelled }`,
avec `waiting_for_confirmation` comme état réel entre les deux.

`incomplete` est de première classe : quand un budget s'épuise, l'agent **doit**
dire ce qu'il a fait et ce qui reste. Un agent qui s'arrête en silence est un
défaut produit, pas un cas limite.

`stopReason` précise : `final_answer`, `max_iterations`, `max_tool_calls`,
`global_timeout`, `tool_failure_limit`, `cancelled`, `confirmation_rejected`,
`confirmation_expired`, `provider_error`, `internal_error`.

## Utilisation

```ts
import { AgentOrchestrator } from "@nexus/agent-core";
import { AnthropicProvider } from "@nexus/llm/anthropic";
import { PermissionService, StaticGrantProvider, ToolRegistry } from "@nexus/tools";

const registry = new ToolRegistry().register(weatherTool).register(emailTool);

const orchestrator = new AgentOrchestrator({
  llm: new AnthropicProvider({ model: "claude-opus-5", effort: "high" }),
  registry,
  permissions: new PermissionService({
    grants: new StaticGrantProvider(["calendar.read", "email.send"]),
    autoApproveMaxRisk: "LOW",
  }),
  policy: { maxIterations: 8, globalTimeoutMs: 120_000 },
});

orchestrator.on((event) => logger.info(event));

const { record, confirmation } = await orchestrator.run({
  userId: "user-1",
  conversationId: "conv-1",
  message: "Regarde mes emails et dis-moi lesquels sont importants",
});

if (record.status === "waiting_for_confirmation") {
  // `confirmation` porte l'aperçu exact à montrer à l'utilisateur.
  const resumed = await orchestrator.resume(record.runId, "approved");
}
```

### Annuler en vol

Le `runId` est publié par l'événement `run.started`, émis **avant** que `run()`
ne rende la main, et l'état est persisté dès ce moment :

```ts
orchestrator.on((e) => {
  if (e.type === "run.started") currentRunId = e.runId;
});
await orchestrator.cancel(currentRunId);
```

## Observabilité

Chaque run produit un `AgentRunRecord` :

```ts
{
  runId, userId, conversationId, correlationId,
  startTime, endTime, status, stopReason, iterations,
  toolsUsed: [{ name, riskLevel, status, durationMs, attempts, input, errorCode }],
  errors:    [{ at, code, message, iteration }],
  usage:     { inputTokens, outputTokens },
  model, response,
}
```

**Aucun secret n'y figure.** Les arguments d'outil passent par `redact()` avant
d'entrer dans la trace comme dans les événements : masquage par nom de clé
(`password`, `apiKey`, `authorization`…) **et** par forme de valeur (`sk-…`,
`ghp_…`, JWT), parce qu'un secret finit toujours par se retrouver dans un champ
innocemment nommé.

## Budgets

| Garde-fou                    | Défaut                           | Au dépassement                      |
| ---------------------------- | -------------------------------- | ----------------------------------- |
| `maxIterations`              | 12                               | `incomplete` + synthèse             |
| `globalTimeoutMs`            | 180 000                          | `incomplete`                        |
| `maxToolCalls`               | 25                               | `incomplete`                        |
| `maxConsecutiveToolFailures` | 3                                | `incomplete`                        |
| `maxIdenticalToolCalls`      | 2                                | appel refusé, observation explicite |
| `defaultToolTimeoutMs`       | 30 000                           | `TOOL_TIMEOUT`, réessayable         |
| `retry`                      | 3 tentatives, backoff ×2, jitter | échec définitif                     |
| `autoApproveMaxRisk`         | `LOW`                            | au-dessus : confirmation            |

Le temps passé à attendre une confirmation est **rendu au budget** : le délai
global mesure le travail de l'agent, pas la réflexion de l'utilisateur.

## Ce qui est testé

Le modèle est la seule frontière remplacée (`ScriptedLLMProvider`), plus
l'horloge de backoff — enregistrée, jamais attendue. Registre, permissions,
confirmations, exécuteur, boucle et magasin d'états s'exécutent réellement.

réponse simple · appel d'outil · appels multiples (même tour et sur plusieurs
itérations) · échec d'outil · sortie non conforme · limite d'échecs consécutifs ·
retry avec backoff exponentiel · pas de retry sur échec définitif · pas de retry
sur outil non idempotent · délai d'outil imposé à un outil qui ignore son signal ·
délai global · annulation en vol · annulation d'un run suspendu · permission
refusée · joker de domaine · filtrage des outils exposés au modèle · confirmation
demandée / acceptée / refusée · CRITICAL toujours confirmé · confirmation
dépendante des arguments · empreinte des arguments (anti « bait and switch ») ·
expiration · max iterations · max tool calls · anti-boucle · arguments malformés ·
outil inventé · panne du fournisseur · rédaction des secrets.

## Ce qui n'est pas encore là

- **Persistance durable** : `InMemoryAgentRunStore` est réel et complet, mais un
  redémarrage perd les runs. L'implémentation Prisma arrive avec `services/agent`
  et ne touchera pas la boucle — c'est tout l'intérêt du port.
- **Streaming vers le client** : `LLMProvider.stream()` existe et l'adaptateur
  Anthropic l'implémente ; la boucle utilise `generate()`. Le branchement sur le
  WebSocket est en phase 1.
- **Compaction du contexte** : phase 6.
- **Écriture en mémoire longue** : le rappel (`memory.search`) est câblé ;
  l'extraction post-run est en phase 6.
