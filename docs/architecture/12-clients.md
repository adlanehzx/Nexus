# 12 — Clients : mobile, desktop, web

## 1. Socle commun

Les trois clients partagent `@nexus/sdk-client` : client REST typé, gestionnaire de connexion WS
(reconnexion, reprise par `seq`, file d'envoi hors ligne), machine à états de run, et cache. Un
client ne connaît **ni les outils, ni les providers LLM, ni la base**. Il connaît des
conversations, des messages, des événements et des confirmations (contrainte C4).

État : **TanStack Query** pour l'état serveur, **Zustand** pour l'état d'interaction (run courant,
buffer de streaming, enregistrement audio). Ne pas mettre les événements de streaming dans le
cache Query : ils sont éphémères et à haute fréquence.

## 2. Mobile (Expo / React Native)

**Stack** : Expo SDK (managed + dev client), Expo Router, `react-native-reanimated`,
`expo-av` (audio), `expo-secure-store` (tokens), `expo-notifications` (push),
`react-native-mmkv` (cache local), Nativewind ou StyleSheet + `@nexus/ui-tokens`.

**Écrans**

| Écran        | Contenu clef                                                                                |
| ------------ | ------------------------------------------------------------------------------------------- |
| Conversation | fil de messages, streaming, cartes d'outils, cartes de confirmation, composer texte + micro |
| Historique   | liste des conversations, recherche, épinglage, archivage                                    |
| Tâches       | tâches en cours et planifiées, progression, résultats                                       |
| Devices      | appareils, statut en ligne, appairage par QR, logs, révocation                              |
| Permissions  | grants par outil, scopes, révocation, journal d'audit                                       |
| Mémoire      | ce que l'assistant a retenu, édition, suppression                                           |
| Settings     | providers, voix, modèle, budgets, confidentialité                                           |

**Le fil de conversation** est le cœur du produit. Il rend une **timeline d'événements**, pas
seulement des messages :

```
┌──────────────────────────────────────────┐
│ 👤 Regarde mes emails et dis-moi les      │
│    importants                             │
├──────────────────────────────────────────┤
│ ✳ Réflexion…            (pulse animé)     │
│ ▸ Plan  1. lire  2. classer  3. résumer   │
│ 🔧 mail.list          ✓ 1,2 s   34 emails │
│ 🔧 mail.read          ⟳ 12/34   ▓▓▓░░░    │
│ ┌──────────────────────────────────────┐ │
│ │ ⚠️ Confirmation requise               │ │
│ │ mail.send → recruteur@x.com           │ │
│ │ Objet : Re: proposition               │ │
│ │ « Bonjour, merci pour votre… »        │ │
│ │        [ Refuser ]  [ Envoyer ]       │ │
│ └──────────────────────────────────────┘ │
│ 🤖 Tu as 3 emails importants : …          │
│    (texte en streaming)                   │
└──────────────────────────────────────────┘
```

Principes d'interface, non négociables :

1. **Toute action réelle est visible.** Une carte d'outil apparaît pour chaque exécution, avec son
   niveau de risque et sa durée. L'utilisateur ne découvre jamais après coup ce qui a été fait.
2. **Les cartes de confirmation montrent le contenu exact**, pas un résumé — corps complet de
   l'email, diff du fichier, commande shell avec son répertoire. Repli plié/déplié pour la place.
3. **Les états d'attente sont différenciés** : « réflexion », « exécution de X », « attente de ta
   réponse » ont trois animations distinctes. Un spinner unique rend l'agent opaque.
4. **L'annulation est toujours à un geste**, pendant tout le run.
5. **Optimiste et hors ligne** : le message part immédiatement en local avec `clientMessageId`,
   se réconcilie à l'`ack`, et se ré-envoie à la reconnexion.

