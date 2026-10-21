# @nexus/android-worker

Exécutant Android : capacités locales contrôlées, connexion **sortante** vers le
cœur NEXUS.

**État : application Android complète et éprouvée sur émulateur.** 188 tests
automatisés, `./gradlew assembleDebug` produit un APK, et les sept capacités ont
été exécutées pour de vrai contre un cœur réel sur un Pixel 8 (API 36).
**Rien n'a encore tourné sur le Redmi Note 10S** — voir §Limites.

Le Redmi Note 10S est un **exécutant**, pas un client. L'iPhone 17 et le
portable Windows restent les interfaces NEXUS.

---

## Le principe

```
Android Worker ──(WebSocket sortant, wss://)──▶ NEXUS Core
                                                   │
                                            WorkerGateway
                                                   │
                                  TaskCoordinator ◀── DeviceSelector
                                                   │
                                                 Agent
```

Le téléphone appelle le cœur ; le cœur ne sait pas joindre un téléphone. Aucun
port entrant, aucune redirection, aucune communication directe client → Redmi.

Rien n'est spécifique au Redmi : c'est une ligne en base, de type `ANDROID` et de
rôle `WORKER`. Chercher « Redmi » dans le code ne donne rien.

---

## Ce que le worker partage avec les autres exécutants

|                                                            | Provenance                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| Cycle de vie, poignée de main, reprise, battements de cœur | `@nexus/worker-core` — **le même code que le worker Windows** |
| Registre de capacités, exécution d'étape, idempotence      | `@nexus/worker-core`                                          |
| Authentification, sessions, anti-rejeu                     | `DeviceSessionService` de `@nexus/devices`, inchangé          |
| Protocole de fil, événements                               | `@nexus/protocol`, inchangé                                   |

Ce paquet n'ajoute que ce qui est propre à un téléphone : quatre ports Android,
trois politiques, sept capacités, la santé de batterie, et la surveillance de
disponibilité.

---

## Contraintes Android, et ce qu'elles imposent

Android n'autorise pas le contrôle à distance arbitraire. Ce worker ne cherche
pas à contourner ce principe ; il en tire sa conception.

| Capacité                | Mécanisme Android                             | Permission                                   | Accordée par                                                                        |
| ----------------------- | --------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `android.app.list`      | `queryIntentActivities`                       | `<queries>` sur `MAIN`/`LAUNCHER`            | le manifeste, sans action de l'utilisateur                                          |
| `android.app.open`      | `getLaunchIntentForPackage` + `startActivity` | — (+ exemption de lancement en arrière-plan) | service d'accessibilité actif, ou MIUI : « fenêtres contextuelles en arrière-plan » |
| `android.ui.click`      | `AccessibilityNodeInfo.ACTION_CLICK`          | `BIND_ACCESSIBILITY_SERVICE`                 | **l'utilisateur**, Réglages → Accessibilité                                         |
| `android.ui.input`      | `ACTION_SET_TEXT`                             | idem                                         | idem                                                                                |
| `android.ui.scroll`     | `ACTION_SCROLL_*` / `dispatchGesture`         | idem                                         | idem                                                                                |
| `android.ui.screenshot` | `AccessibilityService.takeScreenshot()`       | idem + Android 11                            | idem                                                                                |
| `android.notification`  | `NotificationManager.notify()`                | `POST_NOTIFICATIONS` (Android 13+)           | l'utilisateur, à la demande                                                         |

### `QUERY_ALL_PACKAGES` n'est pas demandé

Depuis Android 11, la visibilité des paquets est filtrée. La permission globale
existe, mais Google la restreint et elle donnerait l'inventaire logiciel complet
— qui en dit long sur le propriétaire du téléphone. Le manifeste déclare à la
place une requête sur les activités lançables : exactement les applications
ouvrables, et rien d'autre.

### `MediaProjection` a été écarté

