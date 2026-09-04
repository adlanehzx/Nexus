# 21 — Worker Android (implémenté)

Décrit le sous-système **tel qu'il est construit**. Paquets :
[`@nexus/android-worker`](../../services/android-worker) et
[`@nexus/worker-core`](../../packages/worker-core).

## 1. Ce que ce lot ajoute — et ce qu'il ne change pas

`TaskCoordinator`, `DeviceSelector`, `TaskPlan`, `WorkerGateway`,
`PermissionService` et `ConfirmationService` sont **inchangés**. Le Redmi leur
apparaît comme un exécutant ordinaire.

Trois choses ont bougé, chacune pour une raison contraignante :

1. **`@nexus/worker-core` a été extrait** du worker Windows. Dupliquer le cycle
   de vie et le registre de capacités aurait créé le second système de capacités
   que la consigne interdit — avec la garantie qu'un correctif appliqué d'un seul
   côté fasse diverger les deux.
2. **`ecdsaP256Verifier` a été ajouté** à `DeviceSessionService` : le magasin de
   clés d'Android ne gère pas Ed25519.
3. **`sensitiveResult` et `secretArguments`** ont été ajoutés au contrat de
   capacité : une capture d'écran ne doit pas entrer dans le journal d'audit, et
   un champ nommé `text` peut contenir un mot de passe.

## 2. Un runtime, trois plateformes

```
              @nexus/worker-core
     (cycle de vie · registre · exécution · reprise)
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   Windows        Android      (à venir)
   ports Node    ports Android
```

Le worker Windows et le worker Android exécutent **les mêmes lignes** pour tout
ce qui touche à la poignée de main, l'enregistrement, les battements de cœur,
l'exécution d'une étape, l'idempotence et la reprise. Ce qui les distingue tient
dans trois ports — signature, santé, minuteries — et dans les capacités.

La preuve est dans les tests : les 174 tests du worker Windows passent inchangés
après extraction.

## 3. Ce qu'Android autorise, et ce qu'il n'autorise pas

Android n'autorise pas le contrôle à distance arbitraire. Chaque capacité est
adossée à une API publique et à une permission que l'utilisateur accorde
explicitement — voir le tableau du [README](../../services/android-worker/README.md).

Deux décisions méritent d'être retenues :

- **`QUERY_ALL_PACKAGES` n'est pas demandé.** Un `<queries>` sur les activités
  lançables donne exactement les applications ouvrables, sans l'inventaire
  logiciel complet.
- **`MediaProjection` a été écarté** au profit de
  `AccessibilityService.takeScreenshot()` : une image sur appel, contre un flux
  vidéo continu. Le prix — pas de capture sous Android 11 — est assumé.

## 4. Les capacités apparaissent et disparaissent

Sur un poste de travail, ce qu'un worker sait faire ne change pas. Sur un
téléphone, cela change en permanence, et **c'est voulu** : l'utilisateur
désactive le service d'accessibilité parce qu'il prête son téléphone.

`AvailabilityWatcher` sonde périodiquement et réannonce les capacités par le
mécanisme existant — `worker.register`, qui déclenche
`device.capabilities_changed` côté cœur quand la liste diffère réellement.

Sans cela, le sélecteur continuerait de choisir le Redmi pour un clic qu'il ne
peut plus faire, après avoir écarté un exécutant capable.

## 5. Dégradé plutôt qu'absent

Un téléphone à 8 % de batterie reste joignable. Il ne doit simplement plus
recevoir de tâche non essentielle. `AndroidHealthSource` annonce alors une
capacité réduite : le sélecteur le voit saturé plus vite, sans qu'il faille lui
apprendre ce qu'est une batterie.

## 6. Deux fuites fermées

- **La capture d'écran** aurait été rangée telle quelle dans `TaskExecution.result`,
  et y serait restée des mois. La capacité déclare `sensitiveResult` : l'image
  atteint le client, le journal n'en garde qu'une mention.
- **Le texte saisi** atteignait le journal. `redact` reconnaît `password` et
  `token` ; il ne peut rien pour un champ légitimement nommé `text`. La capacité
  déclare `secretArguments: ["text"]` — seule elle sait ce que ses arguments
  transportent.

## 7. Ce qui n'est pas vérifié

La couche Kotlin est écrite mais **non compilée**, et aucun test n'a tourné sur
un Redmi Note 10S. La liste de vérification physique du README couvre ce que les
tests ne peuvent pas atteindre.
