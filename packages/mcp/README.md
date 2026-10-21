# @nexus/mcp

Connexion aux serveurs MCP et adaptation de leurs outils vers le `ToolRegistry`.

**État : implémenté et testé.** 35 tests, dont un vrai serveur MCP en processus
enfant (spawn, isolation d'environnement, crash, reconnexion).

---

## Le principe

```
Serveur MCP  ─▶  McpClient  ─▶  McpToolAdapter  ─▶  ToolRegistry  ─▶  Agent
   (SDK)        (SDK + délais,   (JSON Schema,      (ToolDefinition
                 secrets,         permissions,       ordinaire)
                 erreurs)         risque)
```

**Le cœur agent ne connaît pas MCP.** Il voit des `ToolDefinition` : même
contrat, mêmes permissions, mêmes confirmations, même exécuteur. Ajouter un
serveur MCP ne touche pas une ligne d'`agent-core` (ADR-005).

Le protocole n'est pas réimplémenté : c'est le SDK officiel
`@modelcontextprotocol/sdk` qui parle MCP, des deux côtés — y compris dans les
tests, où un vrai `McpServer` répond à notre vrai `Client`.

---

## Ajouter un nouveau serveur MCP

### 1. Le cas le plus simple : une configuration

```ts
import { McpManager, parseMcpServerConfig } from "@nexus/mcp";

const config = parseMcpServerConfig({
  name: "meteo", // minuscules, chiffres, tirets — préfixe les outils
  transport: "stdio",
  command: "npx",
  args: ["-y", "@exemple/mcp-server-meteo"],
  env: { REGION: "eu" }, // valeurs non sensibles
  envRefs: { API_KEY: "vault://meteo" }, // secrets : références seulement
  defaultPermissions: ["meteo.read"],
});

const manager = new McpManager({ registry, configs: [config] });
await manager.start();
```

Les outils apparaissent alors sous `mcp.meteo.<nom>` et sont immédiatement
utilisables par l'agent — **à condition que l'utilisateur ait accordé les
permissions déclarées**.

### 2. Régler la politique de permission

Par défaut, tout outil découvert arrive en **`MEDIUM`**, donc avec confirmation
à chaque appel. C'est volontaire : un serveur MCP tiers est du code non audité
dont on ne sait pas ce qu'il fait.

Rendre un serveur agréable au quotidien consiste donc à **déclasser
explicitement** ce qui est inoffensif :

```ts
{
  defaultPermissions: ["meteo.read"],
  defaultRisk: "MEDIUM",
  toolPolicies: {
    get_forecast: { risk: "SAFE", permissions: ["meteo.read"] },
    get_alerts:   { risk: "SAFE", permissions: ["meteo.read"] },
    subscribe:    { risk: "HIGH", permissions: ["meteo.write"] },
    debug_dump:   { disabled: true },   // retiré du registre
  },
}
```

| Champ                  | Effet                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `risk`                 | Niveau final. **Seule** façon d'abaisser le risque d'un outil MCP    |
| `permissions`          | Permissions exigées ; sans elles, l'outil n'est pas montré au modèle |
| `requiresConfirmation` | Force ou lève la confirmation, indépendamment du risque              |
| `timeoutMs`            | Délai propre à cet outil                                             |
| `disabled`             | Exclut l'outil du registre                                           |

### 3. Partir d'un preset

Deux configurations éprouvées sont fournies, avec leur politique déjà écrite :

```ts
import { githubPreset, filesystemPreset } from "@nexus/mcp";

githubPreset({ tokenRef: "vault://github" }); // lecture seule
githubPreset({ tokenRef: "vault://github", allowWrite: true }); // + écritures confirmées

filesystemPreset({ roots: ["/workspace/project"] }); // read-only
```

Elles servent aussi de modèle : la façon la plus rapide d'écrire une politique
pour un nouveau serveur est de copier `src/presets.ts` et d'adapter la liste.

### 4. Transports distants

```ts
{ name: "distant", transport: "http", url: "https://mcp.exemple.com/v1",
  headerRefs: { Authorization: "vault://mcp-distant" } }
```

`http` utilise le transport Streamable HTTP du SDK, `sse` l'ancien transport SSE.

---

## Sécurité

| Règle                          | Mise en œuvre                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aucun secret journalisé        | `describeConfig()` ne rend que les **clés** d'`env`/`headers`, jamais les valeurs. Testé.                                                                                                                                       |
| Credentials isolés             | Les secrets arrivent par `envRefs`/`headerRefs`, résolus au lancement via le coffre. Ils ne sont ni stockés dans la configuration, ni vus par le modèle.                                                                        |
| Aucun héritage d'environnement | Le processus enfant reçoit `getDefaultEnvironment()` + ce qu'on lui donne. Les variables du backend ne fuitent pas. **Testé avec un vrai processus.**                                                                           |
| Descriptions non fiables       | La description d'un outil vient d'un tiers et finit dans le prompt : elle est bornée, ses chevrons neutralisés, et sa provenance annoncée.                                                                                      |
| Annotations non fiables        | `destructiveHint` peut **élever** le risque ; `readOnlyHint` ne peut jamais l'abaisser. Le SDK lui-même prévient : _« Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers. »_ |
| Validation des arguments       | Les entrées sont validées contre le JSON Schema **du serveur**, avec le même validateur que lui (`@cfworker/json-schema`) — même verdict des deux côtés.                                                                        |
| Pas de rejeu aveugle           | Un outil n'est réessayé automatiquement que si un humain l'a classé `SAFE` ou `LOW`.                                                                                                                                            |
| Délais                         | `connectTimeoutMs` au handshake, `requestTimeoutMs` (ou par outil) à l'appel.                                                                                                                                                   |

---

## Quand un serveur tombe

C'est le cas nominal, pas l'exception :

1. **Déconnexion détectée** → événement `server.disconnected`.
2. **Reconnexion automatique**, backoff exponentiel plafonné, jusqu'à
   `maxReconnectAttempts`. Les outils sont republiés au retour.
3. **Pendant l'indisponibilité**, un appel échoue avec `MCP_SERVER_UNAVAILABLE` :
   erreur _exploitable_ — retryable, avec un message qui dit à l'agent quoi faire.
4. **Après `circuitBreakerThreshold` échecs**, le disjoncteur s'ouvre et les
   outils **quittent le registre** : décrire au modèle un outil qui échouera à
   coup sûr gaspille du contexte et l'invite à réessayer.
5. **Après `circuitBreakerResetMs`**, le circuit se referme et une nouvelle
   tentative est permise. `manager.reconnect(nom)` force le passage.

À aucun moment l'agent ne plante, et les autres serveurs ne sont pas affectés.

---

## API

```ts
await manager.start(); // connecte tout, publie les outils
await manager.addServer(config); // à chaud, sans redémarrage
await manager.removeServer("github");
await manager.refreshToolList("github"); // re-découvre le catalogue
await manager.reconnect("github"); // force, réarme le disjoncteur
await manager.stop(); // arrêt gracieux

manager.health(); // état de tous les serveurs
manager.healthOf("github");
manager.toolNames("github");
manager.describe(); // configuration sans aucune valeur sensible
```

`health()` renvoie `status`, `toolCount`, `lastError`, `consecutiveFailures`,
`reconnectAttempts`, `circuitOpenUntil`, `serverInfo`.

Événements : `server.connected`, `server.disconnected`, `server.failed`,
`server.circuit_opened`, `server.circuit_closed`, `tools.registered`,
`tools.unregistered`.

---

## Ressources

Une ressource MCP est un contenu adressable par URI. Le cœur agent ne connaît
qu'une façon d'obtenir quelque chose du monde — appeler un outil. Les ressources
sont donc exposées comme deux outils de lecture (`SAFE`) :

- `mcp.<serveur>.resources.list`
- `mcp.<serveur>.resources.read`

Désactivable par `exposeResources: false`.

---

## Diagnostic

| Symptôme                        | Cause probable                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `status: "failed"` au démarrage | commande introuvable, ou le serveur quitte immédiatement — voir `lastError`       |
| Outils absents du registre      | permissions non accordées (ils ne sont pas _montrés_), ou `disabled` en politique |
| Confirmation à chaque appel     | risque `MEDIUM` par défaut : déclasser les outils de lecture dans `toolPolicies`  |
| `MCP_SCHEMA_UNSUPPORTED`        | schéma d'entrée inexploitable ; l'outil est écarté, le serveur reste utilisable   |
| `status: "circuit_open"`        | trop d'échecs consécutifs ; `reconnect()` pour forcer                             |
