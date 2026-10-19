# 18 — Browser Use (implémenté)

## 0. Chemin local recommandé, sans clé API

Pour les agents ACP Codex et Claude, NEXUS réutilise désormais le
[`browser-harness`](https://github.com/browser-use/browser-harness) officiel. Le modèle ACP pilote
directement Chromium via CDP : le harness ne contient pas de seconde boucle LLM et ne demande donc
aucune clé API. Un service systemd user démarre un profil Chromium NEXUS séparé sur la boucle locale
`127.0.0.1:19222`; l'accès au profil Chromium personnel n'est jamais accordé implicitement.

Le planificateur route les missions de navigation vers Codex, puis Claude en fallback, et exclut
Antigravity des fallbacks navigateur tant que son adaptateur ACP n'offre pas cette intégration de
façon démontrée. Le harness local est une voie partagée : les actions navigateur sont sérialisées,
alors que les autres tâches peuvent rester parallèles.

Le worker Python décrit dans le reste de ce document reste disponible comme mode avancé autonome.
Il possède sa propre boucle `browser-use` et exige donc un fournisseur LLM ; il n'est pas utilisé
par la configuration locale sans clé.

Décrit l'intégration **telle qu'elle est construite**. Le document
[05 — Browser Use worker](05-browser-use.md) en pose la conception ; celui-ci
fait foi pour le code.

Paquets : [`services/browser-worker`](../../services/browser-worker) (Python),
[`@nexus/browser-client`](../../packages/browser-client) (TypeScript).

## 1. Version et API vérifiées

`browser-use 0.13.8`, Python ≥ 3.11. L'API a été vérifiée **contre le paquet
installé**, pas contre la documentation :

| Élément               | Ce qui est utilisé                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Agent                 | `Agent(task, llm, browser, tools, sensitive_data, task_id, register_should_stop_callback, step_timeout)` |
| Exécution             | `agent.run(max_steps=…, on_step_end=…)`                                                                  |
| Restriction d'actions | `Tools(exclude_actions=[…])`                                                                             |
| Navigateur            | `Browser(browser_profile=BrowserProfile(…))`                                                             |
| Modèle                | `ChatAnthropic`                                                                                          |

Deux pièges ont été trouvés à l'inspection, tous deux invisibles à la lecture de
la documentation :

- **`allowed_domains` vit sur `BrowserProfile`, pas sur `Browser`.** Passées au
  mauvais objet, les restrictions de domaine auraient été silencieusement
  inopérantes : le navigateur serait allé partout en se croyant bridé.
- **`Agent.__init__` accepte des kwargs libres.** Un `max_steps` passé au
  constructeur — au lieu de `run()` — aurait été avalé sans effet.

L'adaptateur n'épingle pas de signature : `_supported_kwargs()` inspecte celle
qui est installée et ne transmet que ce qu'elle accepte. L'API de browser-use
évolue vite ; épingler garantissait une casse à la prochaine version.

## 2. Isolation

Le backend n'importe jamais de code Python. Il parle à un service :

```
Agent Core ─▶ BrowserWorkerClient ─▶ FastAPI ─▶ browser-use ─▶ Chromium
   (TS)         (TS, HTTP + Bearer)   (Python)
```

Le worker n'a **aucun port publié**, tourne en utilisateur non privilégié, avec
`no-new-privileges`, et ne reçoit aucun secret applicatif du backend. Il démarre
en profil Docker optionnel : son image embarque Chromium (~1,5 Go) et n'a pas à
tourner quand on travaille sur l'API.

## 3. L'intention comme contrainte, pas comme étiquette

Quatre intentions — `read`, `interact`, `login`, `purchase` — portent à la fois
le risque côté agent et la restriction côté worker.

Le backend décide _ce qu'on veut faire_, le worker décide _ce qu'il est possible
de faire_. Une tâche `read` ne reçoit pas l'action « cliquer » : browser-use ne
la lui a jamais donnée. Un backend compromis ne peut donc pas transformer une
lecture en achat.

**`evaluate` — exécution de JavaScript arbitraire — est retirée pour toutes les
intentions.** Elle contournerait toute restriction posée au niveau de l'interface
et permettrait d'exfiltrer cookies et jetons. Les actions de fichier également :
le navigateur n'a aucune raison de toucher au disque du worker.

Un garde-fou vérifie au démarrage que les actions restreintes existent toujours
dans le registre installé. **Il a servi dès le premier jour** : les noms retenus
d'après la documentation (`click_element_by_index`, `input_text`) n'existent pas
en 0.13.8, où ils s'appellent `click` et `input`. Sans cette vérification, la
restriction `read` n'aurait rien restreint du tout.

## 4. Protections humaines

Trois lignes, dans cet ordre : consigne en tête de prompt, détection sur la
sortie, statut `needs_human` dédié. Ce dernier n'est pas un échec — l'agent
reçoit un message rédigé pour être relayé à l'utilisateur, qui prend la main sur
l'étape puis relance.

Le worker ne contient aucun code de résolution de CAPTCHA.

## 5. Secrets

Les identifiants de site transitent par `sensitive_data` de browser-use : le
modèle voit un marqueur, jamais la valeur. En sortie, `redact_text()` s'applique
au résultat, aux erreurs et à chaque événement, avec les valeurs connues de la
tâche — parce qu'un modèle recopie volontiers dans son résultat ce qu'il vient
de saisir dans un formulaire. Un défaut de ce type a d'ailleurs été trouvé par
les tests : la sortie repartait sans rédaction.

## 6. Progression visible

`ToolContext` a gagné un canal `onProgress`, relayé par la boucle agent en
événement `tool.progress`. Sans lui, l'utilisateur n'aurait qu'un sablier pendant
qu'un navigateur travaille — la principale raison pour laquelle un agent paraît
bloqué alors qu'il avance. Les événements du worker (`navigation`, `action`,
`progress`) deviennent des libellés lisibles : « Ouverture de vols.test »,
« Étape 3/15 ».