|                         | `takeScreenshot()`                      | `MediaProjection`            |
| ----------------------- | --------------------------------------- | ---------------------------- |
| Permission              | le service d'accessibilité, déjà activé | dialogue système dédié       |
| Portée                  | **une image, sur appel**                | un flux vidéo continu        |
| Jeton                   | aucun                                   | valide bien après la capture |
| Service de premier plan | non                                     | oui, permanent               |

`MediaProjection` donne un flux ; nous avons besoin d'une image. Le prendre
« parce qu'il marche partout » installerait une autorisation d'enregistrement
d'écran permanente pour un besoin ponctuel. Le prix : sous Android 10 et
antérieur, la capacité n'est pas annoncée. Le Redmi Note 10S est livré sous
Android 11.

### Ed25519 n'existe pas dans le magasin de clés d'Android

Le choix se pose entre une clé Ed25519 **logicielle**, cohérente avec les autres
appareils mais lisible par quiconque obtient les fichiers de l'application, et
une clé **ECDSA P-256 adossée au matériel**, non extractible. On préfère la
résistance à l'extraction à l'uniformité.

`DeviceSessionService` acceptait déjà un vérificateur injectable :
`ecdsaP256Verifier` a été ajouté à côté d'`ed25519Verifier`, et
`DeviceCredential.kind` gagne `ECDSA_P256_PUBLIC_KEY`. **Ce n'est pas un second
système d'authentification** — challenge, session, rotation et anti-rejeu sont
identiques ; seule la primitive de vérification change.

---

## Construire l'APK

Prérequis : JDK 17, `ANDROID_HOME` renseigné. Le reste — Gradle 8.14.3, le
greffon Android, la plateforme Android 36 — se télécharge tout seul.

```bash
pnpm install

# 1. Éditer `nexus.config.json` : URL du cœur, DEVICE_ID, capacités voulues.
#    AUCUN SECRET n'y figure — la clé de l'appareil est désignée par un ALIAS
#    dans le magasin de clés d'Android et ne quitte jamais le téléphone.

# 2. Construire.
cd services/android-worker/android
./gradlew assembleDebug          # armeabi-v7a + arm64-v8a (téléphones)

# Sur émulateur x86, préciser l'architecture :
./gradlew assembleDebug -PreactNativeArchitectures=x86_64

# 3. L'APK : app/build/outputs/apk/debug/app-debug.apk
```

Une construction de débogage charge son JavaScript depuis Metro
(`node node_modules/react-native/cli.js start`, puis `adb reverse tcp:8081 tcp:8081`).
`assembleRelease` embarque le paquet ; il sort **non signé** tant qu'une clé n'est
pas fournie hors dépôt — mieux vaut un artefact qui refuse de s'installer qu'une
clé de signature versionnée.

---

## Installation

### APK publié (recommandé)

1. Installer l'APK **signé** de la release NEXUS.
2. Dans le dashboard, ouvrir **Appareils**, créer un code et choisir
   **Copier le lien Android**.
3. Au premier lancement du worker, coller ce lien puis toucher **Appairer**.
4. Revenir dans le dashboard et approuver l'appareil.

Le même APK sert à tous les téléphones : aucune URL ni aucun identifiant
personnel n'est compilé dedans. La clé ECDSA P-256 est créée dans Android
Keystore ; seul son certificat public est envoyé au cœur.

### Depuis les sources

```bash
# 1. Enregistrer l'appareil côté cœur : type ANDROID, rôle WORKER.
#    Le backend attribue DEVICE_ID et les permissions.

# 2. Installer l'APK sur le Redmi.

# 3. Ouvrir NEXUS Worker. L'écran de gestion affiche la clé publique de
#    l'appareil (ECDSA P-256, générée dans le magasin de clés au premier
#    lancement) : la remettre au backend, puis approuver l'appareil.

# 4. Accorder les autorisations depuis l'écran de gestion :
#    - Service d'accessibilité  → Réglages → Accessibilité → NEXUS Worker
#    - Notifications            → Réglages → Applications → NEXUS Worker

# 5. Réglages spécifiques MIUI, sans lesquels le worker sera tué ou bloqué :
#    - Autostart                                      → activer
#    - Économiseur de batterie                        → « Aucune restriction »
#    - Afficher les fenêtres contextuelles en arrière-plan → activer
```

