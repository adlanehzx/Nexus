# @nexus/devices

Modèle multi-appareils : registre, sélection, plans de tâches, routage
d'événements, sessions authentifiées.

**État : cœur implémenté et testé.** 67 tests. Les exécutants concrets (worker
Windows, automatisation Android, client iPhone) ne sont **pas** dans ce paquet —
ils se branchent dessus.

---

## Le principe

```
                    DeviceRegistry          « qui existe, que sait-il faire »
                          │
 TaskPlan ─▶ TaskCoordinator ─▶ DeviceSelector ─▶ WorkerTransport ─▶ worker
                    │              « lequel ? »
                    └──▶ EventRouter ─▶ tous les clients (origine en premier)

 capacité ─▶ createDeviceTools ─▶ ToolDefinition ─▶ ToolRegistry ─▶ Agent
```

**Le cœur ne connaît aucun appareil par son nom.** Il connaît des rôles, des
types et des capacités. « L'iPhone d'Alex » est une ligne en base, jamais un
`if`. Et il n'y a **pas de second système d'outils** : une capacité devient un
`ToolDefinition` ordinaire, comme le fait `@nexus/mcp`.

---

## Ajouter un appareil

Aucune modification de code. Trois écritures :

```ts
const device = await registry.registerDevice({
  userId,
  name: "Poste fixe", // libre, jamais lu par la logique
  type: "WINDOWS_PC",
  platform: "WINDOWS",
  role: "BOTH", // client ET exécutant
  capabilities: [
    {
      name: "terminal.execute",
      version: "1",
      description: "Shell",
      enabled: true,
      metadata: {},
    },
    { name: "git.execute", version: "1", description: "Git", enabled: true, metadata: {} },
  ],
  grantedPermissions: ["terminal.execute", "git.execute"],
});

// Il arrive OFFLINE et PENDING : la confiance se donne, elle ne se suppose pas.
await registry.trustDevice(device.id);
```

Puis l'appareil s'authentifie (voir plus bas) et envoie un battement de cœur.
Il devient éligible à la sélection dès lors qu'il est `ONLINE`, `TRUSTED` et
authentifié.

Pour l'exposer à l'agent, déclarer la capacité comme outil :

```ts
toolRegistry.registerAll(
  createDeviceTools({
    registry: deviceRegistry,
    selector,
    transport,
    specs: standardDeviceToolSpecs(),
  }),
);
```

---

## Rôle, type, capacité

| Axe          | Répond à              | Valeurs                                                                  |
| ------------ | --------------------- | ------------------------------------------------------------------------ |
| **Rôle**     | A-t-il le droit ?     | `CLIENT` · `WORKER` · `BOTH`                                             |
| **Type**     | Qu'est-ce que c'est ? | `IPHONE` · `ANDROID` · `WINDOWS_PC` · `MAC` · `LINUX` · `BROWSER_WORKER` |
| **Capacité** | Que sait-il faire ?   | `terminal.execute`, `filesystem.read`, `android.notification`…           |

Un `CLIENT` n'est jamais sélectionné comme exécutant, même s'il déclare la
capacité. Le rôle tranche avant la capacité.

Les capacités partagent l'espace de nommage des permissions (`domaine.action`).
Une capacité dit ce que l'appareil _sait_ faire, une permission ce que
l'utilisateur _autorise_ — il faut les deux.

---

## Sélection

`DeviceSelector` filtre puis note. Les filtres, dans l'ordre du diagnostic :
exclusions explicites, rôle, révocation, confiance, opérabilité, capacités,
permissions, saturation, contraintes (type, plateforme, alimentation secteur).

Chaque rejet est motivé — `selection.rejected` répond à « pourquoi cet appareil
n'apparaît-il pas ? » sans instrumenter le code.

Les survivants sont notés : préférence explicite (1000) ≫ disponibilité (300) >
santé (200) > latence (150) > secteur (100) > spécialisation (50). Une
préférence utilisateur écrase le classement, **jamais un filtre**.

---

## Plans de tâches

`TaskPlan` ≠ `AgentRun`. Le run décrit un raisonnement, le plan une exécution
répartie. Le graphe d'étapes est validé à la construction — identifiants
dupliqués, dépendances pendantes et cycles sont refusés immédiatement.

