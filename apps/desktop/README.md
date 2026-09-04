# Client Windows NEXUS

Le portable a le rôle **`BOTH`** : on y pilote NEXUS, et NEXUS y exécute des tâches.

Ces deux rôles sont **deux processus distincts**, et c'est la décision qui gouverne tout
le reste de ce dossier.

```
┌──────────────────────┐        ┌──────────────────────┐
│  apps/desktop        │        │  services/windows-   │
│  (cette fenêtre)     │        │  worker (le démon)   │
│                      │        │                      │
│  jetons utilisateur  │        │  clé privée machine  │
│  → /ws/client        │        │  → /ws/worker        │
└──────────┬───────────┘        └──────────┬───────────┘
           │                               │
           └───────────► cœur NEXUS ◄──────┘
                     autorisation, sélection
```

Il n'existe **aucun canal** entre les deux. Quand l'utilisateur demande depuis la fenêtre
quelque chose que ce poste doit faire, la demande sort par le réseau, remonte au cœur, y
est autorisée, et redescend par le canal exécutant. Le trajet paraît absurde pour deux
processus voisins ; il est ce qui garantit qu'une fenêtre compromise ne devient pas un
shell.

La seule chose que la fenêtre lit du démon est un **identifiant d'appareil**, déposé dans
`%ProgramData%\NEXUS\worker\device.json`. Il n'ouvre aucun droit ; il sert à ce que
l'interface se reconnaisse dans la liste d'appareils que le cœur lui renvoie, plutôt que
de créer un second « Portable » fantôme.

## Ce que l'interface sait faire

Discussion en flux, conversations, tâches, appareils, confirmations, notifications,
mémoire, réglages, et un écran de supervision de l'exécutant local — en **lecture**.

## Ce que l'interface ne sait pas faire

Exécuter une commande, lancer un processus, lire ou écrire un fichier arbitraire, parler
à Docker, à Git, ou au démon. Ce n'est pas une politique : il n'y a pas de code pour le
faire, et [`test/isolation.test.ts`](test/isolation.test.ts) casse le build si quelqu'un
en ajoute.

## Structure

| Chemin                     | Rôle                                                      |
| -------------------------- | --------------------------------------------------------- |
| `src/lib/shell.ts`         | Le port de la coquille — et la liste de ce qu'elle refuse |
| `src/lib/shells.ts`        | Tauri, et le repli navigateur                             |
| `src/lib/platform.ts`      | Les ports de `@nexus/client-core` pour le moteur de rendu |
| `src/lib/nexus.tsx`        | Assemblage et contexte React                              |
| `src/lib/worker-status.ts` | Statut de l'exécutant local, dérivé de la vue du cœur     |
| `src/lib/tasks.ts`         | Composition d'une demande de tâche                        |
| `src/lib/history.ts`       | Fusion de l'historique REST et du flux temps réel         |
| `src/ui/`                  | Écrans et composants                                      |
| `src-tauri/`               | Coquille native (Rust)                                    |

## Développement

```bash
pnpm --filter @nexus/desktop dev      # Vite seul, dans un navigateur
pnpm --filter @nexus/desktop tauri dev # fenêtre native (chaîne Rust requise)
```

`VITE_NEXUS_URL` pointe vers le cœur. **Aucun secret** n'est embarqué dans le paquet :
un exécutable de bureau se désassemble aussi bien qu'une application mobile.

Hors coquille native, les jetons vivent **en mémoire** et disparaissent au rechargement.
Écrire un jeton de rafraîchissement dans le stockage du navigateur le rendrait lisible
par n'importe quel script de la page, pour trente jours.

## Limite connue

`src-tauri/` **n'a pas été compilé** : la chaîne d'outils Rust n'est pas installée dans
l'environnement où le reste du dépôt est vérifié. Tout ce qui est au-dessus du port
`DesktopShell` l'est.
