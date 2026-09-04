# @nexus/windows-worker

Exécutant Windows : capacités locales contrôlées, connexion **sortante** vers le
cœur NEXUS.

**État : implémenté et testé.** 190 tests, sans qu'aucun processus ne soit lancé
ni aucun fichier écrit sur la machine du développeur.

Le même binaire tourne sur le portable et sur le poste fixe. Rien dans ce paquet
ne sait sur laquelle des deux il s'exécute.

---

## Le principe

```
Worker Windows ──(WebSocket sortant)──▶ NEXUS Core
                                          │
                                    WorkerGateway  (implémente WorkerTransport)
                                          │
                              TaskCoordinator ◀── DeviceSelector
                                          │
                                       Agent
```

Le sens de la flèche est la décision d'architecture centrale. **Le worker appelle
le cœur ; le cœur ne sait pas joindre une machine Windows.** Il répond sur une
connexion déjà ouverte.

Conséquences directes :

- aucune redirection de port, aucun port entrant, aucune machine exposée ;
- un worker derrière une box, un VPN d'entreprise ou un partage de connexion
  mobile fonctionne sans configuration réseau ;
- aucun client ne parle jamais à un worker : tout passe par le centre.

---

## Il n'existe pas de `execute(command: string)`

C'est la propriété que tout ce paquet défend, et un test échoue si elle
disparaît. L'API est structurée :

```jsonc
// terminal.execute
{
  "executable": "git",
  "args": ["status", "--porcelain"],
  "workingDirectory": "C:\\Projets\\leynai",
}
```

Trois raisons cumulatives :

1. un exécutable choisi dans une liste ne peut pas être remplacé au moyen d'un
   `;` ou d'un `&&` ;
2. des arguments passés en tableau ne sont jamais réinterprétés — `; rm -rf .`
   transmis à `git` est un argument absurde, pas une commande ;
3. `spawn` est appelé avec `shell: false`, donc il n'y a ni expansion de
   variables, ni substitution de commande, ni glob.

**La sécurité vient de la forme de l'API, pas d'un filtre sur des chaînes.** Un
filtre se contourne ; une API qui n'accepte pas de ligne de commande, non.

---

## Installation

```powershell
# 1. Générer la paire de clés de l'appareil. La clé privée ne quitte jamais la machine.
openssl genpkey -algorithm ed25519 -out C:\ProgramData\NEXUS\nexus-device.key
openssl pkey -in C:\ProgramData\NEXUS\nexus-device.key -pubout -out nexus-device.pub

# 2. Restreindre l'accès à la clé au seul compte qui exécute le worker.
icacls C:\ProgramData\NEXUS\nexus-device.key /inheritance:r /grant:r "$env:USERNAME:(R)"

# 3. Enregistrer l'appareil côté cœur, avec la clé PUBLIQUE, et l'approuver.
#    C'est le backend qui attribue DEVICE_ID, le rôle et les permissions.

# 4. Configurer le worker.
cp .env.example .env   # puis renseigner

# 5. Installer et lancer.
pnpm install
pnpm --filter @nexus/windows-worker build
pnpm --filter @nexus/windows-worker start
```

`.env.example` ne contient que des marqueurs — un test le vérifie. La clé privée
y est désignée par un **chemin**, jamais par sa valeur : une clé dans une
variable d'environnement finit dans l'historique du shell, dans les journaux de
l'ordonnanceur et dans les rapports de plantage.

---

## Configuration

| Variable                       | Rôle                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `NEXUS_BACKEND_URL`            | Cœur NEXUS. Une adresse distante **doit** être en `wss://` — le worker refuse de démarrer sinon |
| `DEVICE_ID`                    | Attribué à l'appairage. Public : il n'authentifie rien                                          |
| `DEVICE_CREDENTIAL_PATH`       | Chemin vers la clé privée Ed25519                                                               |
| `WORKER_ALLOWED_PATHS`         | Racines lisibles et inscriptibles. Tout le reste est refusé                                     |
| `WORKER_CAPABILITIES`          | Capacités exposées. Vide = toutes celles réellement disponibles                                 |
| `WORKER_ALLOWED_EXECUTABLES`   | Programmes autorisés. Vide = liste par défaut                                                   |
| `WORKER_ALLOWED_ENV`           | Variables transmises aux processus enfants                                                      |
| `WORKER_HEARTBEAT_INTERVAL_MS` | Défaut 20 s                                                                                     |
| `WORKER_TASK_TIMEOUT_MS`       | Défaut 5 min                                                                                    |
| `WORKER_MAX_CONCURRENT_TASKS`  | Au-delà, le worker refuse — le cœur choisit ailleurs                                            |
| `WORKER_DOCKER_ALLOWED`        | Sous-commandes Docker. Défaut : consultation seule                                              |
| `WORKER_GIT_ALLOW_WRITE`       | Autorise `pull`, `checkout`, `commit`, `clone`. Défaut : non                                    |