`.env.example` ne contient que des marqueurs — un test le vérifie. La clé de
l'appareil y est désignée par un **alias**, jamais par sa valeur.

---

## Sécurité

- **Un identifiant d'appareil n'authentifie rien.** Challenge signé à chaque
  connexion ; la clé privée ne quitte pas le magasin de clés.
- **Aucun point d'entrée générique.** `ports.ts` est la liste exhaustive de ce
  que le JavaScript peut demander au système : pas d'`Intent` arbitraire, pas de
  `runCommand`, pas d'`invoke(nom, args)`. Trois tests le vérifient sur le code
  source.
- **`android.app.open` n'accepte qu'un nom de paquet**, validé par forme, puis
  filtré par une liste de refus qui l'emporte toujours sur la liste
  d'autorisation. Réglages, installateur de paquets, portefeuilles et
  gestionnaires de mots de passe sont fermés quoi qu'il arrive.
- **Les clics par coordonnées sont désactivés par défaut.** Cliquer en
  (540, 1200) touche ce qui s'y trouve, pas ce qu'on visait.
- **Le texte saisi ne sort jamais** : ni journal, ni événement, ni résultat.
  `android.ui.input` déclare `secretArguments: ["text"]`, ce que la rédaction
  générique ne pouvait pas deviner d'un champ nommé `text`.
- **Les captures ne sont ni journalisées, ni écrites sur disque, ni conservées**
  par le cœur : la capacité déclare `sensitiveResult`, et le journal d'exécution
  n'en garde qu'une mention. Un test vérifie qu'aucun fichier n'est écrit.
- **Cadence de capture bornée** — la barrière contre l'enregistrement continu par
  accumulation.
- **Disponibilité revérifiée à chaque appel**, pas seulement au démarrage :
  l'utilisateur peut désactiver le service d'accessibilité pendant qu'une tâche
  tourne, et c'est son droit.
- **Le worker ne fait pas confiance au cœur** sur ce qui est permis localement :
  un cœur compromis ne doit pas suffire à lui faire exécuter une capacité que
  l'utilisateur a désactivée.

### Ce qui n'existe pas, et ne doit pas exister

Lecture des notifications · enregistrement d'écran continu · micro · caméra ·
SMS · contacts · position · `QUERY_ALL_PACKAGES`. Des tests scannent le code et
le manifeste pour chacun.

---

## Santé et état dégradé

Un téléphone à 8 % de batterie reste joignable et capable, mais exécuter une
automatisation d'interface dessus le vide et coupe le réveil du lendemain.

| Batterie                                   | État        | Effet                                                                   |
| ------------------------------------------ | ----------- | ----------------------------------------------------------------------- |
| > 20 %, ou en charge                       | normal      | tâches ordinaires                                                       |
| ≤ 20 % sur batterie, ou économie d'énergie | **dégradé** | capacité annoncée réduite à 1 ; le sélecteur préfère un autre exécutant |
| ≤ 10 % sur batterie                        | saturé      | refuse toute nouvelle tâche                                             |

Rien d'autre n'est remonté : ni position, ni réseau, ni identité, ni liste
d'applications ouvertes.

---

## Liste de vérification sur appareil physique

**Aucun de ces points n'a été exécuté.** Il n'y a pas de Redmi Note 10S dans
l'environnement de développement, et le comportement du système Android ne peut
pas être validé par des tests unitaires. Cette liste est à dérouler sur
l'appareil réel avant de considérer le worker opérationnel.