```ts
const plan = createTaskPlan({
  userId,
  title: "Cloner, tester, notifier",
  originClientDeviceId: iphone.id, // le fil de routage
  correlationId,
  steps: [
    {
      id: "clone",
      description: "Cloner le dépôt",
      requiredCapabilities: ["git.execute"],
      tool: "device.git.execute",
      arguments: { command: "clone …" },
    },
    {
      id: "test",
      description: "Lancer les tests",
      requiredCapabilities: ["terminal.execute"],
      tool: "device.terminal.execute",
      arguments: { command: "pnpm test" },
      dependsOn: ["clone"],
    },
    {
      id: "notify",
      description: "Notifier",
      requiredCapabilities: ["android.notification"],
      tool: "device.android.notification",
      arguments: { title: "Tests" },
      dependsOn: ["test"],
    },
  ],
});

await coordinator.execute(plan, { userPermissions });
```

Les étapes prêtes partent **en parallèle**. Une étape dont une dépendance a
échoué passe `skipped`, pas `failed` : elle n'a pas échoué, elle n'a jamais eu
lieu. Le plan finit alors `partial` — statut distinct, parce que « rien n'a
marché » et « deux étapes sur trois ont marché » n'appellent pas la même suite.

---

## Routage des événements

L'appareil d'origine reçoit **en premier** ; tous les autres clients de
l'utilisateur reçoivent ensuite. Un client déconnecté retrouve ses événements en
se rattachant :

```ts
const backlog = await router.attach({ deviceId, userId, send });
```

La file est **bornée** (200 par appareil). Au-delà, les plus anciens sont perdus :
un client absent depuis une semaine resynchronise son état complet plutôt que de
rejouer l'historique.

**Aucune synchronisation pair-à-pair.** Tout passe par le centre — c'est ce qui
garantit que deux clients ne divergent jamais.

---

## Sécurité

- **Un identifiant d'appareil n'authentifie rien.** Il est public. Une session
  naît d'un challenge signé Ed25519 :

  ```ts
  const challenge = await sessions.createChallenge(deviceId);
  const { session, token } = await sessions.authenticate(
    { deviceId, nonce: challenge.nonce, signature, capabilities },
    publicKeyMaterial,
  );
  // `token` n'est rendu qu'une fois ; seule son empreinte est stockée.
  ```

- Le nonce est consommé **même quand la signature est mauvaise** — sinon il reste
  rejouable.
- Les capacités négociées sont **bornées par celles déclarées** : une session ne
  peut pas s'octroyer plus que l'appareil.
- `assertNotReplayed(requestId, timestamp)` refuse les requêtes rejouées.
- Confiance ≠ statut. `PENDING` = en ligne, mais aucune tâche. `revokeTrust` est
  réversible, `revokeDevice` ne l'est pas.
- Les capacités sont **revérifiées juste avant le dispatch**.
- **Ne sont jamais journalisés** : mots de passe, clés d'API, cookies, jetons.
  Les enregistrements d'exécution passent les arguments par `redact`
  (`@nexus/shared`) ; les événements ne portent aucun argument.

---

## API

| Élément                     | Rôle                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `DeviceRegistry`            | Enregistrement, capacités, santé, confiance, battements de cœur             |
| `DeviceSelector`            | `select` · `trySelect` · `listEligible`                                     |
| `TaskCoordinator`           | Exécute un `TaskPlan` : sélection, confirmation, dispatch, reprise, bascule |
| `EventRouter`               | `attach` · `detach` · `emit` · `publish` · `sendTo` · `pendingFor`          |
| `DeviceSessionService`      | Challenge, authentification, rotation, révocation, anti-rejeu               |
| `createDeviceTools`         | Capacité → `ToolDefinition` pour le `ToolRegistry`                          |
| `DeviceStore` · `TaskStore` | Ports de persistance (implémentations mémoire fournies)                     |

---

## Diagnostic

| Symptôme                       | Cause probable                                             |
| ------------------------------ | ---------------------------------------------------------- |
| `NoEligibleWorkerError`        | Lire `rejected` : le motif y est, appareil par appareil    |
| L'appareil n'est jamais choisi | `trust` encore `PENDING`, ou `authenticated: false`        |
| Il passe hors ligne tout seul  | Aucun battement de cœur depuis `heartbeatTimeoutMs` (60 s) |
| Un client ne reçoit rien       | Rôle `WORKER` : il n'est pas destinataire d'événements     |
| Le plan finit `partial`        | Une étape a échoué, ses dépendantes sont `skipped`         |
