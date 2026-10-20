# 19 — Architecture multi-appareils (implémentée)

Décrit le sous-système **tel qu'il est construit**. Le document
[06 — Appareils](06-devices.md) en pose la conception ; celui-ci fait foi pour le
code. Paquet : [`@nexus/devices`](../../packages/devices).

## 1. Le problème réel

NEXUS n'est pas un assistant qui tourne sur une machine. C'est un assistant qui
tourne **entre** des machines : on lui parle depuis l'iPhone, il exécute sur le
poste fixe, il notifie sur l'Android, et le portable voit tout passer. La
question centrale n'est donc pas « comment exécuter une commande » mais **« qui
exécute, et qui doit voir le résultat ? »**.

Deux règles produisent tout le reste :

1. **Le cœur ne connaît aucun appareil par son nom.** Il connaît des rôles, des
   types et des capacités. « L'iPhone d'Adlan » est une ligne en base, jamais un
   `if` dans le code. Ajouter un quatrième ordinateur est une écriture en base.
2. **Tout passe par le centre.** Aucun client ne parle à un autre. Pas de
   pair-à-pair, pas d'état partagé hors du backend. C'est ce qui garantit qu'un
   iPhone rallumé après deux heures voit exactement le même état que le portable
   resté connecté.

## 2. Chaîne

```
                        ┌──────────────── DeviceRegistry ──────────────┐
                        │  qui existe · que sait-il faire · est-il sain │
                        └───────────────────┬──────────────────────────┘
                                            │
   TaskPlan ──▶ TaskCoordinator ──▶ DeviceSelector ──▶ WorkerTransport ──▶ worker
                       │                (lequel ?)
                       ├──▶ ConfirmationGate      (risque ≥ seuil)
                       └──▶ EventRouter ──▶ tous les clients de l'utilisateur
                                              (origine en premier)
```

Et, en parallèle, le pont vers l'agent :

```
capacité ──▶ createDeviceTools ──▶ ToolDefinition ──▶ ToolRegistry ──▶ Agent
```

## 3. Rôle, type, capacité : trois axes distincts

Les confondre est l'erreur qui rend une flotte inextensible.

| Axe          | Répond à              | Exemple                    |
| ------------ | --------------------- | -------------------------- |
| **Rôle**     | A-t-il le droit ?     | `CLIENT`, `WORKER`, `BOTH` |
| **Type**     | Qu'est-ce que c'est ? | `IPHONE`, `WINDOWS_PC`     |
| **Capacité** | Que sait-il faire ?   | `terminal.execute`         |

Le portable Windows est réellement `BOTH` : on y discute avec NEXUS _et_ il
exécute des tâches. Un `CLIENT` n'est jamais sélectionné comme exécutant, même
s'il déclare la capacité — c'est le rôle qui tranche, pas la capacité.

Les **capacités partagent l'espace de nommage des permissions** (`domaine.action`).
C'est délibéré : une capacité dit ce que l'appareil _sait_ faire, une permission
ce que l'utilisateur _autorise_. Les deux doivent être réunies. Les nommer
pareil rend la relation lisible dans l'interface comme dans les journaux.

## 4. Sélection : dix critères, jamais un nom

`DeviceSelector` applique d'abord des **filtres durs**, dans un ordre choisi pour
le diagnostic — exclusions, rôle, révocation, confiance, opérabilité, capacités,
permissions, saturation, contraintes. Chaque rejet est motivé, ce qui permet de
répondre à « pourquoi cet appareil n'a-t-il pas été retenu ? » sans instrumenter
le code.

Les survivants sont **notés** : préférence explicite (1000) ≫ disponibilité (300)

> santé (200) > latence (150) > alimentation secteur (100) > spécialisation (50).
> La préférence de l'utilisateur écrase tout le reste — mais seulement parmi les
> appareils éligibles : une préférence ne contourne jamais un filtre de sécurité.

## 5. `TaskPlan` n'est pas un `AgentRun`

Distinction maintenue exprès. Un `AgentRun` (voir [16](16-agent-core.md)) décrit
un **raisonnement** — observer, réfléchir, appeler un outil. Un `TaskPlan` décrit
une **exécution répartie** — le poste fixe clone, le portable teste, l'Android
notifie. Un run peut produire un plan ; un plan peut s'exécuter sans agent. Les
fusionner rendrait l'un ou l'autre illisible.

