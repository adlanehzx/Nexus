# @nexus/browser-worker-host

Raccorde **Browser Use au WorkerGateway de NEXUS**. C'est le troisième exécutant
de la flotte, après le worker Windows (phase 7) et le worker Android (phase 8),
et il utilise exactement le même runtime.

**État : implémenté et testé.** 55 tests, dont 4 de bout en bout contre le vrai
worker Python.

---

## Le problème que ce paquet résout

Le worker Browser Use existait déjà — un service Python complet, avec ses
sessions, ses politiques d'intention et ses 75 tests — mais il vivait **à côté**
de NEXUS plutôt que dedans :

|                                 | Avant                     | Maintenant                            |
| ------------------------------- | ------------------------- | ------------------------------------- |
| Authentification auprès du cœur | jeton de service statique | **signature d'un défi Ed25519**       |
| Identité                        | aucune                    | un appareil du registre, révocable    |
| Session                         | aucune                    | `DeviceSessionService`, avec rotation |
| Capacités                       | non annoncées             | **annoncées et enregistrées**         |
| Sélection                       | jamais choisi par le cœur | `DeviceSelector`, sur capacités       |
| Permissions                     | hors du modèle            | `browser.*`, comme toute capacité     |
| Confirmations                   | outil isolé               | `ConfirmationBroker`, par risque      |
| Santé, disponibilité            | invisibles                | battements et sondes                  |

Le type `BROWSER_WORKER` existait dans `@nexus/devices` depuis l'origine, avec
ce commentaire : « Browser Use est un exécutant à part entière du point de vue
du sélecteur ». Rien ne l'implémentait. C'est ce que fait ce paquet.

---

## Architecture

```
Utilisateur → Agent → plan → capacités requises → autorisation
                                                      │
                                              WorkerGateway
                                                      │
                                     session authentifiée (Ed25519)
                                                      │
                                       @nexus/browser-worker-host
                                                      │  HTTP, contrat versionné
                                        services/browser-worker (Python)
                                                      │
                                            browser-use → Chromium
```

**Deux processus, deux raisons.** Un Chromium qui plante ne doit pas emporter la
session avec le cœur, et le processus qui visite du contenu hostile ne doit pas
détenir la clé de l'appareil. La frontière est un contrat HTTP, jamais un
binding (ADR-006).

**Ce paquet ne pilote aucun navigateur.** Il traduit des capacités NEXUS en
appels au worker Python. Tout le cycle de vie — poignée de main, enregistrement,
battements, dispatch, annulation, reprise — vient de `@nexus/worker-core`, sans
une ligne dupliquée.

---

## Capacités

Une capacité **par intention**, jamais une capacité générique. C'est ce qui
permet au reste de NEXUS de faire son travail sans rien savoir du navigateur :
lire un prix et payer sont techniquement le même clic, mais ce ne sont pas les
mêmes actes.

| Capacité           | Intention  | Risque       | Confirmation\* | Ce que le worker Python retire      |
| ------------------ | ---------- | ------------ | -------------- | ----------------------------------- |
| `browser.navigate` | `read`     | **LOW**      | non            | clic, saisie, onglets, JS, fichiers |
| `browser.interact` | `interact` | **MEDIUM**   | oui            | JS, fichiers                        |
| `browser.login`    | `login`    | **HIGH**     | oui            | JS, fichiers                        |
| `browser.purchase` | `purchase` | **CRITICAL** | oui            | JS, fichiers                        |

\* au seuil par défaut (`MEDIUM`).

Le nom de la capacité **est** le nom de la permission :
`permissionForCapability` est l'identité, et l'utilisateur lit dans ses réglages
exactement ce qu'il autorise.

**L'intention n'est pas déclarative.** Le worker Python restreint réellement les
actions disponibles (`app/policies.py`) : un `browser.navigate` ne peut pas
cliquer, même si le modèle le lui demande, et `evaluate` — du JavaScript
arbitraire — est retiré pour **toutes** les intentions.

### Pourquoi la politique n'est pas ici

Le cœur décide _ce qu'on veut faire_, le worker décide _ce qu'il est possible de
faire_. Un cœur compromis ne doit pas pouvoir transformer une lecture en achat.
Dupliquer la politique dans l'hôte donnerait deux politiques qui divergent — et
c'est toujours la plus permissive qui gagne. Un test vérifie qu'aucune règle
d'action n'est réimplémentée ici.

---

## Sessions navigateur

**Une session par tâche NEXUS.**

- Les **étapes d'une même tâche** la réutilisent : « connecte-toi puis
  commande » perdrait sa connexion entre les deux étapes autrement.
