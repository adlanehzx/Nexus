# Browser Worker

Worker Python isolé qui pilote un navigateur via [browser-use](https://github.com/browser-use/browser-use).

**État : implémenté et testé.** 75 tests unitaires et d'intégration, 11 tests de
contrat TS ↔ Python, 6 tests de communication réelle, 2 tests end-to-end sur un
site local (optionnels).

---

## Pourquoi un service séparé

Trois raisons, aucune négociable :

1. **Langage.** Le backend est TypeScript, `browser-use` est Python. La frontière
   est un contrat HTTP, jamais un binding (ADR-006).
2. **Ressources.** Un Chromium consomme 300 Mo à 1 Go et peut planter. Il ne doit
   pas pouvoir faire tomber l'API.
3. **Sécurité.** Le navigateur visite du contenu hostile par définition. Il tourne
   sans port publié, sans secret applicatif, en utilisateur non privilégié.

```
Agent Core ─▶ BrowserWorkerClient ─▶ Browser Worker ─▶ browser-use ─▶ Chromium
  (TS)            (TS, HTTP)            (Python)
```

---

## Installation

### En local

```bash
cd services/browser-worker

python -m venv .venv                 # Python 3.11 ou plus récent
.venv/Scripts/activate               # Windows ;  source .venv/bin/activate ailleurs
pip install -e ".[dev]"
python -m playwright install chromium

export BROWSER_WORKER_AUTH_TOKEN=$(openssl rand -hex 32)
export BROWSER_WORKER_LLM_API_KEY=...          # clé Anthropic

uvicorn app.main:build --factory --port 8100
curl http://localhost:8100/v1/health
```

L'installation télécharge Chromium (~150 Mo) et une centaine de paquets ; comptez
plusieurs minutes la première fois.

### Avec Docker

Le worker est un **profil optionnel** : son image embarque Chromium (~1,5 Go) et
n'a aucune raison de démarrer quand on travaille sur l'API.

```bash
# Dans le .env à la racine :
BROWSER_WORKER_TOKEN=$(openssl rand -hex 32)
LLM_API_KEY=...

pnpm docker:browser        # construit et démarre le seul worker
```

Aucun port n'est publié : le worker n'est joignable que depuis le réseau Docker
interne. C'est délibéré — **ne l'exposez jamais à Internet.**

---

## Configuration

Toutes les variables sont préfixées `BROWSER_WORKER_` et validées au démarrage :
une valeur manquante empêche le boot plutôt que d'échouer à la première requête.

| Variable                       | Défaut              | Rôle                                                     |
| ------------------------------ | ------------------- | -------------------------------------------------------- |
| `AUTH_TOKEN`                   | —                   | **Obligatoire**, 16 caractères minimum. Jeton de service |
| `LLM_MODEL`                    | `claude-sonnet-4-5` | Modèle qui pilote le navigateur                          |
| `LLM_API_KEY`                  | —                   | Clé du fournisseur                                       |
| `HEADLESS`                     | `true`              | `false` pour voir le navigateur, utile au débogage       |
| `MAX_SESSIONS`                 | `5`                 | Navigateurs simultanés                                   |
| `SESSION_TTL_SECONDS`          | `600`               | Durée de vie d'une session inactive                      |
| `DEFAULT_TASK_TIMEOUT_SECONDS` | `180`               | Délai d'une tâche                                        |
| `ALLOW_PRIVATE_HOSTS`          | `false`             | **Tests seulement.** Autorise `127.0.0.1`                |
| `LOG_LEVEL`                    | `INFO`              |                                                          |

---

## API

Toutes les routes exigent `Authorization: Bearer <token>`, sauf `/v1/health` —
qui doit rester joignable même quand le jeton est mal configuré, sinon le
diagnostic devient impossible.

| Verbe    | Route                     | Rôle                                          |
| -------- | ------------------------- | --------------------------------------------- |
| `GET`    | `/v1/health`              | État, version du protocole, sessions ouvertes |
| `POST`   | `/v1/sessions`            | Ouvre un navigateur isolé                     |
| `GET`    | `/v1/sessions/{id}`       | État de la session                            |
| `DELETE` | `/v1/sessions/{id}`       | Ferme et libère                               |
| `POST`   | `/v1/sessions/{id}/tasks` | Lance une tâche (rend la main aussitôt)       |
| `GET`    | `/v1/tasks/{id}?since=N`  | État + événements depuis `N`                  |
| `POST`   | `/v1/tasks/{id}/cancel`   | Annulation coopérative                        |

Les événements sont numérotés (`seq`) : une reprise après coupure ne perd rien et
ne rejoue rien. Types : `started`, `navigation`, `thinking`, `action`,
`progress`, `result`, `error`, `finished`.

---

## Intentions : la sécurité au bon endroit

Le backend décide _ce qu'on veut faire_, le worker décide _ce qu'il est possible
de faire_. Un backend compromis ne doit pas pouvoir transformer une lecture en
achat.

| Intention  | Outil agent        | Risque   | Confirmation | Actions retirées                    |
| ---------- | ------------------ | -------- | ------------ | ----------------------------------- |
| `read`     | `browser.read`     | SAFE     | non          | clic, saisie, onglets, JS, fichiers |
| `interact` | `browser.interact` | MEDIUM   | oui          | JS, fichiers                        |
| `login`    | `browser.login`    | HIGH     | oui          | JS, fichiers                        |
| `purchase` | `browser.purchase` | CRITICAL | oui          | JS, fichiers                        |

**`evaluate` (JavaScript arbitraire) est retirée pour toutes les intentions.**
Elle contournerait toute restriction posée au niveau de l'interface et
permettrait d'exfiltrer cookies et jetons. Les actions de fichier le sont aussi :
le navigateur n'a aucune raison d'accéder au disque du worker.

`interact`, `login` et `purchase` partagent le même jeu d'actions — cliquer pour
filtrer et cliquer pour payer sont techniquement le même geste. Ce qui les sépare
est ailleurs : permissions exigées, confirmation demandée, consigne donnée au
modèle. C'est assumé plutôt que déguisé.

L'exemple du cahier des charges se lit directement dans ce tableau :

- « Va sur ce site et cherche le prix d'un billet » → `browser.read` → **aucune
  confirmation**.
- « Achète le billet » → `browser.purchase` → **confirmation obligatoire**, et le
  montant exact doit figurer dans l'aperçu.

---

## CAPTCHA, MFA : jamais contournés

Trois lignes de défense, dans cet ordre :

1. **Consigne en tête de prompt**, avant les instructions de l'utilisateur :
   ne jamais résoudre un CAPTCHA, ne jamais contourner un second facteur,
   s'arrêter et expliquer.
2. **Détection sur la sortie** : si le résultat mentionne une vérification
   humaine, la tâche se termine en `needs_human`.
3. **Statut dédié**, pas un échec : l'agent reçoit un message rédigé pour être
   relayé tel quel à l'utilisateur, qui prend la main sur cette étape.

Le worker ne contient aucun code de résolution de CAPTCHA et n'en contiendra pas.

---

## Secrets

| Règle                                   | Mise en œuvre                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Le modèle ne voit jamais un identifiant | Transmis à browser-use via `sensitive_data`, qui substitue à l'envoi                                                               |
| Rien ne ressort                         | `redact_text()` sur la sortie, les erreurs et chaque événement, avec les valeurs connues de la tâche                               |
| Rien n'est journalisé                   | Filtre de rédaction sur le gestionnaire racine : par nom de clé **et** par forme de valeur (`sk-…`, `ghp_…`, JWT, numéro de carte) |
| La configuration ne fuit pas            | `describe()` ne rend que les clés, jamais les valeurs                                                                              |

---

## Réseau

`DomainPolicy` refuse toujours — quelle que soit la configuration — `localhost`,
les plages privées RFC 1918, et les points de métadonnées cloud
(`169.254.169.254`). Un agent qui visite du contenu hostile ne doit pas servir de
relai vers l'intérieur.

Une liste d'autorisation par session restreint la navigation ; elle est appliquée
par `BrowserProfile`, donc par le navigateur lui-même.

---

## Tests

```bash
pytest                       # 75 tests, sans navigateur ni modèle
pytest -m browser            # + 2 tests end-to-end (Chromium et clé LLM requis)
ruff check . && ruff format --check .
```

Seul le couple navigateur + modèle est remplacé (`FakeRunner`) : routes,
authentification, sessions, politiques, événements, annulation et rédaction
s'exécutent réellement.

### Contrat TypeScript ↔ Python

```bash
pnpm --filter @nexus/browser-client contract:emit   # après toute modification du protocole
pytest tests/test_contract.py
```

Le contrat est généré depuis les schémas Zod du backend et comparé aux modèles
Pydantic : noms de champs, champs obligatoires, valeurs d'énumération, variantes
d'événements. Une divergence casse le build, pas la production (risque R7).

### Communication réelle

```bash
NEXUS_WORKER_PYTHON=/chemin/vers/python \
  pnpm --filter @nexus/browser-client test
```

Lance le vrai worker et le pilote avec le vrai client : HTTP, sérialisation,
authentification, codes d'erreur.

### Exemple end-to-end

`tests/test_e2e_local_site.py` sert une page de vols depuis le processus de test
et demande à l'agent d'en extraire un prix — puis vérifie qu'une tâche `read` ne
peut **pas** cliquer sur « Acheter », même en le lui ordonnant. Site local :
aucun accès Internet requis, et le contenu attendu ne change pas du jour au
lendemain.

---

## Diagnostic

| Symptôme                                       | Cause probable                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `status: "degraded"` sur `/v1/health`          | `browser-use` n'est pas installé — le worker démarre quand même, pour rester diagnosticable                               |
| Le worker refuse de démarrer                   | `BROWSER_WORKER_AUTH_TOKEN` absent ou trop court (16 caractères minimum)                                                  |
| `BROWSER_SESSION_BUSY`                         | Limite de sessions atteinte, ou une tâche tourne déjà dans cette session                                                  |
| Chromium plante en conteneur                   | `shm_size` insuffisant — 1 Go est configuré dans le compose                                                               |
| Journal : « actions restreintes introuvables » | Mise à jour de browser-use avec des actions renommées. **À corriger sans délai** : une restriction d'intention est tombée |
