# Recherche web NEXUS

NEXUS expose deux ports internes : `WebSearchProvider` pour découvrir des
sources et `WebDocumentFetcher` pour lire une page. L'agent ne connaît ni
SearXNG ni son API : il voit les outils stables `search.web` et `web.fetch`.

```text
Agent Core → ToolRegistry → search.web → WebSearchProvider → SearXNG
                         ↘ web.fetch  → SafeWebFetcher → page publique
```

Cette frontière permet de remplacer SearXNG sans modifier les prompts, les
permissions ou l'orchestrateur. Le fournisseur normalise les résultats, borne
les contenus et écarte les URL non HTTP(S) ou contenant des credentials.

`web.fetch` récupère uniquement du HTML ou du texte brut, extrait le texte et
les métadonnées sans exécuter JavaScript, puis renvoie :

- l'URL demandée, l'URL finale et l'URL canonique de même origine ;
- la chaîne de redirections ;
- le titre, l'auteur, la langue et la date lorsqu'ils existent ;
- un hash SHA-256 de la version lue ;
- du texte borné et des citations extractives stables.

Les citations sont des passages exacts du document. `createCitation` et
`verifyCitation` vérifient le hash de version, l'URL, les offsets et, si une
affirmation est fournie, une couverture lexicale minimale. Cette vérification
est déterministe : elle empêche les citations inventées mais ne remplace pas
une vérification sémantique ou éditoriale.

`deduplicateDocuments` élimine les doublons par URL canonique normalisée, puis
par hash de contenu, en conservant la provenance de chaque doublon.

## Sécurité

- aucune clé LLM ou clé de moteur de recherche ;
- SearXNG n'est jamais publié hors de la boucle locale ;
- le JSON doit être explicitement activé dans `settings.yml` ;
- les extraits sont du contenu externe non fiable, jamais des instructions ;
- `search.web` et `web.fetch` sont en lecture seule, idempotents et exigent
  `browser.navigate` ;
- une instance distante doit utiliser HTTPS.

Le fetcher applique en plus les protections suivantes avant la requête initiale
et avant chaque redirection :

- schémas limités à HTTP(S), sans credentials ;
- ports limités à 80 et 443 ;
- résolution DNS obligatoire ;
- refus des adresses loopback, privées, link-local, multicast, documentaires et
  des endpoints de métadonnées connus ;
- refus d'une réponse DNS mixant adresses publiques et privées ;
- cinq redirections maximum ;
- délai, `Content-Length` et lecture effective bornés ;
- types MIME limités à `text/html`, XHTML et `text/plain`.

La validation DNS précède l'appel à `fetch`. Le runtime HTTP résout ensuite le
nom pour ouvrir la connexion : un adversaire contrôlant le DNS pourrait tenter
un rebinding dans cette fenêtre. Pour un déploiement exposé à des utilisateurs
non fiables, il faut compléter cette défense applicative par une politique
d'egress réseau qui interdit les plages privées et les métadonnées cloud.

## Veille et détection de changement

`WebWatchService` réalise **un contrôle ponctuel**. Le scheduler décide quand il
est appelé ; la bibliothèque de recherche ne crée aucun timer et ne duplique
pas la logique d'orchestration durable.

Le service compare le nouveau document au dernier snapshot avec :

1. le hash exact du contenu ;
2. une similarité de Jaccard sur des trigrammes normalisés ;
3. un seuil configurable.

Il renvoie `first_seen`, `unchanged` ou `changed`. Le stockage JSON fourni écrit
atomiquement un fichier en mode `0600`, dans un répertoire `0700`, et dérive son
nom du hash de l'identifiant de veille. Seuls le hash, les métadonnées et la
signature de comparaison sont conservés : le texte intégral de la page n'est
pas persisté. Pour une installation multi-instance, ce port devra recevoir une
implémentation PostgreSQL et un verrou distribué.

## Démarrage Docker

Définir `SEARXNG_URL=http://searxng:8080` pour l'API conteneurisée, ou
`SEARXNG_URL=http://127.0.0.1:18080` lorsque l'API tourne directement sur
l'hôte. Générer une valeur aléatoire pour `SEARXNG_SECRET`, puis lancer :

```bash
pnpm docker:research
pnpm docker:up
```

Le profil `research` reste optionnel : sans `SEARXNG_URL`, aucun outil web n'est
enregistré et le reste de NEXUS démarre normalement.

## Limites assumées

- l'extracteur HTML est déterministe et léger ; il ne rend pas les applications
  JavaScript et ne remplace pas Browser Harness pour les pages dynamiques ;
- les PDF et formats Office doivent passer ultérieurement par une couche
  documentaire dédiée ;
- la couverture lexicale d'une citation ne prouve ni la véracité de la source,
  ni la correction d'une paraphrase ;
- la détection de changement ne décide pas si le changement est important pour
  la mission : cette décision appartient à l'orchestrateur ;
- la bibliothèque n'envoie aucune notification et ne planifie aucune tâche.

## Dépendance et licence

SearXNG est exécuté comme service séparé depuis son image officielle épinglée ;
son code n'est ni copié ni lié à celui de NEXUS. SearXNG est distribué sous
AGPL-3.0-or-later. Une redistribution de l'image, ou une version modifiée mise à
disposition sur un réseau, doit respecter ses obligations et fournir un accès à
la source correspondante : <https://github.com/searxng/searxng>.
