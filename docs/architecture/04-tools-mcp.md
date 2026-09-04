# 04 — Système d'outils & MCP

## 1. `ToolDefinition` — le contrat unique

Tout ce qui peut agir sur le monde est un outil, décrit par la même structure, quelle que soit
son implémentation (natif, MCP, browser, device, HTTP).

```ts
interface ToolDefinition<I = unknown, O = unknown> {
  name: string; // 'mail.send' — namespacé, stable, unique
  version: string; // semver ; le prompt voit la version majeure
  title: string; // libellé UI
  description: string; // pour le LLM : quand l'utiliser ET quand ne pas
  inputSchema: ZodType<I>; // validé avant exécution, toujours
  outputSchema: ZodType<O>; // validé après exécution, toujours
  permissions: PermissionKey[]; // ex. ['mail:send']
  riskLevel: "SAFE" | "CONFIRM" | "CRITICAL";
  requiresConfirmation: boolean | ((input: I, ctx: ToolContext) => boolean);
  idempotent: boolean;
  sideEffects: "none" | "local" | "external" | "irreversible";
  timeoutMs: number;
  retry: { attempts: number; backoff: "exp" | "none" };
  costHint?: { unit: "call" | "token" | "usd"; value: number };
  fallbackTool?: string;
  redact?: (io: unknown) => unknown; // avant log/persistance
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
```

`requiresConfirmation` accepte une fonction : `fs.write` sur `~/scratch/note.md` n'a pas le même
risque que sur `/etc/hosts`, et `mail.send` à soi-même n'a pas le même risque qu'à une liste de
diffusion. **Le risque dépend des arguments, pas seulement de l'outil** — c'est l'une des rares
subtilités qu'il ne faut pas simplifier.

```ts
type ToolResult<O> =
  | { ok: true; output: O; artifacts?: Artifact[]; summaryForModel: string; metrics: Metrics }
  | { ok: false; error: ToolError; partial?: unknown; summaryForModel: string };
```

`summaryForModel` est distinct de `output` : le modèle reçoit une projection bornée (≤ ~2 k
tokens) pendant que l'output complet est persisté comme artefact consultable. C'est ce qui
empêche un `fs.read` de 3 Mo de faire exploser le contexte.

## 2. `ToolRegistry`

```ts
interface ToolRegistry {
  register(source: ToolSource): void; // natif | mcp | browser | device | http
  listFor(ctx: UserContext): ToolDefinition[]; // filtré par grants ET par contexte
  get(name: string, version?: string): ToolDefinition | undefined;
  onChange(cb): Unsubscribe; // hot-reload MCP
}
```

Le registre est alimenté par des **ToolSource**. Ajouter une capacité = ajouter une source ;
le cœur agent ne change jamais.

```
ToolSource
├── BuiltinToolSource      outils natifs TS
├── McpToolSource          1 par serveur MCP, découverte dynamique
├── BrowserToolSource      expose browser.* (proxy vers le worker Python)
├── DeviceToolSource       expose device.* (proxy vers le Device Agent connecté)
└── HttpToolSource         outils déclarés en YAML depuis une spec OpenAPI
```

