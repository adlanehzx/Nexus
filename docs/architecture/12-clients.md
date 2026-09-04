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
