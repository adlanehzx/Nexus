# ADR-010 — Deny par défaut, risque calculé, confirmation liée au hash

**Statut** : Proposé · 2026-09-01

## Contexte

L'agent peut envoyer des emails, supprimer des fichiers, exécuter des commandes. Il peut être
manipulé par une injection de prompt venue d'une page web ou d'un email, ou simplement se tromper.
Le cahier des charges définit trois niveaux (SAFE / CONFIRMATION / CRITIQUE) et interdit tout
accès implicite.

## Décision

1. **Deny par défaut.** L'absence de `PermissionGrant` vaut refus. Un outil nouvellement installé
   est inutilisable tant qu'un humain ne l'a pas autorisé.
2. **Le risque est calculé, pas seulement déclaré.** `RiskEvaluator` combine le `riskLevel` de
   l'outil, une évaluation des **arguments** (chemin hors zone, volume, montant, destinataires
   externes) et le contexte. Il peut seulement **élever** le niveau, jamais l'abaisser.
3. **Les grants sont scopés**, pas booléens : `device.fs.write` autorisé _sous `~/dev`, ≤ 5 Mo,
   jusqu'au 31/12_. Hors scope → `CONFIRM`, pas `DENY` : l'utilisateur garde la main.
4. **La confirmation est liée aux arguments** par un `payloadHash` et protégée par un `nonce` à
   usage unique et une expiration. Toute divergence entre ce qui a été approuvé et ce qui va être
   exécuté annule l'autorisation. C'est la protection contre le « bait and switch ».
5. **`CRITICAL` ne peut jamais être mémorisé** (« toujours autoriser » indisponible), exige une
   ré-authentification, n'est pas approuvable à la voix ni depuis une notification, et est refusé
   d'office si du contenu non fiable est entré dans le contexte pendant le tour.
6. **Le refus est une observation, pas un crash** : l'agent reçoit le motif et peut proposer une
   alternative ou expliquer ce qu'il faudrait autoriser.

## Alternatives

- **Faire confiance au prompt système.** Un prompt n'est pas un contrôle d'accès : il est
  contournable par construction. Écarté sans hésitation.
- **Tout confirmer.** Sûr mais inutilisable : la fatigue de confirmation conduit l'utilisateur à
  approuver sans lire, ce qui est _pire_ que moins de confirmations bien ciblées.
- **RBAC classique.** Pensé pour des rôles humains stables, pas pour des actions paramétrées où
  le risque dépend des arguments.

## Conséquences

**Positives** — une injection de prompt réussie ne peut au mieux que _demander_ un outil ;
l'exécution reste soumise au grant et à la confirmation. Chaque action réelle est tracée dans
`ToolExecution` et `AuditLog`. L'utilisateur peut tout révoquer instantanément.

**Négatives, acceptées** — friction initiale (mitigée par des grants scopés proposés au moment
opportun, et par une liste de `SAFE` par défaut généreuse) ; le `RiskEvaluator` est du code
métier à écrire et à tester exhaustivement ; le `payloadHash` interdit à l'agent de « corriger »
un argument après approbation — il doit redemander, ce qui est le comportement voulu.
