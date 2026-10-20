# Client mobile NEXUS — Expo / React Native

Client principal : conversation, flux en continu, cartes d'outils, cartes de
confirmation, microphone, historique, permissions, mémoire, appareils.

SDK Expo **57**, React Native **0.86**, expo-router, nouvelle architecture
activée. Les décisions vivent dans `@nexus/client-core`, qui est testé ; ce
dossier ne fait que du câblage et de la présentation.

## Lancer le serveur de développement

```bash
cd apps/mobile
pnpm start:go          # Expo Go — le chemin actuel
```

Les réglages du poste sont dans `.env.local`, non versionné : le nom Tailscale
sous lequel Metro s'annonce, et un contournement d'un défaut du CLI Expo. Sans
ce fichier, Metro publie une adresse du réseau local que le téléphone ne sait
pas joindre — il passe par Tailscale, pas par le Wi-Fi.

L'adresse du cœur est dans `.env` (`EXPO_PUBLIC_NEXUS_URL`). Elle est **publique
par nature** : une application mobile est décompilable, et rien de secret n'y
figure. Les jetons sont obtenus à la connexion et vivent dans le trousseau iOS.

Sur le téléphone : Expo Go, « Enter URL manually », puis
`exp://adlane.tail9a479d.ts.net:8081`. Tailscale doit être connecté des deux
côtés — sans lui, ni Metro ni le cœur ne sont joignables.

## Pourquoi `app.json` ne déclare pas de `owner`

`eas init` l'avait ajouté. Il a été retiré, et ce n'est pas un oubli : dès qu'un
projet déclare un propriétaire, **Expo Go exige d'être connecté à ce compte**
pour l'ouvrir, et refuse avec « There was a problem running the requested
project » sans dire lequel. Tant que le développement passe par Expo Go, ce
champ coûte un blocage et n'apporte rien.

Ce qui compte pour EAS — `extra.eas.projectId` — est conservé, et le CLI est
authentifié. `eas build` fonctionnera sans `owner` tant qu'un seul compte est en
jeu. Le jour où le projet appartiendra à une organisation, ou si plusieurs
comptes coexistent, il faudra le remettre **et se connecter à Expo Go avec ce
compte**.

## Premier lancement : approuver l'appareil

À la connexion, le téléphone **s'enregistre tout seul** comme appareil `CLIENT`
et arrive **non approuvé**. Le canal temps réel sera donc refusé au départ : un
appareil ne s'auto-approuve pas, et c'est voulu.

Onglet **Appareils** → **Approuver**. L'approbation passe par l'API REST, pas
par le canal temps réel, ce qui permet de la faire depuis le téléphone lui-même
sans second client déjà approuvé. La reconnexion aboutit dans les trente
secondes qui suivent.

## Development build iOS — préparée, pas activée

Tout ce qui pouvait l'être sans compte Apple est en place :

|                       |                                                                           |
| --------------------- | ------------------------------------------------------------------------- |
| `expo-dev-client`     | installé                                                                  |
| `eas.json`            | profil `development`, `developmentClient: true`, `distribution: internal` |
| Icône                 | `assets/icon.png`, 1024×1024, opaque                                      |
| Écran de lancement    | `assets/splash-icon.png` via le greffon `expo-splash-screen`              |
| Identifiant de paquet | `fr.nexus.client`                                                         |
| Projet EAS            | lié (`extra.eas.projectId`)                                               |

**Ce qui manque est hors du code** : Apple exige une adhésion au _Developer
Program_ (99 $/an) pour installer une application hors App Store sur un appareil
physique. La distribution `internal` d'EAS repose sur un profil ad hoc listant
l'UDID du téléphone, et seul un compte payant peut en émettre. Le _free
provisioning_ d'Apple existe mais passe obligatoirement par Xcode — donc par un
Mac — et ses certificats expirent au bout de sept jours.

Le jour où une solution de signature existe :

```bash
cd apps/mobile
pnpm exec eas-cli build --profile development --platform ios
pnpm start:dev-client
```

EAS demandera alors la connexion Apple, la création du certificat et du profil,
et l'enregistrement de l'UDID. Rien d'autre n'est à modifier dans le projet.

**Android n'a pas cette contrainte** : `--platform android` produit un APK
installable directement, avec l'icône et le nom NEXUS, sans compte payant.

## Particularités du dépôt

`metro.config.js` fait deux choses sans lesquelles rien ne s'empaquette :

- il déclare la racine du monorepo, car `@nexus/client-core` et
  `@nexus/protocol` sont des liens symboliques vers `packages/` ;
- il rattrape les imports terminés par `.js` qui désignent du TypeScript —
  forme correcte pour TypeScript en résolution `NodeNext`, que Metro ne résout
  pas seul. La résolution normale est tentée d'abord : un vrai fichier `.js`
  continue d'être résolu comme avant.

Ni `ios/` ni `android/` ne sont versionnés : la génération native est continue,
EAS les régénère depuis `app.json` et les greffons.

## Référence

- Architecture : [`docs/architecture/12-clients.md`](../../docs/architecture/12-clients.md)
- Réseau privé : [`docs/network/TAILSCALE.md`](../../docs/network/TAILSCALE.md)
