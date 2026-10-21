# Publier une release

1. Mettre à jour la version et le journal des changements, puis vérifier la CI de la branche.
2. Créer un tag annoté `vMAJEUR.MINEUR.CORRECTIF` sur le commit validé.
3. Pousser le tag. Le workflow `Release` reconstruit l'API, génère un SBOM SPDX, publie l'image
   `ghcr.io/<propriétaire>/<dépôt>/api` et la signe sans clé statique avec l'identité OIDC GitHub.
4. Vérifier la signature Cosign, les checksums et le SBOM avant de publier les notes GitHub.

Exemple de vérification :

```bash
cosign verify ghcr.io/OWNER/REPOSITORY/api:v1.2.3 \
  --certificate-identity-regexp='https://github.com/OWNER/REPOSITORY/.github/workflows/release.yml' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

Une release ne doit contenir aucun `.env`, profil de navigateur, base locale, sauvegarde,
identifiant ACP ou chemin utilisateur. Le paquet racine reste `private: true` pour empêcher une
publication npm accidentelle ; cela ne limite pas la licence open source du dépôt.