## 7. Écarts avec le document 05

| Point               | Doc 05                     | Implémentation                              | Pourquoi                                                                                                  |
| ------------------- | -------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Outils exposés      | `browser.act` + bas niveau | Un outil par intention                      | Le risque doit être gradué ; « chercher un prix » et « acheter » ne peuvent pas partager une confirmation |
| Progression         | Redis Stream               | Scrutation HTTP avec `seq`                  | Les événements numérotés rendent la reprise sûre sans connexion longue, pour un service interne           |
| Captures d'écran    | Par étape, stockage objet  | Champ `screenshotRef` réservé, non alimenté | Le stockage objet arrive avec la phase 5 d'infrastructure                                                 |
| Profils persistants | Cookies chiffrés au repos  | Sessions éphémères uniquement               | Le trousseau local protège le jeton de service ; les cookies persistants par site restent hors périmètre  |

## 8. Administration locale

L'onglet Browser Use propose deux modes. Le mode recommandé « navigateur local » configure l'URL
CDP de boucle locale et appelle `browser-harness doctor --json --require-existing-daemon`; le test
établit réellement la connexion sans renvoyer le titre, l'URL ou le contenu des onglets à l'API.
Le mode avancé « worker autonome » conserve l'URL interne et la référence `vault://nexus/...` : le
jeton est résolu dans le trousseau Linux et n'est jamais renvoyé au navigateur. HTTP n'est accepté
que pour `localhost`, `127.0.0.1` ou `::1`; toute URL distante doit utiliser HTTPS.

## 9. Vérification croisée TypeScript ↔ Python

Deux mécanismes, complémentaires :

- **Contrat** (`tests/test_contract.py`) : les schémas Zod sont exportés en JSON
  Schema et comparés aux modèles Pydantic — noms de champs, obligatoires,
  énumérations, variantes d'événements.
- **Communication** (`packages/browser-client/test/integration.test.ts`) : un
  vrai worker uvicorn est lancé et piloté par le vrai client — HTTP,
  sérialisation, authentification, codes d'erreur.

Le premier compare des schémas, le second des comportements. Il faut les deux.
