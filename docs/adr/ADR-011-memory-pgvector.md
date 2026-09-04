# ADR-011 — pgvector plutôt qu'une base vectorielle dédiée

**Statut** : Proposé · 2026-09-01

## Contexte

La mémoire longue durée demande une recherche sémantique. La réponse réflexe est d'ajouter une
base vectorielle (Qdrant, Weaviate, Pinecone). Il faut vérifier que le besoin la justifie.

## Décision

`pgvector` dans la base PostgreSQL existante, index HNSW, avec **recherche hybride** :
vectoriel + plein texte français (`tsvector`), fusionnés par Reciprocal Rank Fusion, puis
repondérés par importance, fraîcheur et fréquence d'accès.

## Alternatives

- **Qdrant / Weaviate auto-hébergés.** Meilleurs à grande échelle (10⁷+ vecteurs), filtrage riche,
  quantification. Écarté : un utilisateur personnel produira 10⁴–10⁵ souvenirs, un domaine où
  pgvector répond en quelques millisecondes. Ce serait un service de plus à opérer, sauvegarder,
  sécuriser et maintenir cohérent.
- **Pinecone / Turbopuffer (SaaS).** Zéro exploitation, mais dépendance externe, coût récurrent, et
  les souvenirs personnels partent chez un tiers — contraire à l'esprit du projet.
- **Recherche plein texte seule.** Rate les paraphrases, qui sont le cas d'usage principal d'une
  mémoire conversationnelle.

## Conséquences

**Positives** — **une seule transaction** : un souvenir et son embedding sont écrits, mis à jour et
supprimés atomiquement, donc jamais désynchronisés. Une seule sauvegarde, une seule surface de
sécurité, un seul endroit à monitorer. Les filtres SQL (`userId`, `type`, `validUntil`) sont
naturels et exacts, là où ils sont souvent limités côté bases vectorielles.

**Négatives, acceptées** — l'index HNSW consomme de la RAM sur l'instance PostgreSQL (négligeable
à cette échelle) ; la reconstruction d'index après un changement de modèle d'embedding est une
opération de maintenance à scripter ; au-delà de ~10⁶ vecteurs il faudra reconsidérer.

## Signal de réévaluation

Si la latence p95 de `memory.search` dépasse 150 ms ou si le nombre de vecteurs franchit 10⁶,
rouvrir la décision. Le port `MemoryStore` est déjà en place : le changement serait un adaptateur.