Le **rôle** (`CLIENT`, `WORKER`, `BOTH`) n'y figure pas : il appartient au
registre, côté cœur. Un worker qui déciderait lui-même de son rôle pourrait se
l'élargir.

---

## Capacités

| Capacité                             | Risque | Notes                                                                          |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------ |
| `terminal.execute`                   | HIGH   | Exécutable + arguments structurés. Jamais de ligne de commande                 |
| `filesystem.read`                    | SAFE   | Borné en taille, contenu rédigé                                                |
| `filesystem.write`                   | MEDIUM | Refuse d'écraser sans demande explicite                                        |
| `process.list`                       | SAFE   |                                                                                |
| `process.start`                      | HIGH   | Détaché : survit au redémarrage du worker                                      |
| `process.stop`                       | HIGH   | **Uniquement** les processus lancés par NEXUS                                  |
| `docker.execute`                     | HIGH   | Consultation par défaut ; `--privileged` et montage du socket toujours refusés |
| `git.status` `git.diff` `git.branch` | SAFE   | Lecture                                                                        |
| `git.pull` `git.clone` `git.commit`  | MEDIUM | Écriture, refusée par défaut                                                   |
| `git.checkout`                       | HIGH   | Seule opération pouvant détruire un travail non enregistré                     |
| `browser.open`                       | LOW    | Ouvre une page **devant l'utilisateur**. N'automatise rien                     |

Sept capacités Git plutôt qu'un `git.execute` : c'est ce qui permet d'accorder
`git.status` sans accorder `git.checkout`, et au cœur d'exiger une confirmation
pour l'une et pas pour l'autre.

`browser.open` **n'est pas un doublon de Browser Use**. Browser Use pilote un
navigateur — lit, clique, remplit. `browser.open` affiche une page sur l'écran de
l'utilisateur. Les confondre donnerait deux chemins d'automatisation du web dont
l'un sans aucune des protections de l'autre.

### Déclaration dynamique

Une capacité n'est annoncée que si elle est **réellement disponible** (Docker
seulement si le démon répond, Git seulement si le binaire existe) **et**
explicitement autorisée. Annoncer ce qu'on ne peut pas honorer est pire que de
se taire : le sélecteur choisirait cette machine et l'étape échouerait, après
avoir écarté un exécutant capable.

---

## Sécurité

- **Un identifiant d'appareil n'authentifie jamais.** Il est public. Chaque
  connexion signe un challenge Ed25519 ; la clé privée ne quitte pas la machine.
- **Anti-rejeu** sur l'authentification et les battements de cœur (`requestId` +
  horodatage borné).
- **Reconnexion sans réutilisation de jeton** : une session dont on ne sait pas
  si elle est encore valide n'est pas une session.
- **Chemins** : racines déclarées, résolution des liens **avant** comparaison,
  refus des remontées, des UNC, des préfixes `\\?\`, des flux de données
  alternatifs, des noms de périphériques réservés, et de tout emplacement
  contenant des secrets — même sous une racine autorisée.
- **Processus** : `process.stop` n'atteint que ce que NEXUS a lancé. Sans cette
  règle, arrêter un serveur de développement et arrêter l'antivirus demanderaient
  la même permission.
- **Environnement** : jamais transmis en bloc. Liste blanche dans les deux sens.
- **Git** : `GIT_TERMINAL_PROMPT=0` et `GIT_ASKPASS` vide — un dépôt privé échoue
  tout de suite au lieu d'attendre une invite que personne ne verra. Le schéma
  `ext::` est refusé : il exécute une commande au moment du clone.
- **Rédaction** : sortie de processus, contenu de fichier lu et arguments
  journalisés passent par `redact` / `redactText` de `@nexus/shared`. Le worker
  reçoit les vraies valeurs ; le journal et les événements reçoivent
  `[REDACTED]`.
- **Ne sont jamais journalisés** : mots de passe, clés d'API, jetons d'accès et
  de rafraîchissement, cookies, signatures, clés privées, secrets renvoyés par un
  processus.

---

## Cycle de vie

```
start → connect → hello → challenge → authenticate → session
      → register → heartbeat ⇄ receive/execute → shutdown
```

Une coupure à n'importe quel point ramène à `connect`, avec attente
exponentielle **et bruit**. Le bruit n'est pas un raffinement : sans lui, tous
les workers d'un utilisateur reconnectent à la même milliseconde et refont
tomber le cœur au moment où il redémarre.

À l'arrêt, les étapes en cours sont annulées et leur échec est remonté **avant**
la fermeture du canal — sinon le coordinateur attendrait un résultat pendant
toute la durée du délai avant de comprendre qu'il n'arrivera pas.

---

## Chaîne de validation d'une étape

```
capacité connue → capacité disponible → schéma d'arguments → capacité libre
  → politique locale → exécution sous délai → progression → résultat
