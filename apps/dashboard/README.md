# Tableau de bord NEXUS

Supervision de tout le système. **Lecture seule, réservé aux administrateurs.**

```
apps/dashboard  ──▶  /api/v1/dashboard/*  ──▶  requireAdmin  ──▶  DashboardService
   (React)                                        (rôle lu                (lectures)
                                                dans le magasin)
```

## Douze sections

| Section        | Ce qu'on y voit                                                                             |
| -------------- | ------------------------------------------------------------------------------------------- |
| Vue d'ensemble | appareils en ligne, exécutants actifs, tâches en cours et en échec, activité récente, santé |
| Appareils      | rôle, plateforme, statut, capacités, dernier battement, santé, confiance, permissions       |
| Exécutants     | l'état déclaré **et** l'état réel du canal, la charge, les capacités                        |
| Tâches         | plan, étapes, exécutants retenus, progression, journal d'exécution, résultats, erreurs      |
| Runs agent     | statut, actions, outils, progression, résultat, erreurs, métriques                          |
| Outils         | catalogue, risque, permissions requises, autorisé ou non                                    |
| MCP            | serveurs, état, outils publiés, circuit, dernière erreur                                    |
| Browser Use    | configuré, joignable, santé rapportée                                                       |
| Mémoire        | volumes par couche, origine et sensibilité ; souvenirs récents                              |
| Notifications  | non lues, gravité, contenu                                                                  |
| Sécurité       | confiance des appareils, permissions effectives, événements                                 |
| Journaux       | dernières lignes retenues, filtrables par niveau et par texte                               |

## Trois règles

### 1. Le raisonnement du modèle ne sort pas

Un run d'agent porte son transcript complet et les blocs opaques du fournisseur
(`LlmMessage.providerBlocks`). Ils existent pour être rejoués au tour suivant, pas pour
être lus.

La garantie est obtenue **par construction** : `projectAgentRun` ne lit que
`AgentRunRecord` — jamais `AgentState.messages`. On ne peut pas oublier de masquer un
champ auquel on n'accède pas. Le schéma Zod de la réponse ferme la porte une seconde
fois : même si la projection changeait, un champ non déclaré ne serait pas sérialisé.

Ce qui sort : **statut, action, outil, progression, résultat, erreur, métriques.**

Éprouvé par un run dont chaque champ interdit porte une chaîne reconnaissable, cherchée
ensuite dans la réponse JSON entière (`services/api/test/dashboard.test.ts`), et par une
vérification structurelle côté client (`test/exposure.test.ts`).

### 2. Douze sections, une seule garde

Chaque route porte `requireAdmin`. Il n'existe pas de sous-ensemble « moins sensible »
ouvert à un client ordinaire : une vue partielle du système est encore une vue du
système, et découper la garde créerait douze occasions de se tromper au lieu d'une.

Le rôle est lu **dans le magasin, pas dans le jeton**. Inscrit dans le jeton d'accès, il
resterait valide un quart d'heure après une rétrogradation. La session est déjà consultée
à chaque requête ; une lecture de plus est négligeable, et c'est ce qui fait qu'un retrait
de droits prend effet immédiatement.

Le refus ne s'annonce pas : un compte ordinaire reçoit « La ressource demandée n'existe
pas », pas « il faut être administrateur ». La surface d'administration n'a pas à se
signaler à qui n'y a pas droit.

### 3. Lecture seule

Aucune route ni méthode de client n'écrit. Superviser et administrer sont deux surfaces ;
mettre une action destructrice dans un écran qu'on consulte machinalement est une mauvaise
idée qui ne se remarque qu'une fois. Approuver un appareil, révoquer, annuler une tâche
restent sur les routes existantes, avec leurs propres contrôles.

## Portée

Deux portées, délibérément distinctes :

- **ce qui appartient à quelqu'un** — appareils, tâches, souvenirs, notifications, runs —
  est lu pour le compte de l'administrateur, jamais pour tous les comptes. Le rôle `ADMIN`
  ouvre la supervision de l'infrastructure ; il n'a jamais eu vocation à donner accès aux
  conversations d'autrui ;
- **ce qui n'appartient à personne** — serveurs MCP, worker navigateur, catalogue
  d'outils, journaux — est global.

## « Non configuré » n'est pas « en panne »

Un serveur MCP qu'on n'a jamais branché n'est pas en panne. Le peindre en rouge enverrait
chercher un incident qui n'existe pas. `unconfigured` est donc un niveau de santé à part
entière, gris, et il ne compte pas dans la santé globale — s'il n'y a _que_ du
non-configuré, la réponse est « inconnu », ce qui vaut mieux qu'un vert qui ne repose sur
rien.

## Développement

```bash
pnpm --filter @nexus/dashboard dev     # http://localhost:5274
```

`VITE_NEXUS_URL` pointe vers le cœur. **Aucun secret n'est embarqué** : le tableau de bord
se connecte comme n'importe quel client, et c'est le rôle du compte qui lui ouvre les
sections.

Les jetons vivent **en mémoire** et disparaissent au rechargement. Un tableau de bord
d'administration est précisément l'endroit où l'on ne veut pas d'un jeton de longue durée
lisible par n'importe quel script de la page.

## Le premier compte

`InMemoryUserStore` donne le rôle `ADMIN` au **premier compte créé** — il faut bien que
quelqu'un puisse ouvrir le tableau de bord sur une installation neuve. Les suivants sont
des comptes ordinaires.

> **Conséquence à ne pas oublier :** une installation exposée doit fermer l'inscription dès
> le premier compte créé. Sinon, le premier venu devient administrateur.
