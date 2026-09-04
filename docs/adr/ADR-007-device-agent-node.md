# ADR-007 — Device Agent en Node.js headless, distinct de l'app desktop

**Statut** : Proposé · 2026-09-01

## Contexte

Le PC doit pouvoir exécuter des tâches (fichiers, shell, Docker, Git) demandées par l'agent, même
quand l'application desktop est fermée. Il faut donc un démon. Deux questions : dans quel langage,
et faut-il le fondre dans l'application Tauri ?

## Décision

Un **démon Node.js autonome** (`apps/device-agent`), installé comme service
(Windows Service / launchd / systemd), distinct de l'application desktop. L'app Tauri l'installe,
le supervise, affiche son état et ses logs, et peut le lancer en sidecar pour un usage simple.

Distribution en binaire unique (Node SEA ou `pkg`), signé, avec auto-update vérifié par signature.

## Alternatives

- **Écrire l'agent en Rust dans le cœur Tauri.** Meilleure empreinte mémoire et démarrage plus
  rapide. Écarté pour deux raisons décisives : il faudrait **réimplémenter le protocole WebSocket
  et tous les schémas en Rust**, créant exactement la dérive de contrat que le monorepo cherche à
  éviter ; et l'agent cesserait de fonctionner quand l'app est fermée, sauf à écrire un second
  service de toute façon.
- **Pas de démon : tout passe par l'app desktop ouverte.** Simple, mais casse le cas d'usage
  central (« lance les tests sur mon PC » depuis l'iPhone, PC allumé mais app fermée).
- **Agent en Python.** Aucun bénéfice ici, et un runtime de plus à distribuer.

## Conséquences

**Positives** — `@nexus/device-protocol` et `@nexus/contracts` sont partagés tels quels : un seul
protocole, typé, testé une fois. L'agent fonctionne sans UI. On peut l'installer sur une machine
sans interface graphique (serveur personnel, NAS).

**Négatives, acceptées** — un runtime Node embarqué pèse ~50 Mo et consomme ~40 Mo de RSS au repos
(acceptable sur un PC de développement) ; il faut gérer l'installation de service sur trois OS et
la signature de code sur Windows et macOS (coût de certificat, à prévoir en phase 4).