Le graphe d'étapes est validé à la construction : identifiants dupliqués,
dépendances pendantes et **cycles** sont refusés tout de suite. Mieux vaut un
plan rejeté qu'un plan découvert bloqué à la troisième étape.

## 6. `originClientDeviceId` : le fil de routage

C'est le champ qui traverse tout le sous-système. La demande part de l'iPhone,
s'exécute sur le poste fixe, et ses événements reviennent **à l'iPhone d'abord**
— parce que c'est là que l'utilisateur regarde. Les autres clients reçoivent
ensuite, dans la même diffusion : une tâche lancée depuis le portable est visible
sur l'iPhone, et réciproquement.

Un client déconnecté n'est pas oublié : ses événements l'attendent dans une file
**bornée** (200 par appareil). Un iPhone éteint une semaine ne fait pas enfler la
mémoire du serveur — au-delà, il resynchronise son état complet plutôt que de
rejouer l'historique.

## 7. Sécurité

- **Un identifiant d'appareil n'authentifie jamais.** Il est public, il apparaît
  dans l'interface et dans les journaux. Une session naît d'un **challenge signé
  en Ed25519**, et porte un jeton à durée limitée dont seule l'empreinte est
  stockée. Le nonce est consommé même quand la vérification échoue — sinon il
  reste rejouable.
- **Confiance et statut sont deux choses.** Un appareil fraîchement appairé est
  `PENDING` : en ligne, mais sans aucune tâche, tant qu'un humain ne l'a pas
  approuvé. `revokeTrust` est réversible, `revokeDevice` ne l'est pas.
- **Revérification avant dispatch.** Les capacités sont recontrôlées juste avant
  l'appel : un appareil peut les avoir perdues entre la sélection et l'envoi.
- **Aucun point d'entrée générique.** Un worker n'expose pas « exécute ceci » ;
  il expose des capacités déclarées, et n'exécute que celles-là.
- **Rédaction systématique.** Les enregistrements d'exécution sont un journal
  d'audit : ils consignent les arguments, mais passés par `redact` de
  `@nexus/shared`. Un mot de passe transmis à `terminal.execute` atteint le
  worker et ne survit pas à la ligne de journal. Les événements, eux, ne portent
  jamais d'arguments — seulement des identifiants, une capacité et une description.

## 7 bis. Appairage par QR code

### Ce que le QR remplace, et ce qu'il ne remplace pas

La clé privée d'un téléphone naît dans son magasin de clés et n'en sort jamais.
Le cœur doit donc recevoir la **clé publique**, et quelqu'un doit la lui
porter. Ce transport se faisait à la main : lire la clé sur le téléphone, la
coller dans le tableau de bord. C'est long, et une clé recopiée de travers
produit un appareil qui s'enregistre puis échoue à chaque poignée de main sans
que rien ne nomme la cause.

Le ticket remplace ce **transport**. Il ne remplace pas la preuve.

### Pourquoi un ticket prouve quelque chose

Il est émis par une surface **déjà authentifiée** et s'affiche sur l'écran du
propriétaire. Le scanner demande de voir cet écran : c'est une preuve de
présence physique, la même que la recopie manuelle, sans la recopie.

```
  tableau de bord (authentifié)        téléphone
  POST /devices/pairing-tickets  ──▶  QR : nexus://pair?api=…&token=…
                                       │
                                       ▼  (aucune identité encore)
                                 POST /devices/pair
                                       │
  appareil PENDING chez le propriétaire du ticket ◀┘
                                       │
  approbation explicite  ──────────────┘  puis première session
```

L'asymétrie des deux routes **est** le dispositif : émettre exige un
utilisateur, utiliser n'exige que le ticket — parce que l'appareil qui scanne ne
possède encore aucune identité, c'est précisément ce qu'il vient chercher.

### Les quatre propriétés qui rendent la fenêtre étroite

