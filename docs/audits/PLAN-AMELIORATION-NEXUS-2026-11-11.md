# Plan d'amélioration de Nexus — 11 novembre 2026

## 1. Décision produit proposée

**Faire de Nexus un assistant personnel web qui accomplit des tâches délimitées, demande un accord compréhensible avant les effets sensibles et retrouve son travail après une panne.** Le grand public visé est d'abord constitué de personnes francophones ou anglophones utilisant un ordinateur personnel et capables de choisir un fournisseur avec une aide guidée. Il ne s'agit pas de promettre une solution adaptée à tous les métiers, tous les appareils et toutes les autonomies.

Ce document est une feuille de route de réalisation, fondée sur [l'audit fonctionnel du même jour](AUDIT-FONCTIONNEL-NEXUS-2026-11-11.md), commit `2e5cbadb4b80e6ce64f739f419db43d0ee6a78fe` avec Cadran en cours. Les références **F01–F16** renvoient aux constats et preuves de cet audit. Les choix ci-dessous sont des propositions produit, sauf les décisions Cadran déjà actées dans `docs/design/02-ux-architecture.md:9`. Ils ne prétendent pas que les corrections sont réalisées.

La promesse initiale tient en trois usages :

1. **Comprendre et préparer** : répondre, rechercher avec sources, résumer un document réellement ingéré, préparer un texte sans l'envoyer.
2. **Agir dans un espace autorisé** : produire ou modifier un fichier dans un dossier choisi, montrer le résultat et le diff, pouvoir restaurer ce qui est restaurable.
3. **Reprendre en confiance** : retrouver conversations et tâches, savoir si une action a été exécutée, refusée, interrompue ou reste incertaine.

Une fonction n'appartient à la promesse stable que si le parcours complet a été testé sur une configuration publiée. Une bibliothèque présente, une carte de catalogue et un test avec double ne suffisent pas.

### Publics successifs

| Public                 | Offre concrète                                                                                                                                                                     | Conditions et exclusions                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personne non technique | Interface web, assistant d'installation, un fournisseur recommandé parmi ceux réellement validés, dossier de travail explicite, accords, historique, export et récupération guidée | Un propriétaire par instance au départ. Aucun terminal requis pendant les tâches courantes ; l'installation doit être accompagnée jusqu'à disposer d'un paquet éprouvé |
| Utilisateur avancé     | Choix de plusieurs comptes/modèles, MCP de confiance, appareils, tâches planifiées, diagnostic détaillé                                                                            | Activation explicite par capacité ; contraintes de coût, d'isolation et de reprise visibles                                                                            |
| Petite équipe          | Espaces partagés, rôles, ressources attribuées, budget et journal d'actions, départ d'un membre                                                                                    | Après preuve d'isolation des routes, sockets, fichiers, secrets, queues et reprise globale ; pas de promesse SaaS multi-tenant prématurée                              |

**Positionnement de départ : web personnel d'abord.** Mobile sert de compagnon de suivi/accord ; desktop est une distribution complémentaire, pas un troisième produit à refondre simultanément. Maison/voix et autres labs restent optionnels tant que matériel et exploitation ne sont pas qualifiés.

## 2. Parcours cible détaillé

### Installation → fournisseur → première tâche → accord → résultat → reprise

| Étape                            | Expérience attendue                                                                                                   | Travail nécessaire                                                                                                         | Critère d'acceptation observable                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Installer                     | Télécharger la version adaptée, lancer un installateur ou assistant unique ; voir progression et espace disque requis | Unifier quickstart/CLI/docs ; prérequis vérifiés avant modification ; journal lisible ; reprise d'installation interrompue | Sur machine vierge supportée : services prêts, compte propriétaire unique, aucune commande non documentée ; réexécution sans doublon    |
| 2. Choisir où vont les données   | Une page explique ce qui reste sur la machine, ce qui part au fournisseur, et le dossier autorisé                     | Inventaire des flux sortants, choix cloud/local explicite, séparation coffre/données, racine de workspace                  | Sans fournisseur distant choisi, aucune requête modèle distante ; en mode distant, destination affichée avant premier envoi             |
| 3. Relier un fournisseur         | Se connecter ou saisir une clé dans un champ protégé ; lancer une vérification courte et plafonnée                    | Capacité détectée, credentials vérifiés, date/source du dernier contrôle ; erreur auth/quota/réseau distinguée             | Un essai réel contrôlé aboutit, ou une erreur donne une action applicable ; aucune promotion « connecté » sur seule présence de dossier |
| 4. Première tâche                | Une proposition simple : créer un résumé à partir d'un fichier de démonstration non sensible                          | Ingestion réellement branchée, mission unique persistée, progression sans jargon                                           | Résultat attribuable au fichier fourni ; recharger l'onglet ne resoumet pas ; modèle et espace utilisés consultables                    |
| 5. Donner son accord             | Carte : action, cible exacte, contenu ou diff, conséquence, portée ; boutons Approuver/Refuser                        | Raccordement confirmations générales au chat ; validation propriétaire ; expiration, payload lié à l'accord                | Refuser produit zéro effet ; modifier le contenu invalide l'accord ; double clic ne produit qu'un effet                                 |
| 6. Recevoir le résultat          | Réponse lisible, fichier ouvrable, sources, actions effectuées et limites                                             | Traçabilité conversation/mission/run/artefact ; statuts enregistrés ; diff lié au bon workspace                            | Le fichier existe, s'ouvre et correspond au résultat ; aucun succès si seule une simulation ou un brouillon existe                      |
| 7. Arrêter                       | « Arrêter la mission » montre demande reçue puis état serveur ; effets déjà accomplis restent listés                  | Route bout en bout, propagation aux tâches, grants, accords et processus contrôlables                                      | Annulation idempotente ; aucune tâche nouvelle après prise en compte ; appel externe non interruptible signalé comme tel                |
| 8. Reprendre après erreur        | « Connexion perdue, recherche de la tâche… », puis état retrouvé ou choix guidé                                       | Réconciliation par identifiant durable, résultat incertain distinct d'échec, retry classé par idempotence                  | Coupure après envoi ou après effet : pas de second effet ; après restart, même historique et état expliqué                              |
| 9. Quitter ou changer de machine | Export lisible, sauvegarde vérifiée, révocation et suppression guidées                                                | Manifeste de données/clefs/exclusions ; restauration jetable ; procédure de départ                                         | L'utilisateur sait ce qui a été sauvegardé/supprimé et les copies qui subsistent ; restauration prouvée sur configuration supportée     |

La première tâche doit être réussie sans apprendre « ACP », « MCP », « grants », « leases » ou « embeddings ». Ces détails restent dans les vues de diagnostic. Les dépendances facultatives ne doivent pas bloquer l'usage conversation/fichiers de base.

## 3. Fiabiliser, simplifier, différer

| Domaine              | Fiabiliser                                                                        | Simplifier                                                     | Différer ou restreindre                                                                 |
| -------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Exécution            | Annulation serveur, reprise, idempotence, état incertain, corrélation durable     | Une carte mission et un vocabulaire commun                     | Nouveau moteur transactionnel concurrent au Python déjà opérationnel                    |
| Permissions          | Refus fermé, accords liés au contenu, ownership, pause/reprise autorisées         | Un modèle de consentement identique sur web et mobile          | Autorisations permanentes de mission jusqu'à tests de révocation et revue de sécurité   |
| Fournisseurs         | Une matrice de providers effectivement essayés, auth/quota/rate-limit, budget     | Un parcours recommandé, options avancées repliées              | Ajouter des noms au catalogue sans intégration vérifiée                                 |
| Mémoire et documents | Sources, oubli, qualité du rappel, ingestion réelle                               | « Retenir / Voir / Corriger / Oublier », avec portée explicite | Graphe de connaissances avancé et synchronisation entre pairs avant qualité du rappel   |
| Fichiers             | Workspace autorisé, diff, checkpoints, restauration sans toucher au travail tiers | Ouvrir résultat, voir changements, restaurer avec aperçu       | Pilotage arbitraire du filesystem hôte                                                  |
| MCP et intégrations  | Isolation minimale, scopes, révocation, enregistrement réel des outils            | Catalogue filtré par disponibilité et risque                   | Marketplace ouverte et extensions non fiables par défaut                                |
| Clients              | Web complet ; compagnon mobile fiable sur quelques parcours                       | Une navigation Cadran ; mêmes noms d'états                     | Refonte simultanée web/mobile/desktop et promesse de parité totale                      |
| Labs                 | États « virtuel », « non envoyé », « réel » honnêtes                              | Entrées optionnelles séparées du parcours quotidien            | Trading réel dans l'offre initiale ; candidatures/publications autonomes ; OSINT avancé |
| Maison et voix       | Reprise sans double effet, confidentialité micro, permissions physiques           | Un parcours matériel documenté à la fois                       | Support universel des satellites, écrans et appareils                                   |
| Exploitation         | Sauvegarde, récupération, mise à jour, diagnostic et retrait                      | Assistant guidé et documentation testée                        | HA/Kubernetes grand public tant que l'offre personnelle n'est pas fiable                |

## 4. Priorités et contrats techniques

### P0 — Garanties avant ouverture

| Action                                        | Constat | Livrable concret                                                                                        | Acceptation                                                                                                           |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Refuser MCP si isolation requise indisponible | F01     | Erreur typée, capacité hôte visible, mode non isolé distinct                                            | Pas de lancement sans bwrap utilisable ; scénarios binaire absent et namespaces refusés                               |
| Réduire les montages MCP                      | F02     | Root minimal, HOME dédié, sorties réseau et fichiers autorisés explicitement                            | Faux secret hors workspace illisible ; fichiers autorisés accessibles ; nettoyage après fin                           |
| Rendre la rotation de session atomique        | F03     | Consommation conditionnelle + successeur transactionnel                                                 | Test PostgreSQL concurrent : un seul gagnant ; rejeu et panne transactionnelle cohérents                              |
| Lier les opérations fichiers au propriétaire  | F04     | Identifiant workspace validé serveur, résolution réelle des chemins, droits sur checkpoint/diff/restore | Utilisateur B ne lit/modifie aucun objet de A ; chemins relatifs, liens symboliques et racines non attribuées refusés |
| Verrouiller bootstrap et reprise globale      | F05/F12 | Bootstrap à usage unique ; rôles explicites pause/reprise, révocation immédiate                         | Un seul premier admin même en concurrence ; membre ordinaire incapable de lever un arrêt réservé                      |
| Trier les risques de dépendances              | F15     | Inventaire production, analyse d'atteignabilité, correctifs et exceptions datées                        | Aucun risque élevé exploitable connu non traité dans le périmètre publié ; exceptions motivées et expirables          |

Ces actions sont P0 pour le périmètre exposé. Si l'offre reste strictement personnelle locale, les garanties d'équipe restent une porte fermée, pas une raison de prétendre l'isolation acquise.

### P1 — Parcours et exploitation indispensables

Annulation complète et suivi robuste (F06), accords web (F07), capacités honnêtes et réellement branchées (F08), coûts/provenance/budget (F09), liens artefacts/checkpoints (F10), sauvegarde/restauration et mises à jour (F13), récupération et cycle de vie des données (F14), tests de bout en bout et docs corrigées (F15/F16). Durabilité satellites (F11) devient P1 avant toute promesse d'automatisation physique fiable.

### P2 — Après stabilisation

Transfert de contexte multi-provider guidé, fonctions avancées de mémoire, confort d'affichage supplémentaire, élargissement matériel, desktop/mobile complets, nouvelles intégrations et enrichissement des labs. Leur entrée dépend d'une demande utilisateur démontrée, d'un responsable maintenance et d'une recette ; ce ne sont pas des prérequis artificiels de la première version stable.

## 5. Cadran : contribution précise et limites

Conserver les décisions acquises : Cadran pur, thèmes clair/sombre selon le système, IBM Plex, suppression Spatial, navigation unique, états mesurés et texte compréhensible pour les décisions. Respecter le partage de tokens : les clients mobile et desktop ne doivent pas être restylés accidentellement (`docs/design/03-design-system.md:483`).

| Travail Cadran                        | Dépendance fonctionnelle                                               | Porte de validation                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Fondation F et logo                   | Déjà présents dans l'arbre non commité ; à intégrer sans écraser       | Contrastes mesurés des composants réels, pas seulement tokens ; sources existantes préservées   |
| Kit K1/K2/K3                          | États loading/disabled/error, focus, dialogues                         | Clavier, Escape, retour du focus, annonces, lecteurs d'écran ; action dangereuse jamais masquée |
| Data wiring D                         | API confirmations, telemetry, routes et identifiants durables          | Chaque indicateur porte source et fraîcheur ; inconnu affiché comme inconnu                     |
| Serveur B : annulation                | Correction F06 et tests moteur/API/client                              | Ne pas activer un bouton d'annulation avant preuve du contrat serveur                           |
| Serveur B : accord de mission         | Portée user/mission/tool/action/risque, exclusion CRITICAL, révocation | Revue sécurité séparée, tests après fin/cancel/pause ; pas de consentement global implicite     |
| Shell S, conversation C et Activity A | Ownership et liens mission/run ; accords réellement branchés           | Parcours de référence complet en FR/EN, clair/sombre et petit écran                             |
| Settings, Usage, onboarding et labs   | Disponibilité réelle des capacités et sources de coût                  | Les options indisponibles expliquent leur raison ; les labs ne monopolisent pas l'accueil       |
| Nettoyage Z                           | Lots intégrés et tests mis à jour                                      | Pas de dépendance cachée aux anciennes classes ; pas de rupture de routes historiques           |

Les défauts F01–F05, F08–F14 ne sont pas des problèmes de couleur ou d'espacement. Les budgets, l'effacement, la durabilité et l'isolation doivent être suivis séparément des tâches Cadran. Le rapport de design signale encore des contrastes de couleurs fixes dans Career/Trading : les valider sur écrans réels. Ne pas déclarer la conformité d'accessibilité à partir de la matrice des tokens.

## 6. Lots ordonnés jusqu'à la version stable

Effort relatif, à réestimer après conception : **S** = changement local et recette ciblée ; **M** = plusieurs composants d'un domaine ; **L** = traversée UI/API/persistance et tests d'intégration ; **XL** = plusieurs frontières ou plateformes. Ce ne sont pas des engagements calendaires. Chaque lot doit se découper en changements reviewables ; les critères priment sur la date.

| Lot                                                | Priorité / effort                                   | Dépendances                          | Livraison et responsable de domaine suggéré                                                                               | Condition de sortie                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **L0 — Contrat de produit et preuve**              | P1 / S                                              | Audit présent                        | Responsable produit + QA : périmètre stable, inventaire capacités, matrice de support et registre des preuves             | Chaque promesse reliée à un test réel ou étiquetée expérimentale ; docs anciennes marquées historiques                                 |
| **L1 — Frontières de confiance**                   | P0 / L                                              | L0                                   | Sécurité/API : F01–F05/F12, tests négatifs et concurrence DB ; triage dépendances                                         | Reproductions échouent désormais de façon sûre ; aucun accès inter-propriétaires dans le corpus publié                                 |
| **L2 — Mission maîtrisable**                       | P1 / L                                              | L1 pour guards ; L0 pour états       | Moteur/API : annulation, reprise durable, état incertain, réconciliation et idempotence                                   | Crash/coupure/annulation aux points sensibles sans double effet ; identité conservée après recharge                                    |
| **L3 — Accord et résultat dans la conversation**   | P1 / L                                              | L2, contrats L1, kit Cadran          | Web/API : confirmations générales, refus, expiration, preuves d'effets, timeline simple                                   | Débutant termine une tâche sensible avec accord ; refus sans effet ; reload retrouve attente et résultat                               |
| **L4 — Fournisseur et coût compréhensibles**       | P1 / M–L                                            | L0, L2                               | Runtime providers : au moins un parcours API ou CLI certifié, modèle sélectionné, quotas/auth, coût/provenance et limites | Auth expirée/quota/429/réseau différenciés ; modèle inconnu jamais présenté comme tarif certain ; budget respecté selon contrat publié |
| **L5 — Documents et fichiers de confiance**        | P1 / L                                              | L1, L3                               | Outils/mémoire/VCS : brancher ingestion, dossier autorisé, liens persistants, diff/restauration                           | Fichier de démonstration → résumé sourcé → fichier produit → diff → restauration testée ; travail tiers conservé                       |
| **L6 — Installation, sauvegarde et sortie**        | P1 / L                                              | L1, schéma stabilisé L2/L5           | Exploitation : installation idempotente, archive/manifeste, restauration, récupération compte, export/suppression         | Poste vierge et restauration sur instance jetable réussis ; absence de secrets dans diagnostics ; guide conforme aux commandes         |
| **L7 — Cadran complet et accessibilité**           | P1 / L                                              | L3–L6 ; kit possible plus tôt        | Web/design : shell, navigation, états, onboarding, réglages et nettoyage                                                  | Parcours central clavier/lecteur d'écran, zoom 200 %, FR/EN, thèmes, largeur mobile ; aucune télémétrie décorative                     |
| **L8 — Qualification bêta personnelle**            | P1 / L                                              | L1–L7                                | QA + produit : matrice réelle, utilisateurs pilotes, erreurs et support                                                   | Critères bêta ci-dessous satisfaits, risques résiduels publics et bornés                                                               |
| **L9 — Maintenance et version stable personnelle** | P1 / L                                              | Bêta L8 et données d'usage           | Exploitation/QA : update N−1→N, rollback/restauration, documentation et support durable                                   | Critères stable satisfaits, incidents traités, procédure reproductible par une autre personne                                          |
| **L10 — Compagnon et appareils qualifiés**         | P1 pour fonctions annoncées, sinon P2 / L par cible | L8, L2/L6                            | Mobile/devices : suivi, accords, push, révocation ; puis un worker et un satellite documentés                             | Essais sur appareils réels, perte de réseau/background, commande à effet incertain et durabilité testés                                |
| **L11 — Petites équipes**                          | P2, P0 sécurité préalable / XL                      | L9, L1, inventaire transversal       | API/données/sécurité : rôles harmonisés, ownership partout, quotas, départ membre et audit                                | Campagne multi-compte REST/WS/MCP/files/backups réussie ; aucun domaine global non gouverné                                            |
| **L12 — Labs et extensions sélectionnés**          | P2 / M à XL par capacité                            | Socle stable et qualification propre | Mainteneur du domaine : intégrations réelles à valeur prouvée                                                             | Chaque module a désactivation propre, observabilité, consentement, recette et coût maintenance accepté                                 |

Chemin critique personnel : **L0 → L1 → L2 → L3 → L5 → L6 → L7 → L8 → L9**, avec L4 obligatoire avant L8. Le kit Cadran et les corrections documentaires peuvent avancer dès que leurs contrats sont connus ; l'activation visible suit la disponibilité du backend. L10–L12 ne doivent pas être ajoutés comme obstacles à la version stable personnelle si ces capacités restent hors promesse.

## 7. Recettes de qualification et conditions de sortie

### Matrice minimale de preuves

| Scénario                   | Environnement et données                                                 | Preuve à conserver                                                                            |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Première utilisation       | Machine vierge de chaque configuration annoncée ; compte de test         | Version, étapes, temps observé, erreurs, absence d'intervention cachée                        |
| Fournisseur réel           | Compte de test, tâche courte, plafond explicite                          | Modèle réellement utilisé, réponse, statut auth, coût disponible ou raison d'indisponibilité  |
| Outil et accord            | Fixture sans effets réels puis action réversible dans workspace jetable  | Avant/après, décision, hash de contenu, identifiant d'exécution unique                        |
| Annulation et crash        | Arrêt avant outil, pendant attente, après effet avant acquittement       | Journal corrélé et état durable ; aucune nouvelle action après annulation prise en compte     |
| Réseau et double clic      | Coupure client/API, timeout fournisseur, soumission répétée              | Même mission retrouvée, pas de doublon ; effet inconnu expliqué                               |
| Sécurité comptes/fichiers  | Deux comptes, deux workspaces, données synthétiques                      | Refus des accès croisés sur REST, WS, MCP, diff, restore, artefacts et exports                |
| MCP indisponible/hostile   | Hôte sans sandbox et fixture tentant un faux fichier hors périmètre      | Échec fermé, aucune lecture/exécution extérieure non autorisée                                |
| Sauvegarde et restauration | Instance jetable, conversations/mémoire/fichiers connus, secrets de test | Manifestes, checksums, restauration des données attendues et liste des exclusions             |
| Mise à jour                | Version précédente supportée → candidate ; échec de migration injecté    | Sauvegarde préalable, reprise/rollback testé, aucun effet externe rejoué aveuglément          |
| Accessibilité et langues   | Web réel en FR/EN, clair/sombre, clavier, lecteur d'écran, zoom          | Checklist par écran du parcours principal et défauts corrigés ; pas seulement capture d'image |
| Téléphone/voix/maison      | Seulement si ces fonctions sont annoncées pour cette version             | Appareil/OS exact, réseau coupé, micro fermé, révocation, résultat physique sûr               |

### Porte alpha interne → bêta publique personnelle

- F01–F03 fermés avec régression ; bootstrap sûr ; F04/F05 neutralisés dans le périmètre permis. Pas de multi-utilisateur annoncé tant que sa porte n'est pas fermée.
- Installation, fournisseur, tâche fichier, accord/refus, résultat, arrêt et reprise validés de bout en bout sur les configurations publiées.
- Aucun succès simulé présenté comme effet réel. Capacités indisponibles et labs explicitement signalés.
- Au moins un fournisseur réel et un chemin de travail local qualifiés ; bascule de fournisseur jamais silencieuse si elle change coût ou destination des données.
- Sauvegarde restaurée sur instance jetable ; export/effacement et récupération de compte documentés et exécutables.
- CI au runtime épinglé, suites locales et PostgreSQL critiques, tests E2E, contrôle dépendances et release hygiene verts ou exception documentée sans contourner une garantie de sécurité.
- Aucun défaut bloquant du parcours clavier, aucune information critique uniquement colorée ; textes FR/EN relus.
- Une personne distincte de l'implémenteur peut suivre le guide ; support, signalement de problème et diagnostic sans secrets accessibles.

Objectif d'essai utilisateur proposé : groupe initial de **8 à 12 personnes**, avec des débutants et des configurations variées. Viser **au moins 80 %** de réussite sans intervention sur la tâche de référence ; chaque échec est analysé. C'est un seuil de décision proposé, pas une mesure actuelle ni une preuve statistique de maturité générale. Les garanties de sécurité et d'absence de doubles effets exigent zéro échec dans leurs scénarios déterministes, même si l'UX atteint ce seuil.

### Porte bêta → stable personnelle

- Bêta observée assez longtemps pour couvrir usage récurrent, expiration d'identifiants, quota et au moins un cycle de mise à jour ; la durée est fixée après recrutement, pas promise arbitrairement.
- Tous les P0 fermés pour la distribution annoncée ; aucun P1 restant qui bloque un des parcours promis. Tout autre P1 a périmètre exclu ou résolution et responsable définis.
- Mise à jour depuis la version précédente et restauration indépendante réussies par une autre personne, sur les configurations supportées.
- Pas de perte de conversation ni d'effet externe dupliqué dans la campagne de panne ; résultats inconnus conservés et compréhensibles.
- Métriques de réussite, reprise, latence, coût disponible et intervention humaine publiées avec tailles d'échantillon, configuration et limites. Aucun chiffre artificiel de « fiabilité 100 % ».
- Procédure d'incident, politique de support, notes de version, politique de rétention et matrice de compatibilité à jour.
- Les plateformes non qualifiées restent expérimentales ; le label stable personnel ne se propage pas automatiquement au trading, à la domotique ou aux équipes.

### Porte petites équipes

Revue de toutes les ressources par propriétaire/organisation, rôles harmonisés, tests adversariaux REST et événements temps réel, accès fichiers bornés, budgets attribués, exports isolés et révocation immédiate après départ d'un membre. La reprise d'urgence globale et l'accès au coffre sont réservés explicitement. Un schéma `Organization` ou quelques tests de routes ne suffisent pas.

## 8. Mesures utiles et observabilité

Une mission doit porter des identifiants corrélés du client jusqu'au worker/provider. L'utilisateur voit un statut simple ; le diagnostic explique l'étape et propose une action. Ne pas collecter transcript, secrets ou contenu de fichiers dans la télémétrie par défaut.

| Mesure               | Définition à adopter                                                            | Utilité                                                   |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Réussite de tâche    | Résultat vérifié par une assertion indépendante, pas seulement état `succeeded` | Distingue réponse produite et travail réellement accompli |
| Reprise              | Missions retrouvées après coupure, sans resoumission ni double effet            | Mesure la fiabilité perceptible                           |
| Interventions        | Nombre d'actions humaines non prévues dans le parcours                          | Repère la complexité cachée                               |
| Temps avant résultat | Médiane et p95 sur tâches et providers identifiés                               | Évite les moyennes mélangeant opérations incomparables    |
| Accords              | Demandés, refusés, expirés, révoqués, appliqués avec bon contenu                | Vérifie confiance et fatigue de confirmation              |
| Coût connu           | Part des runs avec mesure exacte, estimation ou indisponibilité                 | Rend les limites économiques visibles                     |
| Restauration         | Dernier essai réussi et éléments réellement restaurés                           | Une archive existante n'est pas une récupération prouvée  |

Pas de score agrégé masquant une absence de sécurité. Les tests de source et de contrat restent rapides ; les intégrations DB/transport sont distinctes ; les smokes fournisseurs et matériels restent courts, contrôlés et explicitement budgétés.

## 9. Décisions produit à formaliser

Ces recommandations sont assez concrètes pour commencer les corrections autorisées ultérieurement ; ce document ne demande pas une nouvelle confirmation pour terminer l'audit.

| Décision                 | Proposition                                                                                                           | Conséquence                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Déploiement initial      | Instance personnelle, web prioritaire ; une configuration d'installation officiellement qualifiée avant élargissement | Réduit support et surface de preuve, sans supprimer les autres cibles du code          |
| Fournisseur par défaut   | Choisir après recette réelle ; pas imposer un fournisseur non testé ni un abonnement présumé disponible               | Le guide publie prérequis et coûts, l'utilisateur garde le choix                       |
| Autonomie initiale       | Lecture et préparation simples ; effets sensibles soumis à accord contextualisé                                       | Empêche d'assimiler permission technique et intention utilisateur                      |
| Autorisations de mission | Après L3 et revue dédiée ; user/mission/tool/action/risque, jamais CRITICAL, révocation visible                       | Réduit les accords répétitifs sans consentement illimité                               |
| Budgets                  | Limite de tâche et de période, provenance des mesures, arrêt prudent si budget non maîtrisable                        | Ne pas présenter un quota d'abonnement comme une facture ou comme gratuité             |
| Sources d'état           | Mission Engine propriétaire du cycle durable ; API propriétaire identité/droits ; clients projections                 | Évite deux systèmes d'état concurrents                                                 |
| Mémoire                  | Éléments consultables/corrigeables/effaçables, source et portée indiquées                                             | La personnalisation ne devient pas une boîte noire                                     |
| Données et sauvegardes   | Export compréhensible ; chiffrement recommandé par défaut, obligatoire si secrets inclus                              | Prévoit récupération et pertes de clés, sans promesse de restauration des effets tiers |
| Labs                     | Opt-in, état expérimental explicite, résultats simulés marqués                                                        | Socle utilisable sans trading/OSINT/carrière/maison configurés                         |
| Support stable           | Liste limitée de plateformes/providers, responsable et délai cible de traitement publiés après capacité réelle        | Aucun engagement de disponibilité inventé                                              |

## 10. Premières actions concrètes

1. Transformer F01–F05/F12 en tickets avec les références de l'audit et leurs tests négatifs ; ne pas modifier l'apparence pour les masquer. Commencer par refus MCP et rotation atomique.
2. Mettre à jour le contrat de capacités : enregistrer « prêt », « configuration requise », « expérimental », « simulé », « indisponible » ; corriger immédiatement les libellés de soumission carrière et les documents périmés.
3. Fixer le contrat d'annulation/reprise entre Python, client mission-control, API et conversation. Le contrat Cadran existe déjà ; en dériver les cas de panne avant de brancher le bouton.
4. Brancher les confirmations générales au chat, puis relier les identifiants conversation/mission/run/artefact/workspace. Garder l'accord de mission séparé jusqu'à sa revue.
5. Réserver un environnement jetable PostgreSQL et un compte fournisseur de test à budget minimal pour les recettes. Ne jamais utiliser les données personnelles comme fixture.
6. Corriger le guide de sauvegarde à partir du parseur réel et écrire la recette poste vierge/restauration ; clarifier les clés exclues et le mode HA non couvert.
7. Poursuivre Cadran depuis l'arbre actuel, sans écraser la fondation non commitée, après stabilisation des contrats. Fermer un parcours complet avant d'étendre les écrans.

## 11. État de vérification du plan

Ce plan est **livré comme document de décision et d'exécution**, pas comme une implémentation accomplie. Il s'appuie sur les lectures et tests consignés dans l'audit : dashboard, API, outils, MCP, agent-core, VCS, CLI, mémoire, appareils, voix, mobile et moteur Python ; reproductions MCP/refresh confirmées. Le navigateur n'a pas fourni de snapshot exploitable, les providers réels, appareils, PostgreSQL HA, restauration et distribution n'ont pas été validés ici. Ces limites sont précisément converties en portes de qualification, pas maquillées en fonctions absentes.

Le résultat recherché est une version stable au périmètre honnête, utilisable sans connaissance du monorepo et capable d'expliquer puis de récupérer ses erreurs. Les extensions ne deviennent prioritaires que lorsqu'elles améliorent cette expérience sur un socle déjà fiable.