```

Elle s'arrête au premier refus. Un ordre qui n'a pas traversé les quatre
premières étapes n'atteint jamais le système d'exploitation.

Le cœur a déjà vérifié les permissions et obtenu les confirmations. Le worker
revérifie quand même ce qui le concerne : il est le dernier à savoir ce qui est
réellement possible **sur cette machine**, et un cœur compromis ne doit pas
suffire à lui faire faire n'importe quoi.

---

## Tests

```bash
pnpm --filter @nexus/windows-worker test
```

`ProcessRunner` et `FileSystemPort` sont des ports, remplacés par des doubles en
mémoire. Toute la chaîne — politiques, délais, annulation, rédaction — est
éprouvée sans lancer un processus. Le reste est réel : vraies clés Ed25519,
vraies signatures, vrai `DeviceSessionService`, vraie `WorkerGateway`, vrai
`TaskCoordinator`, vraies enveloppes validées par les schémas du protocole.

---

## Brancher le WebSocket réel

Le worker ne dépend pas du WebSocket : il dépend du port `WorkerLink`.

```ts
export interface WorkerLink {
  readonly state: LinkState;
  connect(): Promise<void>;
  send(envelope: Envelope): Promise<void>;
  close(reason: string): Promise<void>;
  onMessage(handler: (envelope: unknown) => void): void;
  onClose(handler: (reason: string) => void): void;
}
```

Il y a `connect()`, il n'y a pas `listen()` : ce worker ne peut
structurellement pas accepter de connexion entrante.

Côté cœur, la passerelle attend un `WorkerConnection` (`send`, `close`) et un
point d'entrée unique, `WorkerGateway.handleMessage(connection, trame)`.

L'adaptateur réel est `WebSocketLink` (`src/connection/websocket-link.ts`). Il se
réduit à ce qu'annonçait ce paragraphe : ouvrir la socket vers
`NEXUS_BACKEND_URL`, transmettre les enveloppes JSON dans les deux sens, signaler
la fermeture. Aucune logique — elle était déjà écrite et éprouvée de bout en bout
avec `LoopbackLink`, l'autre implémentation du même port.

Deux refus y sont inscrits :

- **une adresse distante en clair est rejetée.** Le challenge signé authentifie la
  machine, il ne chiffre pas ce qui suit ; en clair, les consignes d'exécution
  envoyées à ce poste seraient lisibles et modifiables par qui se trouve sur le
  chemin ;
- **aucune trame de plus de 256 Ko.** Au-delà, ce n'est plus une consigne, c'est
  un transfert — et un plafond côté client évite qu'un cœur compromis n'épuise la
  mémoire de la machine.

---

## Carte de visite locale

Au démarrage, le démon dépose son état **public** dans `WORKER_STATE_PATH`
(`%ProgramData%\\NEXUS\\worker\\device.json` par défaut) :

```json
{
  "deviceId": "…",
  "platform": "WINDOWS",
  "workerVersion": "0.1.0",
  "startedAt": "…"
}
```

Un seul lecteur : l'interface NEXUS installée sur la même machine, qui a besoin de
savoir quel appareil ce poste est pour se reconnaître dans la liste que le cœur
lui renvoie — sans quoi elle créerait un second « Portable » fantôme.

Ce fichier **n'accorde rien**. Il ne contient ni chemin de clé, ni racines
autorisées, ni URL du cœur, et il n'existe aucun canal de commande entre
l'interface et le démon. C'est une carte de visite en lecture seule ; un
identifiant d'appareil seul n'a jamais été une authentification.

---

## Diagnostic

| Symptôme                         | Cause probable                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Le worker reste `authenticating` | Clé publique absente côté cœur, ou appareil encore `PENDING`                                                          |
| Le worker reste `reconnecting`   | `NEXUS_BACKEND_URL` injoignable ; regarder `tentative` dans le journal                                                |
| `CAPABILITY_UNAVAILABLE`         | Trois causes distinctes, le contexte de l'erreur les sépare : non implémentée, non autorisée localement, outil absent |
| `PATH_NOT_ALLOWED`               | Le motif exact est dans `context.reason`                                                                              |
| `WORKER_SATURATED`               | `WORKER_MAX_CONCURRENT_TASKS` atteint ; réessayable ailleurs                                                          |
| Docker n'apparaît pas            | Le démon ne répond pas : la sonde a échoué et la capacité n'est pas annoncée                                          |