**Notifications push** : quand l'app est en arrière-plan, une confirmation en attente et la fin
d'un run déclenchent un push. Une confirmation `CONFIRM` est approuvable depuis une action de
notification ; une `CRITICAL` exige l'ouverture de l'app et une ré-authentification biométrique.

## 3. Desktop (Tauri v2)

**Choix** : Tauri v2 plutôt qu'Electron (→ [ADR-008](../adr/ADR-008-desktop-tauri.md)) — binaire
~10 Mo contre ~120 Mo, empreinte mémoire moindre, modèle de permissions explicite, et surtout un
cœur Rust déjà adapté au rôle d'agent local (accès système, service en arrière-plan, tray).

Le risque connu — la webview varie selon l'OS (WebView2 / WKWebView / WebKitGTK) — est accepté :
l'UI reste volontairement simple, et la matrice de test couvre Windows en priorité (la machine
cible), macOS ensuite.

**Rôle double** :

1. **Client** — même UI React que le web, réutilisation maximale des composants.
2. **Coquille du Device Agent** — installe, supervise et affiche le démon Node (→ [06](06-devices.md)) :
   statut, tâches en cours, logs en direct, éditeur de politique locale, bouton « pause » qui coupe
   instantanément toute exécution locale.

**Intégrations natives** : raccourci global (invocation instantanée), fenêtre « spotlight »,
icône de barre d'état, notifications système, lancement au démarrage, deep links.

## 4. Web (optionnel, phase 5)

Vite + React, mêmes composants que le desktop. Sert deux besoins : accès depuis une machine non
équipée, et surface de démonstration. Ne dispose évidemment d'aucune capacité device.
Contraintes propres : CSP stricte, tokens en mémoire + refresh en cookie `HttpOnly` `SameSite=Strict`
(le seul endroit où un cookie est utilisé), pas de stockage de refresh en `localStorage`.

## 5. Ce qui est partagé, ce qui ne l'est pas

| Partagé                                 | Spécifique                              |
| --------------------------------------- | --------------------------------------- |
| `@nexus/contracts`, `@nexus/sdk-client` | rendu natif RN vs DOM                   |
| logique de run, réducteurs d'événements | navigation, animations                  |
| design tokens (`@nexus/ui-tokens`)      | composants d'interface                  |
| validation, types, codes d'erreur       | audio, notifications, stockage sécurisé |

On ne tente **pas** de partager les composants d'UI entre React Native et le web
(`react-native-web` ajoute une couche de compromis pour un gain faible sur trois écrans). On
partage la logique, on réécrit la présentation.

## Mode hors ligne, mise à jour, télémétrie de crash

### Mode hors ligne : ce qu'on refuse de garder

Une file d'attente hors ligne est une machine à doubler les actions. Le
téléphone envoie « range mes mails », perd le réseau avant la réponse, réessaie
à la reconnexion — et la demande part deux fois. Le module de rattrapage porte
déjà cet avertissement : « un rattrapage qui pourrait créer une tâche
transformerait une coupure réseau en seconde commande ».

Trois règles, et chacune ferme une voie de doublon.

**La clé d'idempotence naît à la mise en file, pas à l'envoi.** Les trois
tentatives d'une même entrée portent donc la même clé, et le cœur reconnaît la
répétition. Une clé générée à l'envoi serait différente à chaque essai,
c'est-à-dire inutile.

**On ne met en file que ce que le serveur sait dédupliquer.** C'est une limite
réelle — une seule route honore `Idempotency-Key` aujourd'hui — et la nommer
vaut mieux que l'ignorer : sur une route qui ne l'honore pas, mettre en file
_garantit_ le doublon au lieu de le risquer. La file refuse, et le dit. La liste
est blanche, pas noire : une route ajoutée demain n'est pas mise en file par
défaut, parce que se tromper dans ce sens coûte une action à refaire, et dans
l'autre une action faite deux fois.

