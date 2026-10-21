# @nexus/memory

La mémoire persistante utilise par défaut un modèle multilingue ONNX local
(`paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions) et pgvector/HNSW.
Aucun texte n'est envoyé à un service distant et aucune clé API n'est requise.

Au premier usage, le modèle est téléchargé dans le cache configuré par
`MEMORY_EMBEDDING_CACHE_DIR`. Après ce téléchargement, définir
`MEMORY_EMBEDDING_LOCAL_ONLY=true` garantit un fonctionnement hors ligne. Le
backend déterministe historique reste disponible avec
`MEMORY_EMBEDDING_BACKEND=hash`, notamment pour les environnements très
contraints ; ses vecteurs ne sont pas écrits dans la colonne pgvector 384D.

Six choses portent le nom de « mémoire ». Les confondre est la première erreur possible
dans ce domaine, et ce paquet existe pour l'empêcher.

| #   | Couche                     | Propriétaire                                  | Disparaît quand                    |
| --- | -------------------------- | --------------------------------------------- | ---------------------------------- |
| 1   | Historique de conversation | `ConversationStore` (API)                     | jamais — archivé                   |
| 2   | Contexte court terme       | `ShortTermContext` **ici**                    | à l'expiration, ou avec la session |
| 3   | Mémoire longue durée       | `MemoryProvider` **ici**                      | quand l'utilisateur oublie         |
| 4   | Préférences                | `MemoryProvider` **ici**, couche `PREFERENCE` | quand elles changent               |
| 5   | Appareils                  | `DeviceRegistry` (`@nexus/devices`)           | à la révocation                    |
| 6   | Historique des tâches      | `TaskStore` (`@nexus/devices`)                | à la purge                         |

**Seules 2, 3 et 4 vivent ici.** Les trois autres ont déjà un propriétaire dans le
système. Les recopier créerait une seconde vérité, qui divergerait de la première au
premier écart — et c'est toujours la copie qu'on finit par afficher. `sources.ts` les
déclare donc comme des **ports en lecture seule**, que l'API branche sur les vrais
magasins.

Conséquence pratique : l'assemblage de contexte se teste sans base, sans registre
d'appareils et sans coordinateur de tâches.

---

## La règle du silence

> **Rien de sensible n'est mémorisé sans que quelqu'un l'ait su.**

Trois verdicts, et la frontière entre eux est une décision, pas une nuance :

| Verdict     | Ce que c'est                                                                 | Ce qui se passe                                        |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `FORBIDDEN` | mots de passe, clés d'API, jetons, phrases de récupération, cartes bancaires | **refusé, toujours**                                   |
| `PERSONAL`  | santé, finances, identité, adresse, croyances                                | stocké **si** l'appelant passe `acknowledgedSensitive` |
| `ORDINARY`  | le reste                                                                     | stocké                                                 |

`FORBIDDEN` n'a **pas de dérogation utilisateur**. NEXUS n'est pas un gestionnaire de
mots de passe : il n'offre ni chiffrement au repos dédié, ni rotation, ni révocation.
Accepter ces contenus créerait un coffre que rien dans l'architecture ne protège comme
tel — et un utilisateur qui croit son secret en sécurité est plus exposé qu'un
utilisateur à qui l'on a dit non.

La détection est **déterministe**, jamais confiée à un modèle. Un classifieur
probabiliste qui se trompe une fois sur cent laisse passer un mot de passe une fois sur
cent. Elle réutilise `redactText` de `@nexus/shared` — ce qu'on apprend à masquer dans
les journaux profite aussitôt à la mémoire.

`acknowledgedSensitive` n'a **aucune valeur par défaut à `true`** nulle part dans le
dépôt. C'est ce qui donne son sens à la règle.

---

## Le service, jamais le magasin

```
route / cœur agent  ──▶  MemoryService  ──▶  MemoryProvider
                          (politique)         (magasin)
```

`MemoryProvider` range ce qu'on lui donne — c'est son rôle. `MemoryService` décide s'il
faut le lui donner. Court-circuiter le service, « juste pour la route de création »,
suffirait à contourner la règle du silence : `services/api/test/memory.test.ts` le
vérifie de bout en bout.

### Les cinq méthodes

|             |                                                                           |
| ----------- | ------------------------------------------------------------------------- |
| `search`    | requête vide = tout parcourir, du plus récent au plus ancien              |
| `store`     |                                                                           |
| `update`    | change le **contenu** → supersède ; change une **métadonnée** → sur place |
| `delete`    |                                                                           |
| `summarize` | extractif, non génératif : le port ne dépend d'aucun LLM                  |

Toutes portent `userId`, y compris celles qui reçoivent déjà un identifiant
d'enregistrement. C'est redondant, et c'est voulu : un identifiant devinable ne doit pas
suffire à lire ou détruire le souvenir de quelqu'un d'autre.

### Superséder plutôt qu'écraser

Corriger « habite à Lyon » en « habite à Paris » ne modifie pas l'enregistrement : il en
crée un neuf et date l'ancien. « Où j'habitais l'an dernier » est une question
ordinaire, à laquelle un écrasement rend toute réponse impossible — et personne ne s'en
aperçoit avant qu'on la pose.

---

## Commandes explicites

« Retiens que… » et « Oublie… » ne passent **pas** par le modèle.

Un utilisateur qui dit « oublie mon adresse » doit voir son adresse disparaître, pas
espérer que le modèle l'ait interprété ainsi. Une reconnaissance déterministe rate
parfois une formulation exotique — l'utilisateur reformule. Un modèle, lui, se trompe
silencieusement.

La reconnaissance est **ancrée au début du message** et exige l'impératif : « je me
souviens que le train était en retard » n'est pas un ordre.

Trois précautions à l'oubli :

- par **identifiant** — sans ambiguïté ;
- par **texte** — supprime seulement si la correspondance est nettement meilleure que la
  suivante ; sinon rend les candidats et laisse l'utilisateur trancher ;
- **tout** — exige une confirmation explicite. Un souvenir effacé se redit ; une mémoire
  entière ne se reconstitue pas.

---

## Recherche hybride et provenance

Chaque souvenir porte désormais une empreinte du contenu normalisé, un embedding, le nom du
modèle d'embedding et, quand ils existent, les identifiants du run, de la conversation, du
message ou de la ressource source. Le texte source n'est pas recopié dans la provenance.

`EmbeddingProvider` est le port d'extension. Le repli `LocalHashEmbeddingProvider` est local,
déterministe et sans téléchargement. Il combine mots et bigrammes et sert un score hybride
lexical/vectoriel. Il n'a pas la finesse d'un encodeur neuronal : FastEmbed ou pgvector peuvent
le remplacer sans modifier `MemoryService` ni `ContextAssembler`.

Le schéma PostgreSQL conserve actuellement le vecteur comme `DOUBLE PRECISION[]`. Ce choix
maintient l'image `postgres:17-alpine` fonctionnelle et évite d'imposer une extension à toutes
les installations. Un index pgvector sera l'optimisation de production lorsque l'image NEXUS
l'embarquera ; le contrat applicatif est déjà indépendant du moteur.

`ControlledMemoryExtractor` ne stocke jamais une inférence directement : il produit des
candidats `requiresReview`, élimine les secrets puis `storeApproved` n'écrit que les index
explicitement approuvés. `MemoryConsolidator` suit la même règle : plan en lecture seule, puis
application aux groupes approuvés. La consolidation automatique de paraphrases reste interdite,
car deux formulations proches peuvent se contredire.

## Assemblage du contexte

`ContextAssembler` réunit les six couches, **chacune dans sa section et son budget**.

Un budget global unique paraît plus simple et se comporte mal : une conversation longue
mange tout, et les préférences — trois lignes qui changent la réponse — tombent parce
qu'elles arrivent en dernier. Le découpage garantit qu'un historique bavard ne fait pas
oublier à NEXUS que l'utilisateur préfère le train.

Deux barrières sont appliquées : caractères et tokens. `TokenCounter` permet à un adaptateur
d'injecter le tokeniseur exact du modèle ; `ConservativeTokenCounter` est le repli local et
annoncé comme estimation, jamais comme consommation facturée. `ContextWindowPlanner` réserve
la sortie et une marge de sécurité selon le modèle.

`ContextCompactor` déplace un contenu trop grand vers un `ContextArtifactStore` **avant** de le
résumer. Le prompt reçoit le résumé et l'identifiant de l'artefact ; l'original reste récupérable
avec une frontière `userId`. Le magasin en mémoire livré ici est destiné au développement ; le
port attend un adaptateur PostgreSQL ou objet durable pour la production.

Deux détails qui comptent :

- les **préférences** sont cherchées à requête vide — une consigne permanente n'a aucune
  raison de ressembler au message du jour ;
- l'**origine** accompagne chaque souvenir. « L'utilisateur a dit » et « déduit d'une
  conversation » n'ont pas la même autorité, et le modèle doit pouvoir nuancer.

---

## Tests

106 tests, sans base ni réseau, plus 5 tests PostgreSQL activés avec `DATABASE_URL`.

| Fichier                    | Couvre                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| `test/provider.test.ts`    | store, search, update, delete, supersession, frontière entre utilisateurs |
| `test/sensitivity.test.ts` | les trois verdicts, les commandes explicites, ce qui n'en est pas une     |
| `test/service.test.ts`     | la politique : refus, accord, oubli, ambiguïté, audit sans contenu        |
| `test/context.test.ts`     | séparation des couches, budgets, contexte court terme                     |
| `test/semantic.test.ts`    | hybride local, provenance, extraction, consolidation, tokens, artefacts   |

Plus `services/api/test/memory.test.ts`, qui vérifie que le service est bien le seul
chemin — ce qu'aucun test unitaire ne peut voir.