| #   | Vérification                               | Attendu                                                                         |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| 1   | Installer l'APK                            | l'application se lance                                                          |
| 2   | Appairer l'appareil auprès de NEXUS        | la clé publique s'affiche, le backend l'accepte                                 |
| 3   | Approuver l'appareil côté cœur             | `trust` passe à `TRUSTED`                                                       |
| 4   | Accorder les notifications                 | l'écran passe la ligne en « accordée »                                          |
| 5   | Activer le service d'accessibilité         | idem, et les capacités d'interface apparaissent                                 |
| 6   | Vérifier la capture                        | ligne « accordée » (Android ≥ 11)                                               |
| 7   | Démarrer le worker                         | état « prêt »                                                                   |
| 8   | Vérifier côté NEXUS                        | l'appareil est `ONLINE`                                                         |
| 9   | Vérifier les capacités annoncées           | les sept, ou le sous-ensemble configuré                                         |
| 10  | `android.app.open` sur Spotify             | l'application s'ouvre à l'écran                                                 |
| 11  | `android.ui.screenshot`                    | une image revient sur le client, lisible                                        |
| 12  | `android.ui.click` sur un bouton identifié | l'appui a lieu                                                                  |
| 13  | `android.ui.input` dans un champ           | le texte apparaît ; **vérifier qu'il n'est nulle part dans les journaux**       |
| 14  | `android.ui.scroll`                        | l'écran défile                                                                  |
| 15  | `android.notification`                     | la notification s'affiche                                                       |
| 16  | Désactiver le service d'accessibilité      | les trois capacités d'interface disparaissent du registre en moins d'une minute |
| 17  | Vérifier côté client                       | un `device.capabilities_changed` est reçu                                       |
| 18  | Réactiver le service                       | les capacités reviennent                                                        |
| 19  | Couper le Wi-Fi et les données             | le worker passe `reconnecting`                                                  |
| 20  | Rétablir le réseau                         | reconnexion, nouvelle poignée de main complète                                  |
| 21  | Révoquer l'appareil côté cœur              | la session est invalidée                                                        |
| 22  | Tenter une tâche                           | refusée ; le worker ne peut plus rien exécuter                                  |
| 23  | Laisser la batterie descendre sous 20 %    | l'appareil passe `dégradé`                                                      |
| 24  | Verrouiller l'écran 30 minutes             | la connexion tient (réglages MIUI appliqués)                                    |

---

## Le canal vers le cœur

Le worker dépend du port `WorkerLink` de `@nexus/worker-core`, pas du WebSocket :

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

Il y a `connect()`, il n'y a pas `listen()` : ce worker ne peut structurellement
pas accepter de connexion entrante.

`AndroidWebSocketLink` (`src/connection/websocket-link.ts`) l'implémente sur le
`WebSocket` de React Native — celui de la norme du navigateur, adossé à OkHttp.
Il ouvre la socket vers `NEXUS_BACKEND_URL`, transmet les enveloppes JSON dans
les deux sens et signale la fermeture. **Aucune logique** : authentification,
enregistrement, dispatch, annulation, reprise et événements vivent dans
`WorkerRuntime`, partagé avec le worker Windows.

Trois protections lui sont propres :

|                           |                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adresse distante en clair | **refusée** — un téléphone se connecte depuis n'importe quel réseau. `localhost` et `10.0.2.2` (l'hôte vu de l'émulateur) sont les seules exceptions |
| Délai d'établissement     | 15 s. React Native n'en applique aucun ; sans lui, un portail captif suspendrait la reprise indéfiniment                                             |
| Trame descendante         | plafonnée à 256 Ko, et seul le texte est accepté                                                                                                     |

### Épingler le cœur

Le worker Windows épingle la clé publique du cœur dans `checkServerIdentity`.
**React Native n'expose pas d'équivalent** : le `WebSocket` du pont ne donne pas
accès au certificat présenté. L'épinglage se fait donc là où Android le permet,
dans `android/src/main/res/xml/network_security_config.xml` :

```xml
<domain-config>
    <domain includeSubdomains="true">nexus.exemple.fr</domain>
    <pin-set expiration="2027-01-01">
        <pin digest="SHA-256">EMPREINTE_BASE64_DE_LA_CLE_PUBLIQUE</pin>
        <pin digest="SHA-256">EMPREINTE_DE_SECOURS</pin>
    </pin-set>
</domain-config>
```

