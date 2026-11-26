# Périmètre produit et qualification

État de la qualification au 11 novembre 2026 : **version de développement, pas de version stable grand public validée**. Les plans d'architecture et les catalogues décrivent aussi des fonctions en cours ; ils ne constituent pas une matrice de support.

La cible prioritaire est une instance personnelle web avec un propriétaire, une API mono-processus, PostgreSQL pour les données API et SQLite pour le moteur de missions. Le choix du fournisseur distant reste explicite : les données envoyées à son modèle quittent la machine. Les outils et connecteurs activés peuvent également envoyer les données nécessaires à leur service.

| Capacité                                    | Niveau de preuve disponible                                           | Limite actuelle                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Comptes et sessions                         | Tests REST et concurrence PostgreSQL                                  | Installation vierge et exposition publique encore à qualifier                        |
| Annulation de mission                       | Tests moteur/client/API et état du dashboard                          | Un effet externe déjà effectué ne peut pas être annulé ; fournisseurs réels à tester |
| Accords dans la conversation                | Câblage API et décisions concurrentes testés                          | Aperçu complet du contenu et reprise après redémarrage incomplets                    |
| Documents locaux                            | Lecture et ingestion testées avec permissions par compte              | Parcours guidé fichier → réponse sourcée → export pas encore qualifié                |
| Checkpoints Git                             | Capture/restauration et persistance testées                           | Pas de sauvegarde des dossiers non Git ; pas de capture automatique garantie         |
| MCP local Linux                             | Exécution bwrap et refus des chemins non montés testés                | Chaque serveur MCP doit être configuré et qualifié séparément                        |
| Coûts                                       | Tokens observés et estimation du catalogue local                      | Pas une facture ; prix inconnus indisponibles ; tarifs à vérifier                    |
| Sauvegarde                                  | Restauration PostgreSQL/SQLite/configuration sur installation jetable | Manifeste partiel ; coffre système et engine PostgreSQL séparé exclus                |
| Carrière                                    | Préparation des documents et contrôles locaux                         | Aucun envoi externe par défaut ; dépôt manuel nécessaire                             |
| Trading                                     | Simulation et outils de recherche                                     | Aucun label de performance ou de sécurité financière réelle                          |
| Mobile, desktop, satellites, voix et maison | Tests locaux de sous-systèmes                                         | Matériel, distribution et parcours réels non qualifiés                               |
| Équipes et haute disponibilité              | Architecture et tests partiels                                        | Isolation exhaustive et stockage multi-réplicas non qualifiés                        |

La stabilité personnelle exige encore : recette sur machine vierge, fournisseur réel, coupures aux frontières d'effets, récupération complète, accessibilité et essais avec des utilisateurs débutants. Aucune de ces étapes ne peut être remplacée par un nombre de tests unitaires.

Voir [le suivi d'implémentation](../audits/SUIVI-IMPLEMENTATION-NEXUS.md), [le plan d'amélioration](../audits/PLAN-AMELIORATION-NEXUS-2026-11-11.md), [les dossiers autorisés](workspace-security.md) et [la procédure de mise à jour](updating.md).
