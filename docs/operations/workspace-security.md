# Dossiers autorisés et outils locaux

Le propriétaire de l'instance attribue explicitement chaque dossier utilisable par le compte. Dans Activité → Dépôts, saisir un chemin absolu **sur le serveur Nexus**, puis choisir ce dossier pour les opérations Git. Un chemin du navigateur ou un chemin relatif comme `.` n'est pas accepté.

L'API réserve l'ajout et la révocation aux administrateurs. Un autre compte ne reçoit aucun accès implicite au même dossier. Les liens symboliques qui sortent d'une racine attribuée sont refusés. Un worktree doit aussi permettre l'accès au répertoire Git commun dont il dépend.

Le bouton « Révoquer l'accès » retire l'autorisation des prochaines opérations et masque les checkpoints associés. Il conserve les fichiers et les références Git. Une opération déjà commencée peut finir ; la révocation ne supprime pas un fichier déjà produit.

## Checkpoints

Un checkpoint exige un dépôt Git. Nexus ne crée pas automatiquement de dépôt et ne prétend pas sauvegarder un dossier ordinaire. Une erreur d'écriture des métadonnées ou de la base est renvoyée au demandeur ; elle ne doit pas être interprétée comme un instantané durable réussi.

La restauration utilise un instantané de sécurité avant modification, préserve l'index Git et conserve les nouveaux fichiers non suivis. Elle modifie néanmoins les fichiers suivis pour revenir à l'état capturé : consulter le diff avant de confirmer. La correspondance avec une conversation dépend encore de l'identifiant de thread utilisé lors de la capture ; aucune capture automatique n'est garantie.

## MCP sur Linux

Le lancement MCP stdio exige Bubblewrap (`bwrap`). Si l'isolation n'est pas disponible, le lancement échoue ; il n'existe plus de repli silencieux vers une exécution libre.

Le système de fichiers visible commence par une racine vide et des répertoires système en lecture seule. Le dossier personnel hôte n'est pas monté ; `HOME` désigne un dossier temporaire isolé. Un runtime Node/Python installé sous un dossier utilisateur et le paquet MCP doivent être ajoutés aux montages explicitement autorisés. Monter uniquement les chemins nécessaires, en lecture seule lorsque possible, puis tester l'outil sur des données de démonstration.

Ces contrôles couvrent le périmètre personnel mono-processus. Les configurations de dossiers stockées dans un fichier ne sont pas qualifiées pour des écritures simultanées depuis plusieurs réplicas API.
