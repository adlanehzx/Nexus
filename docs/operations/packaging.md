# Paquets, signature et publication

## Ce qui est automatisé, et ce qui ne peut pas l'être

| artefact         | produit par                                         | signé par                                |
| ---------------- | --------------------------------------------------- | ---------------------------------------- |
| AppImage, `.deb` | workflow « Paquets », runner Linux                  | clé Tauri (`TAURI_SIGNING_PRIVATE_KEY`)  |
| paquet Arch      | `packaging/arch/PKGBUILD`, construit sur la machine | rien — Arch construit depuis les sources |
| MSI, NSIS        | runner Windows                                      | certificat de signature de code          |
| `.dmg`           | runner macOS                                        | certificat Apple, puis notarisation      |
| APK              | runner Linux + Gradle                               | keystore Android                         |
| TestFlight       | **manuel**, voir ci-dessous                         | certificat Apple                         |

**Aucun secret n'est nécessaire pour faire tourner le pipeline.** Sans
certificat ni keystore, les paquets sont produits **non signés** : utilisables
localement, refusés par SmartScreen et par Android. C'est délibéré — un pipeline
qui ne tourne qu'avec des secrets ne se teste jamais, et on ne découvre qu'il
est cassé que le jour de la publication. Chaque exécution écrit dans son résumé
si l'artefact est signé ou non.

## Le défaut qui empêchait tout

`apps/desktop/src-tauri/Cargo.toml` déclarait `keyring` avec
`features = ["windows-native"]` dans les dépendances **communes**. La coquille
était donc inconstructible ailleurs que sur Windows, ce qui rendait l'AppImage,
le `.deb` et le `.dmg` impossibles — sans qu'aucun message ne le dise, puisque
personne ne compilait pour Linux.

La dépendance est désormais déclinée par plateforme : le besoin est le même
partout — les jetons n'ont rien à faire dans un fichier de configuration ni dans
le stockage du moteur de rendu — c'est le magasin qui change de nom (Credential
Manager, Keychain, Secret Service).

Et le job `desktop-compile` compile la coquille sous Linux **à chaque poussée**,
pour que cette classe d'erreur ne puisse plus passer inaperçue. Il fait
`cargo check` et non `tauri build` : on vérifie que ça compile sur une autre
plateforme que Windows, pas qu'on sait fabriquer un paquet — ce dernier point
est le travail du workflow de publication.

## Signature des exécutables

### Ce que la signature apporte, et ce qu'elle n'apporte pas

Elle prouve que le paquet vient de qui détient la clé, et qu'il n'a pas été
modifié depuis. Elle ne dit rien de ce que le programme fait. Un binaire signé
peut être malveillant ; un binaire non signé peut être parfait. La signature
sert à rendre **détectable** une substitution, pas à valider un comportement.

### Les secrets, et où ils vivent

Jamais dans Git. Jamais dans un fichier du dépôt. Uniquement dans les secrets
du dépôt GitHub, lus par le workflow comme variables d'environnement :

```
TAURI_SIGNING_PRIVATE_KEY           clé de signature des mises à jour Tauri
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
APPLE_CERTIFICATE                   .p12 encodé en base64
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   notarisation
ANDROID_KEYSTORE_BASE64             .jks encodé en base64
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
```

Le keystore Android est écrit dans le répertoire temporaire du runner, jamais
dans l'arbre du dépôt — un fichier déposé dans l'arbre finit un jour dans un
`git add -A`.

### Générer la clé de mise à jour Tauri

```sh
pnpm --filter @nexus/desktop exec tauri signer generate -w ~/.nexus/tauri-update.key
```

La **clé publique** va dans `tauri.conf.json` (`plugins.updater.pubkey`), la
privée dans les secrets. Sans clé publique, l'updater reste `active: false` :
un updater sans clé accepterait n'importe quel paquet, ce qui est pire que pas
d'updater.

### Android : pourquoi un APK non signé plutôt qu'un échec

Échouer sans keystore rendrait la chaîne impossible à vérifier : personne ne
saurait si le build casse à cause du code ou de l'absence de clé. Produire un
APK non signé prouve tout sauf la signature, et donne un artefact qui refuse de
s'installer — exactement ce qu'on veut d'un paquet sans clé.

`enableV1Signing` reste active : un téléphone sous Android 10 ou plus ancien
n'installe pas un APK signé uniquement en V2.

## Installateur Windows du worker

Le MSI produit par Tauri installe la **coquille de bureau**. Le worker est autre
chose : un démon Node sans interface, qui doit tourner sans session ouverte.
D'où `packaging/windows/nexus-worker.nsi`, un installateur à lui, construit par
le runner Windows du workflow de publication.

NSIS plutôt que MSI : un MSI demande WiX et une chaîne de construction de plus,
pour un gain nul ici — il n'y a ni déploiement par stratégie de groupe ni
désinstallation pilotée à distance.

Quatre décisions y sont explicites, et chacune évite une panne précise.

**Installation par machine.** Un service Windows est une ressource de la
machine ; l'installer dans le profil d'un utilisateur produirait un service dont
les fichiers disparaissent quand ce profil est supprimé.