- **Deux tâches ne la partagent jamais** : une tâche qui s'est connectée à une
  banque ne doit pas laisser sa session ouverte à la suivante, qui visitera
  peut-être un site hostile.

Le cloisonnement entre utilisateurs est un cran au-dessus : le registre lie
chaque appareil à un `userId` à l'appairage, et un exécutant navigateur n'y
échappe pas.

À l'arrêt, les navigateurs sont fermés — un Chromium oublié survit au processus.

---

## Installation

```bash
# 1. Le worker Python doit tourner (voir services/browser-worker/README.md).

# 2. Enregistrer l'exécutant côté cœur : type BROWSER_WORKER, rôle WORKER.
#    Le cœur attribue DEVICE_ID et les permissions.

# 3. Générer la clé de l'appareil et déposer sa moitié publique au registre :
openssl genpkey -algorithm ed25519 -out device.pem
openssl pkey -in device.pem -pubout

# 4. Copier .env.example en .env et renseigner.

pnpm --filter @nexus/browser-worker-host build
node -e "import('@nexus/browser-worker-host').then(m => m.runBrowserWorkerHost())"
```

---

## Sécurité

| Propriété                          | Mise en œuvre                                                     |
| ---------------------------------- | ----------------------------------------------------------------- |
| Pas de secret partagé avec le cœur | signature d'un défi ; la clé ne circule jamais                    |
| Deux liens, deux secrets           | le jeton du worker Python ne franchit jamais la frontière du cœur |
| Aucune connexion entrante          | `connect()` existe, `listen()` n'existe pas — vérifié par un test |
| Aucune exécution de commande       | ni `child_process`, ni `exec` — vérifié sur tout le source        |
| Un seul accès disque               | la clé de l'appareil, dans `link.ts` — vérifié sur tout le source |
| Aucune capacité générique          | quatre capacités nommées, rien qui prenne une action en argument  |
| URL restreintes à `http`/`https`   | `javascript:`, `file:`, `data:` refusés avant de voyager          |
| Liaison distante en clair          | refusée, vers le cœur **et** vers le worker Python                |
| Secrets hors des journaux          | `describeConfig()` ne rend que des noms et des présences          |
| CAPTCHA, MFA                       | jamais contournés — `BROWSER_NEEDS_HUMAN`, non réessayable        |
| Chaîne de pensée du modèle         | tronquée à 120 caractères dans la progression                     |

---

## Tests

```bash
pnpm --filter @nexus/browser-worker-host test          # 51 tests, sans Python

NEXUS_WORKER_PYTHON=services/browser-worker/.venv/Scripts/python.exe \
  pnpm --filter @nexus/browser-worker-host test        # + 4 tests de bout en bout
```

Le seul double est le worker Python, et il est remplacé **au niveau HTTP** : le
client sérialise, valide et interprète réellement les codes d'erreur. Tout le
reste est réel — vraies clés Ed25519, vraie `WorkerGateway`, vrai
`DeviceSessionService`, vraies enveloppes du protocole.

---

## Limites connues

1. **Aucun navigateur réel n'a été piloté.** Les tests de bout en bout lancent le
   vrai worker Python et prouvent la chaîne complète jusqu'à lui ; ils
   n'atteignent pas `browser-use` ni Chromium, qui demandent une clé de modèle
   et un accès réseau. Le worker Python a ses propres tests `-m browser` pour
   cela.
2. **`packages/browser-client` expose toujours `createBrowserTools`**, l'ancien
   chemin direct (outils `browser.read/interact/login/purchase` appelant le
   worker Python sans passer par le cœur). Il n'est câblé nulle part. Le chemin
   canonique est celui de ce paquet ; retirer l'ancien est une tâche à part,
   volontairement non faite ici pour ne pas supprimer du code testé sans
   demande.
3. **Trois adaptateurs de transport coexistent** — un par exécutant (`ws` +
   épinglage TLS pour Windows, `WebSocket` de React Native pour Android,
   `WebSocket` de Node ici). La logique, elle, n'est pas dupliquée : elle vit
   entièrement dans `WorkerRuntime`. Les consolider dans un paquet
   `@nexus/worker-node` est possible, mais demanderait de toucher aux phases 7
   et 8, qui sont terminées.
4. **Pas d'épinglage du certificat du cœur.** `NEXUS_CORE_FINGERPRINT` est lu par
   la configuration mais le `WebSocket` de Node n'expose pas
   `checkServerIdentity`. Cet hôte est déployé aux côtés du cœur, sur un réseau
   interne ; le worker Windows, qui traverse Internet, l'épingle.
