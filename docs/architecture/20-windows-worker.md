# 20 — Worker Windows (implémenté)

Décrit le sous-système **tel qu'il est construit**. Le document
[19 — Architecture multi-appareils](19-multi-devices.md) en pose le cadre ;
celui-ci fait foi pour le code. Paquet :
[`@nexus/windows-worker`](../../services/windows-worker).

## 1. Ce que ce lot ajoute — et ce qu'il ne change pas

Le cœur multi-appareils déclarait un port, `WorkerTransport`, et ne connaissait
aucun exécutant réel. Ce lot fournit les deux extrémités du fil :

- **`WorkerGateway`** (`@nexus/devices`) implémente `WorkerTransport` ;
- **`@nexus/windows-worker`** est le premier exécutant physique.

`TaskCoordinator`, `DeviceSelector`, `TaskPlan`, `PermissionService`,
`ConfirmationService` et `createDeviceTools` sont **inchangés**. Le worker leur
apparaît comme un exécutant ordinaire, exactement comme prévu.

## 2. Le sens de la connexion

```
Worker Windows ──(WebSocket sortant, wss://)──▶ NEXUS Core
                                                   │
                                             WorkerGateway
                                                   │
                                   TaskCoordinator ◀── DeviceSelector
                                                   │
                                                 Agent
```

**Le worker appelle le cœur.** Le cœur ne sait pas joindre une machine Windows ;
il répond sur un canal déjà ouvert. Ce n'est pas une commodité mais une propriété
défendue par la forme du port : `WorkerLink` expose `connect()`, jamais
`listen()`.

Aucune redirection de port, aucune machine exposée, aucun client qui parle
directement à un exécutant.

## 3. La même implémentation sur deux machines

|              | Portable     | Poste fixe   |
| ------------ | ------------ | ------------ |
| Rôle         | `BOTH`       | `WORKER`     |
| Type         | `WINDOWS_PC` | `WINDOWS_PC` |
| Code exécuté | identique    | identique    |

Rien dans le worker ne lit son rôle ni son nom : ils viennent du registre, côté
cœur. Un test le vérifie en connectant la même classe sous deux identités, avec
des noms délibérément dissemblables, et en comparant capacités annoncées et
comportement.

Ajouter une quatrième machine reste donc une **écriture en base**.

## 4. Il n'existe pas de point d'exécution arbitraire

C'est la contrainte structurante du lot. Aucune capacité n'accepte de chaîne de
commande ; `terminal.execute` prend un exécutable choisi dans une liste et un
tableau d'arguments, et `spawn` est appelé avec `shell: false`.

La sécurité vient de la **forme de l'API**, pas d'un filtre. Un test le vérifie
sur trois plans : aucune capacité déclarée n'expose de champ `command`, aucun
fichier source n'importe `exec`/`execSync`, et chaque `spawn` porte
`shell: false`.

Corollaire assumé : une tentative d'injection **réussit** — au sens où elle
s'exécute. `git log "&& del /S /Q C:\Projets"` lance `git` avec un argument
absurde. Une seule commande, et c'est `git`. C'est précisément ce qu'on veut
démontrer : il n'y a rien à filtrer.

Les `.bat` et `.cmd` sont refusés à part : Node les exécute via `cmd.exe`, ce qui
réintroduirait exactement l'interprétation qu'on écarte.

## 5. Sept capacités Git, pas un `git.execute`

La distinction n'est pas cosmétique : elle permet d'accorder `git.status` sans
accorder `git.checkout`, et au cœur d'exiger une confirmation pour l'une et pas
pour l'autre. Un `git.execute` générique obligerait à inspecter les arguments
pour deviner l'intention — c'est-à-dire à réintroduire l'analyse de chaînes.

`git.checkout` est classé HIGH, au-dessus de `commit` et `pull` : c'est la seule
opération capable de détruire un travail non enregistré, sans confirmation ni
retour possible.

## 6. Déclaration dynamique des capacités

Deux conditions cumulatives pour qu'une capacité soit annoncée : être
**réellement disponible** (sonde à l'exécution — le démon Docker répond, le
binaire Git existe) et être **explicitement autorisée** par la configuration.

Annoncer ce qu'on ne peut pas honorer est pire que se taire : le sélecteur
choisirait cette machine, l'étape échouerait, et un exécutant capable aurait été
écarté entre-temps.

Le cœur reste autoritaire : `worker.registered` renvoie la liste **acceptée**,
et c'est elle que le worker retient — pas celle qu'il a demandée.

## 7. Authentification

Réutilise `DeviceSessionService` sans le modifier. Aucun second mécanisme.

```
hello  ─▶  (challenge)  ─▶  authenticate (nonce signé Ed25519)  ─▶  session
```

`hello` n'accorde rien : un identifiant d'appareil est public. La clé privée ne
quitte jamais la machine ; elle est désignée dans la configuration par un
**chemin**, jamais par sa valeur.

L'anti-rejeu (`requestId` + horodatage borné) couvre l'authentification et les
battements de cœur. Une reconnexion refait la poignée de main complète : une
session dont on ne sait pas si elle est encore valide n'est pas une session.

## 8. Rédaction

Trois points d'interception, parce qu'aucun ne suffit seul :

1. **La sortie des processus** — ce qu'écrit un programme n'est pas maîtrisable.
   Un script de déploiement qui affiche son jeton ne doit pas le faire entrer
   dans le journal du cœur.
2. **Le contenu des fichiers lus** — un `.env` lu par `filesystem.read` est un
   cas parfaitement ordinaire.
3. **Les arguments journalisés** — le worker reçoit les vraies valeurs, le
   journal reçoit `[REDACTED]`.

Ce lot a étendu `@nexus/shared` d'une fonction `redactText`, qui cherche les
secrets **à l'intérieur** d'un texte libre — là où `redact` ne travaillait que
sur des structures. `redact` l'applique désormais aussi à ses chaînes feuilles :
un secret ne se présente pas toujours comme la valeur entière d'un champ bien
nommé.

## 9. Événements

Quatre types ajoutés à l'union existante, en pur ajout : `worker.connected`,
`worker.ready`, `worker.disconnected`, `worker.task_cancelled`.

`device.connected` dit « le registre a vu cette machine » ; `worker.connected`
dit « le canal d'exécution est ouvert ». Un appareil peut être connu et joignable
sans être prêt à exécuter — la distinction sert au diagnostic.

## 10. Ce qui reste à faire

Le transport réel. Le worker dépend du port `WorkerLink`, pas du WebSocket ;
l'adaptateur de la phase suivante ouvre la socket, transmet les enveloppes JSON
dans les deux sens et signale la fermeture. Aucune logique — elle est déjà
écrite et éprouvée de bout en bout avec `LoopbackLink`, l'autre implémentation du
même port.