**La configuration vit hors de `Program Files`.** Ce dossier est en lecture
seule pour les utilisateurs, et un service qui ne peut pas lire sa configuration
échoue sans dire pourquoi. Elle va dans `%APPDATA%\NEXUS\worker.env`, et une
réinstallation ne l'écrase pas.

**Node n'est pas embarqué.** L'embarquer figerait une version qu'il faudrait
mettre à jour nous-mêmes à chaque correctif de sécurité — or ce worker exécute
des commandes sur la machine, c'est le dernier endroit où l'on veut un runtime
en retard. L'installateur vérifie sa présence et refuse proprement s'il manque.

**Le service n'est pas installé automatiquement.** Il faut d'abord renseigner
l'identifiant d'appareil, l'adresse du cœur et le chemin de la clé privée. Un
service installé et démarré avant cela échoue en boucle, remplit le journal
d'événements, et donne l'impression que l'installation a raté alors qu'elle a
réussi. L'installateur affiche les trois commandes à lancer.

La désinstallation arrête et supprime le service **avant** les fichiers —
l'inverse laisse un service qui redémarre en boucle sur un binaire absent — et
conserve la configuration : une mise à jour passe par une désinstallation, et
emporter l'identifiant d'appareil obligerait à réappairer à chaque fois.

## Service Windows

`packaging/windows/install-worker-service.ps1`, via `sc.exe` — présent partout,
contrairement à un empaqueteur tiers qu'il faudrait installer d'abord.

| décision                                            | raison                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| compte de service, pas `LocalSystem`                | `LocalSystem` donnerait les droits complets de la machine, ce qui annulerait la politique locale : les refus par chemin ne protègent plus rien si le processus peut tout |
| redémarrage automatique **borné** (5 s, 30 s, 60 s) | un worker qui plante en boucle et redémarre aussitôt transforme un défaut en charge                                                                                      |
| aucun secret en argument                            | une ligne de commande de service est lisible par tout le monde dans le gestionnaire de tâches ; la clé est désignée par un chemin                                        |
| `delayed-auto`                                      | démarre après les services système, pour ne pas allonger le démarrage de la machine                                                                                      |

Le script refuse d'installer un service dont le `.env` est absent, et avertit si
ce fichier hérite des droits de son dossier parent — il désigne le chemin de la
clé privée de cette machine.

## iOS et TestFlight

### Ce qui est fait ici, et ce qui ne peut pas l'être

Rien d'iOS ne peut être construit ni vérifié depuis ce dépôt sans un Mac et un
compte développeur Apple. Ce document décrit donc la procédure ; il ne prétend
pas l'avoir exécutée.

### Préparation, une fois

1. **Compte développeur Apple** (99 €/an) et un identifiant d'application —
   `fr.nexus.mobile` — créé dans App Store Connect.
2. **Profil de provisionnement** de type _App Store_, lié au certificat de
   distribution.
3. **Capacités** : NEXUS mobile demande le micro (dictée) et les notifications.
   Chaque capacité demandée doit être justifiée dans la fiche App Store, et une
   capacité inutilisée est un motif de rejet.
4. **Déclaration de confidentialité.** C'est le point qui demande le plus
   d'attention et le seul qui ne soit pas technique : l'application parle à
   _votre_ serveur, pas au nôtre. La fiche doit dire que les données ne quittent
   pas l'infrastructure de l'utilisateur, et que l'audio de dictée n'est pas
   conservé — ce qui est vrai, et vérifié par les tests de `@nexus/voice`.

### Monter une version

```sh
cd apps/mobile
pnpm expo prebuild --platform ios
cd ios && pod install
xcodebuild -workspace NEXUS.xcworkspace -scheme NEXUS \
  -configuration Release -archivePath build/NEXUS.xcarchive archive
xcodebuild -exportArchive -archivePath build/NEXUS.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/ipa
xcrun altool --upload-app -f build/ipa/NEXUS.ipa \
  -u "$APPLE_ID" -p "$APPLE_APP_PASSWORD"
```

### Ce à quoi s'attendre au premier envoi

- **Rejet probable sur le champ « à quoi sert le micro ».** Une description
  vague — « améliorer l'expérience » — est rejetée. Écrire « dicter un message à
  son assistant personnel, l'audio est transcrit sur l'appareil et n'est pas
  conservé ».
- **Une application qui exige un serveur personnel** demande une explication et
  un compte de démonstration. Sans serveur joignable par le relecteur, il ne
  peut rien voir, et le rejet est automatique. Prévoir une instance de
  démonstration **jetable**, jamais la sienne.
- **Pas de mise à jour automatique hors App Store** sur iOS : `UpdatePolicy`
  n'y sert qu'à informer, l'installation passe par le magasin.

## Mise à jour automatique

La décision est prise par `UpdatePolicy` dans `@nexus/client-core`, qui ne
télécharge ni n'installe rien — c'est l'hôte qui applique, et qui vérifie la
signature. Les refus sont documentés dans `docs/architecture/12-clients.md` :
pas de paquet non signé, pas de retour en arrière, pas de changement de canal,
pas de version majeure sans accord.