`listFor` filtre **deux fois** : par grants de permission, et par pertinence contextuelle (les
outils `device.*` n'apparaissent que si un device est en ligne). Un outil qu'on ne veut pas voir
utilisé n'est pas décrit au modèle — c'est la défense la plus efficace, bien avant le prompt.

## 3. `ToolExecutor` — la frontière d'exécution

Pipeline unique, sans chemin de contournement :

```
1.  resolve       registry.get(name) → sinon ToolNotFound (observation, pas crash)
2.  validate      inputSchema.parse(args) → sinon ValidationError renvoyée au modèle
3.  authorize     PermissionService.check(user, tool, args, ctx)
4.  confirm       si requis : Confirmation persistée → suspension du run
5.  idempotency   clé (runId, stepIndex, tool, hash(args)) → si déjà exécuté : rejoue le résultat
6.  persist       ToolExecution(status=RUNNING) — AVANT l'appel, pas après
7.  execute       AbortSignal + timeout + retry + circuit breaker par source
8.  validate out  outputSchema.parse → sinon ToolExecutionError(phase='output')
9.  redact        secrets ôtés avant log/persistance
10. persist       ToolExecution(status, output, metrics, cost)
11. summarize     projection bornée pour le modèle + artefacts
12. emit          tool.started / tool.progress / tool.result sur le WS
```

L'étape 6 avant l'appel est délibérée : si le worker meurt pendant un `mail.send`, on doit savoir
au redémarrage qu'une exécution était en vol, et ne pas la rejouer aveuglément.

**Circuit breaker par source** : si un serveur MCP échoue 5 fois de suite, sa source est ouverte
60 s, ses outils disparaissent de `listFor`, et l'agent en est informé. Un MCP défaillant ne doit
pas dégrader tout l'assistant.

## 4. Catalogue d'outils v1

| Outil                           | Risque                               | Confirmation          | Notes                                    |
| ------------------------------- | ------------------------------------ | --------------------- | ---------------------------------------- |
| `search.web`                    | SAFE                                 | non                   | provider externe                         |
| `http.request`                  | CONFIRM                              | GET non / autres oui  | allowlist de domaines                    |
| `weather.get`                   | SAFE                                 | non                   |                                          |
| `calendar.list`                 | SAFE                                 | non                   | Google Calendar OAuth                    |
| `calendar.create` / `.update`   | CONFIRM                              | oui                   |                                          |
| `calendar.delete`               | CONFIRM → CRITICAL si récurrent      | oui                   |                                          |
| `mail.list` / `mail.read`       | SAFE                                 | non                   | lecture seule                            |
| `mail.send`                     | CONFIRM                              | oui                   | aperçu complet obligatoire dans la carte |
| `memory.search` / `.write`      | SAFE                                 | non                   |                                          |
| `device.fs.read`                | SAFE                                 | non                   | jail de chemins par device               |
| `device.fs.write`               | CONFIRM                              | oui                   | diff affiché                             |
| `device.fs.delete`              | CRITICAL                             | oui                   |                                          |
| `device.shell.exec`             | CONFIRM                              | oui                   | classifieur de commande (§09)            |
| `device.process.list` / `.kill` | SAFE / CONFIRM                       | selon                 |                                          |
| `github.*`                      | SAFE en lecture, CONFIRM en écriture | oui                   | push, PR, merge                          |
| `browser.act`                   | CONFIRM                              | oui si action mutante | voir [05](05-browser-use.md)             |
| `payment.*`                     | CRITICAL                             | double                | **hors v1**                              |

## 5. MCP

### Ce qu'est MCP ici

MCP est **une source d'outils parmi d'autres**, pas le modèle d'intégration central. On adopte son
protocole pour bénéficier de l'écosystème sans y adosser l'architecture — si MCP évolue ou si un
serveur est indisponible, seul l'adaptateur bouge (→ [ADR-005](../adr/ADR-005-mcp-as-adapter.md)).

### `McpManager`

```
McpManager
├── charge la config déclarative (table McpServer, éditable dans Settings)
├── lance / connecte chaque serveur : stdio (process enfant) ou HTTP/SSE (distant)
├── supervise : healthcheck, restart avec backoff, circuit breaker
├── découvre tools / resources / prompts → mappe en ToolDefinition
└── traduit : JSON Schema MCP → Zod, erreurs MCP → ToolError
```

### Mapping et sécurité

- **Namespacing** : `mcp.{serverSlug}.{toolName}`. Deux serveurs peuvent exposer `search` sans
  collision.
- **Risque par défaut** : un outil MCP découvert dynamiquement arrive en `CONFIRM`. Le passer en
  `SAFE` est une décision humaine explicite, stockée en base, jamais déduite d'une description.
  Un serveur MCP tiers est du code non audité : sa `description` est une **entrée non fiable**
  susceptible de porter une injection de prompt (→ [09-security](09-security-permissions.md) §7).
- **Isolation** : serveurs stdio lancés dans un conteneur dédié, sans accès réseau par défaut, avec
  un environnement minimal — aucune variable d'env du backend n'est héritée.
- **Hot reload** : ajouter un serveur MCP depuis l'app ne redémarre pas le backend ;
  `registry.onChange` propage aux runs suivants, pas aux runs en cours (reproductibilité).

## 6. Outils HTTP déclaratifs

Pour les APIs externes simples, écrire du TypeScript est du bruit. Un outil peut être déclaré :

```yaml
name: flights.search
description: Recherche de vols entre deux villes à une date.
risk: SAFE
auth:
  type: apiKey
  secretRef: FLIGHT_API_KEY # référence au coffre, jamais la valeur
request:
  method: GET
  url: https://api.example.com/v1/search
input: { from: string, to: string, date: string }
output: { flights: [{ carrier, price, departAt }] }
```

Compilé en `ToolDefinition` au démarrage, avec les mêmes garanties (validation, permissions,
timeout, audit). `secretRef` pointe vers le coffre — la clef n'est ni dans le YAML ni en base
en clair.
