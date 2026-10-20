# 17 — Système MCP (implémenté)

Décrit le sous-système **tel qu'il est construit**. Le document
[04 — Outils & MCP](04-tools-mcp.md) en pose la conception ; celui-ci fait foi
pour le code. Paquet : [`@nexus/mcp`](../../packages/mcp).

## 1. Chaîne

```
Serveur MCP ─▶ McpClient ─▶ McpToolAdapter ─▶ ToolRegistry ─▶ Agent
                                └▶ McpResourceAdapter ─┘
                    ▲
                McpManager  (cycle de vie, santé, reconnexion, disjoncteur)
```

`agent-core` ne dépend pas de `@nexus/mcp` — la règle de dépendance du monorepo
l'interdit. Le lien se fait par le `ToolRegistry` : le gestionnaire y dépose des
`ToolDefinition`, le cœur agent les consomme sans savoir d'où elles viennent.

## 2. Le protocole n'est pas réimplémenté

`@modelcontextprotocol/sdk` fait tout le travail protocolaire : handshake,
cadrage JSON-RPC, schémas, transports stdio / Streamable HTTP / SSE.
`McpClient` est une enveloppe qui ajoute quatre choses, et rien d'autre :

- les délais (`connectTimeoutMs`, `requestTimeoutMs`) ;
- la traduction des erreurs vers la taxonomie `AppError` du projet ;
- la résolution des secrets au lancement ;
- la remontée des ruptures de connexion au gestionnaire.

Les tests utilisent le SDK **des deux côtés** : un vrai `McpServer` répond à
notre vrai `Client`, relié soit par `InMemoryTransport.createLinkedPair()`, soit
par un vrai processus enfant en stdio.

## 3. Validation : JSON Schema, pas une traduction

Un serveur MCP déclare ses entrées en JSON Schema. Deux options existaient :
traduire en Zod, ou valider contre le schéma d'origine.

Nous validons contre l'original, avec `@cfworker/json-schema` — le validateur
qu'utilise déjà le SDK. Conséquence : **le même verdict des deux côtés**. Une
traduction, toujours partielle, aurait fini par accepter ce que le serveur
refuse, ou l'inverse.

Le schéma d'origine est aussi ce qui est décrit au modèle, via le champ
`ToolDefinition.inputJsonSchema` ajouté pour l'occasion. Le planificateur le
préfère au schéma dérivé de Zod quand il est présent.

## 4. Le risque ne descend jamais tout seul

Deux règles, dans cet ordre :

1. **Une politique humaine fait autorité.** C'est le seul moyen d'abaisser le
   risque d'un outil MCP.
2. À défaut, on part de `MEDIUM` et les annotations du serveur ne peuvent
   qu'**élever** : `destructiveHint` monte à `HIGH`, `openWorldHint` maintient
   `MEDIUM`, et `readOnlyHint` ne descend rien.

Le SDK MCP formule lui-même la raison : _« Clients should never make tool use
decisions based on ToolAnnotations received from untrusted servers. »_ Un test
couvre le cas explicite d'un serveur qui se déclare `readOnlyHint: true` **et**
`destructiveHint: true` — c'est `HIGH` qui l'emporte.

Corollaire sur les reprises : un outil MCP n'est réessayé automatiquement que
si un humain l'a classé `SAFE` ou `LOW`. `idempotentHint` n'est pas cru.

## 5. Panne d'un serveur

| Étape                     | Comportement                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Déconnexion               | Événement, puis reconnexion automatique avec backoff exponentiel plafonné                             |
| Pendant l'indisponibilité | `MCP_SERVER_UNAVAILABLE` — retryable, message actionnable pour l'agent                                |
| Après N échecs            | Disjoncteur ouvert : les outils **quittent le registre**                                              |
| Après le délai de reset   | Circuit refermé, nouvelle tentative permise                                                           |
| Au démarrage              | Les serveurs sont connectés en parallèle et indépendamment ; un serveur mort n'empêche pas les autres |

Un garde interne (`connecting`) empêche qu'un échec de connexion **initiale**
déclenche la boucle de reconnexion en parallèle de `start()` : sans lui, l'état
de santé renvoyé au démarrage était indéterministe. C'est un défaut trouvé par
les tests, pas anticipé.

## 6. Secrets

Les valeurs sensibles n'apparaissent jamais dans la configuration : seules des
**références** (`envRefs`, `headerRefs`) y figurent, résolues au lancement via le
coffre. `describeConfig()` ne rend que les clés.

Sur l'installation locale, le coffre est le trousseau de session Linux via
`secret-tool`. Le dashboard envoie une valeur en écriture seule puis ne reçoit
plus que le nom de sa référence. Le gestionnaire MCP, le registre d'outils et la
configuration JSON sont créés au démarrage de l'API ; ajouter, reconnecter ou
retirer un serveur depuis NEXUS ne demande donc aucun redémarrage.

Le processus enfant ne reçoit que `getDefaultEnvironment()` (PATH, HOME…) plus
ce qu'on lui donne explicitement. Aucune variable du backend n'est héritée — un
test le vérifie avec un vrai processus et une variable piégée.

## 7. Écarts avec le document 04

| Point                | Doc 04                       | Implémentation                                   | Pourquoi                                                                                               |
| -------------------- | ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Risque par défaut    | `CONFIRM`                    | `MEDIUM`                                         | L'échelle est passée à cinq niveaux ([16](16-agent-core.md) §2) ; `MEDIUM` en est l'équivalent         |
| Traduction du schéma | JSON Schema → Zod            | Validation contre le JSON Schema d'origine       | Une traduction partielle diverge du serveur (§3)                                                       |
| Ressources           | Non traitées                 | Exposées comme deux outils `SAFE`                | Le cœur agent ne connaît que les outils                                                                |
| Isolation            | Conteneur `mcp-runner` dédié | Isolation d'environnement au niveau du processus | Le conteneur reste prévu pour le déploiement (phase 5 infra) ; l'isolation d'environnement est déjà là |

## 8. Ajouter un serveur

Procédure, politique de permission, presets, transports distants et diagnostic :
[`packages/mcp/README.md`](../../packages/mcp/README.md).
