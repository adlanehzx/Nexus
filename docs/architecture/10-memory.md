# 10 — Stratégie mémoire

## 1. Cinq couches, cinq durées de vie

Le mot « mémoire » recouvre cinq mécanismes différents qu'il faut refuser de confondre :

| Couche                   | Contenu                                                   | Durée                | Stockage                 | Entre dans le prompt       |
| ------------------------ | --------------------------------------------------------- | -------------------- | ------------------------ | -------------------------- |
| **Working context**      | La fenêtre envoyée au modèle maintenant                   | le tour courant      | RAM                      | intégralement (c'est elle) |
| **Short-term**           | Le run en cours : plan, observations d'outils, brouillons | le run               | `AgentStep` + Redis      | oui, tronqué               |
| **Conversation history** | Messages d'une conversation                               | illimitée            | `Message`                | K derniers tours + résumé  |
| **Long-term memory**     | Faits, préférences implicites, procédures apprises        | illimitée            | `Memory` + vecteur local | top-K hybride              |
| **User preferences**     | Réglages explicites et structurés                         | jusqu'à modification | `UserPreference`         | toujours, compact          |

Y ajouter deux journaux qui ne sont **pas** de la mémoire au sens du prompt, mais qui sont
interrogeables par outil : `Task` (historique des tâches) et `ToolExecution` (historique des
actions). L'agent y accède via `history.search`, il ne les porte pas dans son contexte.

## 2. Écriture en mémoire longue

L'extraction est **asynchrone et post-run** — jamais dans le chemin critique de la réponse :

```
run terminé → ControlledMemoryExtractor
  1. l'extracteur propose des candidats { type, content, importance, confidence, provenance }
  2. filtrage : pas de secret, pas d'éphémère ("je suis fatigué"), pas de doublon
  3. déduplication exacte par empreinte normalisée
     → les paraphrases restent à arbitrer pour ne jamais fusionner une contradiction
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
plein texte rate les paraphrases. La tranche locale combine les deux en mémoire applicative :

```
candidats = filtre utilisateur/validité + lexical + cosine
score = 0.45·lexical + 0.35·similarité + 0.12·importance + 0.08·fraîcheur
filtres : userId, type, validUntil IS NULL OR validUntil > now()
retour : top-K (défaut 8) sous budget de tokens
```

`EmbeddingProvider` rend l'encodeur remplaçable. Le défaut `nexus-hash-v1` est déterministe,
local et sans clé. Le vecteur est persisté avec sa provenance dans PostgreSQL. pgvector/HNSW et
RRF restent une optimisation de volume : ils ne sont pas rendus obligatoires tant que l'image
PostgreSQL standard ne fournit pas l'extension.

## 4. Compaction du contexte

Déclenchée quand la fenêtre dépasse ~70 % du budget du modèle, ou après N tours.

```
1. planifier : `ContextWindowPlanner` réserve sortie et marge de sécurité par modèle
2. protéger : prompt système, préférences, les 3 derniers tours, le plan courant,
              les confirmations en attente
3. résumer  : les tours plus anciens via le port `MemoryProvider.summarize`
4. dégrader : `ContextCompactor` range l'original puis rend { résumé, artifactId }
5. élaguer  : observations d'outils redondantes ou obsolètes du run courant
6. vérifier : recompter avec le `TokenCounter` injecté ; sinon estimation conservatrice
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

Un utilisateur personnel commence avec un volume que PostgreSQL et un tableau de vecteurs
peuvent servir sans service supplémentaire. Quand le corpus justifiera un index ANN, pgvector
avec HNSW restera dans **la même transaction** que les données métier. L'activation demandera
une image PostgreSQL qui fournit explicitement l'extension et une migration séparée, plutôt que
de casser les installations standard. Qdrant/Weaviate n'apporteraient rien à cette étape
(→ [ADR-011](../adr/ADR-011-memory-pgvector.md)).