**Une entrée expire** — vingt-quatre heures. Une intention dont le contexte a
disparu n'est plus une intention : « réponds à ce mail » mis en file mardi n'a
aucun sens vendredi, et l'exécuter serait pire que de l'avoir perdu.

Et ce qui n'entre **jamais** en file : les confirmations. Approuver hors ligne
une action à risque puis l'envoyer trois heures plus tard, c'est approuver
quelque chose qu'on n'a pas relu — et qui a peut-être changé. Une confirmation
se donne en ligne, devant ce qu'elle autorise.

L'envoi respecte l'ordre et s'arrête au premier échec réessayable : deux
messages envoyés à l'envers racontent une autre conversation, et continuer
après un échec réseau enverrait le second message d'une suite dont le premier
n'est pas passé. Un refus **définitif**, lui, est écarté — il ne sera pas
meilleur demain, et le garder bloquerait toute la file derrière lui.

### Mise à jour automatique : décider, jamais appliquer

`UpdatePolicy` lit un flux de versions et dit s'il y a quelque chose à
installer. Il n'installe rien, ne télécharge rien, n'exécute rien — c'est le
travail de l'hôte (Tauri pour le bureau, le magasin pour le mobile), qui
possède la clé publique vérifiant la signature du paquet.

Un module qui déciderait **et** appliquerait serait un installeur, c'est-à-dire
la pièce la plus sensible de la chaîne : celle qui doit être la plus petite et
la plus auditée. Celui-ci est une fonction de comparaison avec des règles, et il
se teste entièrement — y compris le fait qu'il n'expose aucune méthode
d'installation.

Les refus sont le contenu réel :

| refus               | raison                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| version non signée  | un flux sans signature n'est pas incomplet, il est non fiable : qui le sert peut y mettre n'importe quel binaire |
| retour en arrière   | permettrait de réinstaller une faille corrigée                                                                   |
| changement de canal | une installation stable ne doit pas se retrouver en bêta parce que le flux en a proposé une                      |
| version majeure     | peut demander une migration ; l'appliquer pendant la nuit serait une mauvaise surprise au réveil                 |

Le flux est une donnée non fiable : chaque entrée est filtrée sur ses propres
mérites, et une entrée malformée est **ignorée** plutôt que de faire échouer la
décision — sans quoi un flux abîmé empêcherait toute mise à jour, y compris
celle qui corrige le problème.

### Télémétrie de crash : locale, et sans réseau

Écrire la trace d'un plantage **sur la machine**. Rien ne part : pas de point
de collecte, pas de clé d'API, aucune requête sortante. Un rapport de crash
contient des chemins de fichiers, des noms de conversations, parfois des
fragments de données — l'envoyer par défaut serait exactement la décision qu'un
assistant personnel ne doit pas prendre à la place de son propriétaire.

`share()` rend le texte, rédigé, et l'appelant en fait ce qu'il veut. Le module
n'a pas de réseau, donc il ne peut pas envoyer par accident, et un test le
vérifie.

Trois choses se trompent systématiquement quand on écrit cela à la main, et sont
donc traitées ici :

- **les secrets** — la rédaction passe par celle du reste du dépôt, pas par un
  filtre maison, et couvre le message, la pile _et_ le contexte, où une URL avec
  jeton se glisse souvent ;
- **la taille** — un plantage en boucle écrirait mille rapports et remplirait le
  disque, c'est-à-dire transformerait un bug en panne ;
- **la répétition** — cent fois la même pile n'apporte rien de plus que la
  première, et noie la seconde cause, qui est souvent la vraie. Le compteur
  monte, la liste ne s'allonge pas.

### Ce qui reste à faire

- **Une seule route honore `Idempotency-Key`.** Le mode hors ligne est donc
  limité à l'envoi de messages. Étendre la déduplication côté serveur est ce qui
  élargira la file, et non une modification du client.
- **Aucune surface n'affiche encore la file ni les rapports de crash.** Les
  modules et leurs tests existent ; les écrans restent à faire.