C'est la plateforme qui applique la règle, sous la pile réseau — donc sous
React Native, sous OkHttp, et sans qu'aucun code JavaScript puisse la contourner.
Toujours déclarer une empreinte de secours : un épinglage sans rechange
transforme un renouvellement de clé en réinstallation de l'APK.

---

## Ce qui a été réellement observé

Sur un émulateur **Pixel 8, API 36**, contre un cœur réel (vrai `WorkerGateway`,
vrai `DeviceSessionService`, vraie vérification `ecdsaP256Verifier`) :

| Étape                                         | Résultat                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `./gradlew assembleDebug`                     | APK produit                                                                                  |
| Installation, lancement                       | l'écran de gestion s'affiche                                                                 |
| Clé de l'appareil                             | ECDSA P-256 **créée dans AndroidKeyStore** au premier lancement                              |
| Poignée de main                               | `hello` → challenge → signature du Keystore → session ouverte                                |
| Enregistrement                                | 3 capacités d'abord, **7 après activation de l'accessibilité**, réannoncées sans redémarrage |
| Battements                                    | continus sur 8 minutes                                                                       |
| `android.app.list`                            | vraie liste du `PackageManager`                                                              |
| `android.notification`                        | notification réellement postée                                                               |
| `android.ui.screenshot`                       | PNG de 203 Ko capturé par le service d'accessibilité                                         |
| `android.ui.scroll`                           | geste réellement dispatché                                                                   |
| `android.ui.click` sur un élément absent      | `ANDROID_UI_NODE_NOT_FOUND`                                                                  |
| `android.app.open` sur les Réglages           | **refusé par `AppPolicy`**                                                                   |
| `android.ui.click` avec accessibilité éteinte | **`CAPABILITY_UNAVAILABLE`** — non annoncée, donc non choisie                                |

---

## Limites connues

1. **Aucun test n'a tourné sur un Redmi Note 10S.** Un Pixel 8 sous Android
   d'origine ne reproduit ni MIUI, ni son autostart, ni son tueur de tâches —
   c'est-à-dire précisément ce qui est risqué. La liste de vérification
   ci-dessus reste à dérouler.
2. **`WorkerActivity` et `ui/` ne sont pas couverts par le typecheck du dépôt.**
   Ils sont compilés par Metro, avec sa propre résolution de modules. Le code
   métier, lui, est dans `src/` et l'est intégralement.
3. **L'épinglage du cœur n'est pas activé par défaut** : il exige l'empreinte du
   certificat, qui dépend du déploiement. Sans lui, l'identité du cœur repose
   sur les autorités du système — c'est un cran en dessous du worker Windows.
4. **L'annulation est côté JavaScript.** Le pont React Native ne transporte pas
   d'`AbortSignal` : le Kotlin ne l'observe pas. L'appui a peut-être déjà eu lieu
   quand l'annulation arrive.
5. **`android.app.open` peut être bloqué** par les restrictions de lancement en
   arrière-plan, notamment sur MIUI. L'erreur le dit et indique quoi activer.
6. **Le sondage de disponibilité est périodique** (30 s par défaut) : Android ne
   diffuse pas l'activation d'un service d'accessibilité.
7. **Aucun test n'a été fait sur Android < 11** : la capture n'y serait pas
   annoncée, ce qui est le comportement voulu mais n'a pas été observé.
8. **Le code partagé suppose Node.** `@nexus/shared` utilise `node:crypto` et
   `Buffer`, absents du moteur JavaScript d'Android. `shim/` les traduit — l'aléa
   vient de `java.security.SecureRandom`, jamais de `Math.random`. Ce qui n'est
   pas implémenté lève plutôt que d'approximer.
9. **L'architecture historique de React Native est utilisée** (`newArchEnabled=false`).
   Elle est dépréciée et disparaîtra ; migrer demandera de réécrire le pont en
   TurboModule.
