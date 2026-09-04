# 10 — Stratégie mémoire

## 1. Cinq couches, cinq durées de vie

Le mot « mémoire » recouvre cinq mécanismes différents qu'il faut refuser de confondre :

| Couche                   | Contenu                                                   | Durée                | Stockage            | Entre dans le prompt       |
| ------------------------ | --------------------------------------------------------- | -------------------- | ------------------- | -------------------------- |
| **Working context**      | La fenêtre envoyée au modèle maintenant                   | le tour courant      | RAM                 | intégralement (c'est elle) |
| **Short-term**           | Le run en cours : plan, observations d'outils, brouillons | le run               | `AgentStep` + Redis | oui, tronqué               |
| **Conversation history** | Messages d'une conversation                               | illimitée            | `Message`           | K derniers tours + résumé  |
| **Long-term memory**     | Faits, préférences implicites, procédures apprises        | illimitée            | `Memory` + pgvector | top-K par pertinence       |
| **User preferences**     | Réglages explicites et structurés                         | jusqu'à modification | `UserPreference`    | toujours, compact          |

Y ajouter deux journaux qui ne sont **pas** de la mémoire au sens du prompt, mais qui sont
interrogeables par outil : `Task` (historique des tâches) et `ToolExecution` (historique des
actions). L'agent y accède via `history.search`, il ne les porte pas dans son contexte.

## 2. Écriture en mémoire longue

L'extraction est **asynchrone et post-run** — jamais dans le chemin critique de la réponse :

```
run terminé → job memory.extract
  1. le modèle propose des candidats { type, content, importance, confidence, ttl? }
  2. filtrage : pas de secret, pas d'éphémère ("je suis fatigué"), pas de doublon
  3. déduplication sémantique (cos > 0.92 sur un fait du même type)
     → fusion, ou supersession si contradiction
  4. embedding + insertion
  5. WS memory.updated → l'UI affiche discrètement « j'ai retenu que… »
```

Trois règles de conception :

- **La mémoire est révisable.** Un écran Settings → Mémoire liste tout, permet d'éditer, épingler,
  supprimer. Une mémoire qu'on ne peut pas corriger devient un défaut permanent.
- **Rien n'est écrasé, tout est supersédé.** `supersededById` + `validFrom/validUntil` conservent
  l'histoire (§07).
- **Une préférence inférée est proposée, pas appliquée.** `source=INFERRED` + `confidence` ;
  au-delà d'un seuil, l'agent demande confirmation avant d'en faire une règle.

## 3. Lecture : recherche hybride

La recherche purement vectorielle rate les noms propres et les identifiants ; la recherche
plein texte rate les paraphrases. On combine :

```
candidats = RRF( pgvector cosine top-50 , tsvector français top-50 )
score = 0.55·similarité + 0.20·importance + 0.15·fraîcheur(exp) + 0.10·fréquence d'accès
filtres : userId, type, validUntil IS NULL OR validUntil > now()
retour : top-K (défaut 8) sous budget de tokens
```

Reciprocal Rank Fusion plutôt qu'une pondération de scores hétérogènes : c'est plus robuste et
sans calibration à maintenir. Un reranker cross-encoder est possible plus tard, il n'est pas
nécessaire à l'échelle d'un utilisateur.

## 4. Compaction du contexte

Déclenchée quand la fenêtre dépasse ~70 % du budget du modèle, ou après N tours.

```
1. protéger : prompt système, préférences, les 3 derniers tours, le plan courant,
              les confirmations en attente
2. résumer  : les tours plus anciens → ConversationSummary cumulatif (modèle rapide)
3. dégrader : gros résultats d'outils → { extrait 500 tokens, artifactId, comment relire }
4. élaguer  : observations d'outils redondantes ou obsolètes du run courant
5. vérifier : recompter les tokens ; si toujours au-dessus, réduire K des souvenirs
```

L'information n'est jamais détruite, seulement **déplacée hors contexte** et rendue re-consultable
via `artifact.read` / `history.search`. C'est la différence entre compacter et perdre.

## 5. Oubli

Une mémoire qui ne fait que grossir devient bruyante et coûteuse. Un job hebdomadaire :

- décroissance de `importance` pour les faits jamais réutilisés depuis 90 j ;
- archivage (hors index de recherche) sous un seuil, sans suppression ;
- détection de contradictions → demande d'arbitrage à l'utilisateur plutôt que choix silencieux ;
- suppression immédiate et totale sur demande explicite (« oublie ça »), y compris l'embedding.

## 6. Pourquoi pas de base vectorielle dédiée

Un utilisateur personnel produira de l'ordre de 10⁴ à 10⁵ souvenirs. `pgvector` avec un index
HNSW répond en quelques millisecondes à cette échelle, dans **la même transaction** que les
données métier — donc pas de désynchronisation entre un fait supprimé et son embedding, pas de
service supplémentaire à opérer, sauvegarder et sécuriser. Introduire Qdrant/Weaviate maintenant
serait de la complexité sans contrepartie (→ [ADR-011](../adr/ADR-011-memory-pgvector.md)).
