# ADR-013 — Secrets : chiffrement enveloppe et port `SecretStore`

**Statut** : Proposé · 2026-09-01

## Contexte

Deux familles de secrets, souvent confondues :

- **Infrastructure** — clefs d'API LLM, mot de passe PostgreSQL, clefs de signature JWT.
- **Utilisateur** — jetons OAuth Google/GitHub, cookies de session de sites, clefs d'API tierces.

Contrainte du cahier des charges : aucun secret dans le code. À quoi s'ajoute une contrainte
propre aux agents : **le LLM ne doit jamais voir un secret**, sous peine de le recracher dans une
réponse ou de l'exfiltrer sous injection.

## Décision

1. **Infrastructure** — variables d'environnement injectées (Docker secrets sur le VPS), validées
   au démarrage par `@nexus/config` (Zod). Un secret manquant **empêche le boot**. Accès uniquement
   via un port `SecretStore`, jamais via `process.env` dispersé dans le code.
2. **Utilisateur** — chiffrement enveloppe : `MASTER_KEY` (env) → DEK par utilisateur (HKDF) →
   AES-256-GCM sur chaque credential, avec `keyVersion` pour permettre la rotation sans
   interruption. Jamais exposé par l'API, même à son propriétaire (on montre l'existence et les
   scopes, pas la valeur).
3. **Les outils reçoivent des `secretRef`**, résolus **dans le `ToolExecutor`**, après la décision
   de permission. Le LLM voit `secretRef: FLIGHT_API_KEY`, jamais la valeur ; les arguments
   persistés et journalisés sont rédigés.
4. **Redaction systématique** (Pino) sur `authorization`, `cookie`, `token`, `password`, `apiKey`,
   plus un détecteur de motifs (`sk-`, `ghp_`, JWT) en dernier rideau.
5. **`gitleaks`** en pre-commit et en CI ; `.env.example` liste les clefs, jamais les valeurs.

## Alternatives

- **Vault / Infisical dès le départ.** Le bon outil à grande échelle, mais un service de plus à
  opérer et à sauvegarder pour un système mono-utilisateur. Le port `SecretStore` rend la
  migration ultérieure indolore : un adaptateur, zéro changement d'appelant.
- **KMS cloud (AWS/GCP).** Excellente gestion de clefs, mais lie l'infrastructure à un cloud alors
  que la cible est un VPS neutre.
- **Secrets utilisateur en clair en base.** Inacceptable : une fuite de dump donnerait accès aux
  comptes Google et GitHub de l'utilisateur.

## Conséquences

**Positives** — un dump de base volé ne suffit pas à compromettre les comptes tiers (il faut aussi
`MASTER_KEY`) ; la rotation est possible ; le LLM ne peut pas exfiltrer ce qu'il n'a jamais vu.

**Négatives, acceptées** — `MASTER_KEY` devient le secret racine : sa perte rend les credentials
irrécupérables (d'où sa sauvegarde hors ligne, dans un gestionnaire de mots de passe), et sa fuite
combinée à un dump est critique. La rotation de la clef racine est une opération à scripter
(`infra/scripts/rotate-master-key.ts`) et à tester avant d'en avoir besoin.