| propriété                            | ce qu'elle empêche                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **usage unique** (`consumedAt`)      | un QR photographié par-dessus l'épaule ne sert plus une fois l'appareil appairé                                                      |
| **cinq minutes**                     | très au-delà du geste, très en deçà d'une fenêtre exploitable                                                                        |
| **jamais en clair au repos**         | seule l'empreinte SHA-256 est stockée, et la recherche se fait _par_ empreinte — il n'y a donc aucune comparaison à rendre constante |
| **propriétaire porté par le ticket** | le porteur d'un code ne choisit pas à qui l'appareil sera rattaché                                                                   |

Le motif d'un refus — inconnu, expiré, déjà consommé — reste dans le contexte
et ne sort jamais vers le porteur. « Expiré » apprendrait à qui tâtonne qu'il a
touché un vrai ticket ; le propriétaire, lui, a le même geste dans les trois
cas : réafficher un QR.

### Ce que le ticket ne donne pas

L'appareil arrive `PENDING` et hors ligne, comme n'importe quel appareil
enregistré à la main. Le ticket porte la preuve d'un transport, pas une
décision de confiance. Les confondre économiserait un clic et supprimerait le
seul endroit où le propriétaire voit _ce_ qu'il approuve.

De même, le ticket ne change pas la règle qui exige une clé publique d'un
`WORKER` : il change la façon dont la clé voyage. Une tentative invalide ne
consomme pas le ticket — sans quoi une faute de frappe coûterait un nouveau QR.

### `PUBLIC_API_URL`, et pourquoi elle est explicite

Le QR porte l'adresse que l'appareil appellera. Elle est **configurée**, pas
déduite de l'en-tête `Host` : cet en-tête est choisi par l'appelant, et un QR
qui en dériverait son adresse laisserait n'importe quelle requête décider où un
téléphone envoie sa clé publique. Absente, l'émission est refusée avec un
message qui nomme le réglage — produire un QR qui mène ailleurs serait pire,
parce que le symptôme apparaîtrait sur le téléphone, loin de la cause.

Le schéma `nexus://` n'est pas accidentel non plus : un code dans une URL
`https://` finit dans un historique, un journal de proxy, un presse-papiers
partagé. `nexus://` n'est pas ouvrable par un navigateur, donc une charge utile
qui sort du chemin prévu n'atteint rien. Le décodeur refuse par ailleurs toute
adresse d'API qui ne soit pas `http(s)` : le QR est une **donnée**, et un
scanneur qui accepterait `file://` offrirait à un QR malveillant de choisir la
destination.

### Surface

```
POST /api/v1/devices/pairing-tickets   (utilisateur)  → { id, token, payload, expiresAt }
GET  /api/v1/devices/pairing-tickets   (utilisateur)  → tickets récents, sans leur code
POST /api/v1/devices/pair              (ticket seul)  → appareil PENDING
```

Les deux routes sont limitées en débit. Sur `/devices/pair` ce n'est pas du
confort : c'est ce qui rend le tâtonnement d'un code inutile.

## 8. Le pont vers l'agent : pas de second système d'outils

Une capacité devient un `ToolDefinition` ordinaire du `ToolRegistry` existant,
nommé `device.<capacité>` — exactement comme le fait `McpManager` pour MCP.
Conséquence directe : permissions, confirmations, validation des arguments,
délais, reprises et trace d'audit s'appliquent sans une ligne supplémentaire.

L'agent ne voit donc jamais d'appareil. Il voit `device.terminal.execute` et
ignore lequel des trois ordinateurs l'exécutera. C'est ce qui empêche le modèle
de développer des préférences matérielles, et ce qui rend un appareil
remplaçable sans toucher au prompt.

## 9. Ce qui n'est pas encore là

Ce document décrit le **cœur**. Les exécutants concrets se branchent sur
`WorkerTransport` et sur le protocole d'événements sans modifier ce qui précède
— c'était l'objectif.

Restent à faire, et à savoir avant de s'appuyer dessus :

- **L'écran qui affiche le QR.** L'API émet le ticket et rend une charge utile
  prête à encoder ; aucune surface ne la dessine encore. Tant que c'est le cas,
  l'appairage par QR s'exerce en appelant l'API, pas en scannant.
- **Le scanneur côté téléphone.** `decodePairingPayload` existe et est testé,
  mais rien ne l'appelle encore depuis l'application Android.
