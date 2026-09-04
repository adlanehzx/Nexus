# @nexus/worker-core

Runtime commun à tous les exécutants NEXUS : cycle de vie, registre de capacités,
exécution d'étape, reprise.

**État : implémenté et testé.** 23 tests propres, plus 319 tests d'intégration
via les workers Windows et Android qui l'exercent de bout en bout.

---

## Pourquoi ce paquet existe

Le worker Windows et le worker Android partagent tout ce qui compte : la poignée
de main, l'enregistrement des capacités, les battements de cœur, la validation
des arguments, les délais, l'annulation, l'idempotence, la reconnexion.

Dupliquer ce code aurait créé deux systèmes de capacités et deux cycles de vie,
avec la garantie qu'un correctif appliqué d'un seul côté les fasse diverger. Ce
paquet est la réponse.

```
              @nexus/worker-core
     (cycle de vie · registre · exécution · reprise)
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  services/windows-worker    services/android-worker
    ports Node                 ports Android
```

---

## Ce qu'une plateforme doit fournir

Trois ports, pas un de plus :

| Port               | Rôle                | Windows             | Android                      |
| ------------------ | ------------------- | ------------------- | ---------------------------- |
| `CredentialSigner` | Signer le challenge | fichier PEM Ed25519 | magasin de clés, ECDSA P-256 |
| `HealthSource`     | Santé et saturation | `node:os`           | batterie, mode économie      |
| `TimerPort`        | Minuteries          | `setTimeout`        | idem, injectable en test     |

Tout le reste est identique.

---

## Portabilité

**Ce paquet n'importe aucune API de Node.** Il tourne sur Node _et_ sur Hermes,
le moteur JavaScript d'Android. Une seule importation de `node:` casserait le
bundle du worker Android, et l'erreur n'apparaîtrait qu'à l'exécution sur le
téléphone — au pire endroit possible pour la découvrir.

Un test scanne le code source pour l'empêcher.

---

## API

| Élément                               | Rôle                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `WorkerRuntime`                       | Cycle de vie complet : connexion, authentification, enregistrement, battements, exécution, reprise |
| `LocalCapabilityRegistry`             | Ce que cette machine sait faire, sonde comprise                                                    |
| `LocalCapability`                     | Contrat d'une capacité : schéma, risque, sonde, exécution                                          |
| `TaskRunner`                          | Chaîne de validation puis exécution d'une étape                                                    |
| `WorkerLink` · `LoopbackLink`         | Port de transport, et son implémentation en mémoire                                                |
| `Backoff`                             | Attente exponentielle avec bruit                                                                   |
| `WorkerLogger` · `MemoryWorkerLogger` | Journalisation rédigée                                                                             |

### Deux champs qui protègent

```ts
interface LocalCapability {
  /** Le cœur transmet le résultat au client sans le ranger dans son journal. */
  sensitiveResult?: boolean;
  /** Champs d'arguments à masquer avant journalisation. */
  secretArguments?: readonly string[];
}
```

Le premier existe pour la capture d'écran : masquer un mot à l'intérieur d'une
image n'a pas de sens, il faut ne pas la conserver. Le second pour la saisie de
texte : `redact` reconnaît `password` et `token`, il ne peut rien pour un champ
légitimement nommé `text` — seule la capacité sait ce qu'il transporte.
