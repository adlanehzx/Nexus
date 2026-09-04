# 22 — API et temps réel (implémenté)

Décrit la couche réseau **telle qu'elle est construite**. Les documents
[02 — Backend](02-backend.md) et [08 — Protocole WebSocket](08-websocket-protocol.md)
en posent la conception ; celui-ci fait foi pour le code.

## 1. Ce qui a été ajouté, et ce qui n'a pas bougé

Aucune logique métier n'a été redessinée. `TaskCoordinator`, `DeviceSelector`,
`WorkerGateway`, `DeviceSessionService`, `PermissionService`,
`ConfirmationService`, `EventRouter` et les deux workers sont **inchangés** —
leurs 425 tests passent tels quels.

L'API les câble. Trois choses ont été créées :

1. **`@nexus/auth` est devenu réel** — il ne contenait que des schémas. Jetons
   EdDSA, mots de passe scrypt, rotation de session.
2. **Le canal client** (`@nexus/protocol/client.ts`), pendant du canal worker
   déjà en place. Même cadrage `envelopeSchema`, types disjoints.
3. **Les routes REST et les deux canaux WebSocket**, plus quatre services que
   personne ne portait encore : conversations, notifications, courtier de
   confirmation, superviseur de tâches.

## 2. Le cœur est l'autorité

```
client ─▶ route ou WebSocket
       ─▶ jeton vérifié + session active
       ─▶ propriété de la ressource
       ─▶ PermissionService
       ─▶ TaskCoordinator ─▶ DeviceSelector ─▶ WorkerGateway ─▶ worker
```

Un client ne désigne jamais d'exécutant. Il déclare des **capacités requises** ;
le sélecteur choisit. C'est ce qui empêche « envoie ça au poste fixe » de devenir
un chemin d'exécution dirigé depuis un téléphone.

Les deux canaux WebSocket ont des **types disjoints**, des schémas disjoints et
des points d'entrée disjoints. Un `worker.task_result` forgé depuis un iPhone
n'a nulle part où arriver — deux tests le vérifient dans les deux sens.

## 3. Deux surfaces d'authentification

|                             | Utilisateur                | Appareil                      |
| --------------------------- | -------------------------- | ----------------------------- |
| Preuve                      | mot de passe → jeton EdDSA | challenge signé Ed25519/P-256 |
| Durée                       | 15 min, rafraîchi          | 30 min, rotatif               |
| Garde                       | `requireUser`              | `requireDevice`               |
| Peut agir au nom de l'autre | non                        | non                           |

`verifyAccessToken` refuse un jeton d'appareil, et réciproquement. Il n'existe
pas de garde générique qui accepterait les deux.

**La vérification se fait en deux temps** : la signature prouve que le jeton
vient de nous, la session prouve qu'il est toujours valide. Sans le second,
se déconnecter ne ferait rien pendant un quart d'heure.

## 4. EdDSA plutôt qu'un secret partagé

Plusieurs composants doivent **vérifier** un jeton — l'API, la passerelle
WebSocket, demain un service séparé — alors qu'un seul doit pouvoir en
**émettre**. Avec un secret symétrique, tout ce qui vérifie peut aussi forger.

`TokenService.publicKeyPem` existe pour cela : un vérificateur qui ne peut pas
émettre.

## 5. Rotation du jeton de rafraîchissement

Le jeton tourne à chaque usage, et l'ancien est révoqué dans le même mouvement.
Si un jeton déjà consommé réapparaît, c'est qu'il a été copié : **toutes les
sessions de l'utilisateur sont fermées**, pas seulement celle-là. L'attaquant et
la victime en détiennent chacun un, et on ne sait pas lequel est lequel.

## 6. Synchronisation iPhone ↔ portable

Elle n'a demandé **aucun code spécifique**. `EventRouter` diffusait déjà à tous
les clients de l'utilisateur, l'appareil d'origine servi en premier, avec une file
bornée pour les absents. Le canal client ne fait qu'y brancher une connexion.

Trois propriétés, chacune testée :

- une tâche lancée depuis l'iPhone apparaît sur le portable ;
- `originClientDeviceId` est préservé dans **tous** les événements de tâche — le
  portable sait que la demande vient de l'iPhone, et peut ne pas la sonner ;
- un client déconnecté reçoit au retour ce qu'il a manqué.

Les **notifications sont produites au centre**, jamais par un client. Si chaque
client décidait quoi notifier, l'iPhone et le portable afficheraient des choses
différentes du même événement, et une tâche terminée pendant que l'iPhone était
éteint ne produirait rien du tout.

## 7. Confirmations : la demande vit au centre

`ConfirmationBroker` réconcilie deux contrats incompatibles en apparence :
`TaskCoordinator` attend un verdict, `ConfirmationService` ne bloque jamais.

Conséquence utile : une confirmation demandée pendant qu'on est sur l'iPhone peut
être approuvée **depuis le portable**. Une réponse en double n'est pas une
erreur — deux clients peuvent répondre presque en même temps, et le second ne
doit pas voir un message d'échec alors que tout s'est bien passé.

L'expiration vaut **refus**. Le silence ne doit jamais valoir accord pour une
action qui touche les fichiers de quelqu'un.

## 8. Nommage du canal worker

Le lot demandait `worker.task.progress` ; le code utilise `worker.task_progress`,
déjà en service dans les deux workers et leurs 319 tests. Les renommer aurait été
une rupture de contrat sans bénéfice fonctionnel — la consigne interdit par
ailleurs de redessiner ce qui marche. Les noms côté **client** suivent
exactement la spécification du lot.

## 9. Ce qui reste

La persistance : tous les magasins sont en mémoire derrière des ports. Le schéma
Prisma existe pour utilisateurs, appareils, sessions, conversations, messages et
tâches ; les implémentations restent à écrire. Aucune route ne changera.

Le transport WebSocket lui-même : `ClientChannel` et `WorkerChannel` sont
complets et testés, mais rien n'ouvre encore de socket. Brancher `@fastify/websocket`
consiste à appeler `authenticate`, `attach`, `handle` et `detach`.
