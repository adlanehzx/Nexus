# NEXUS sur Kubernetes / k3s

Cette cible déploie le **plan de contrôle** : dashboard, API, PostgreSQL et
Redis. Les agents ACP et les workers restent sur les machines où leurs comptes
sont authentifiés. Un téléphone n'est jamais un nœud Kubernetes.

## Installation k3s

1. Utiliser une release publiée, ou construire les images avec `pnpm k8s:images`
   puis adapter leurs noms dans `kustomization.yaml` pour le registre de k3s.
   Les manifests épinglent `v1.0.0` et ne suivent jamais implicitement `latest`.
2. Copier `secret.example.yaml` en `secret.yaml`, générer les valeurs et garder
   ce fichier hors de Git.
3. Appliquer dans cet ordre :

```sh
kubectl apply -f infrastructure/kubernetes/namespace.yaml
kubectl apply -f infrastructure/kubernetes/secret.yaml
kubectl apply -k infrastructure/kubernetes
kubectl -n nexus rollout status deployment/nexus-api
kubectl -n nexus port-forward service/nexus-dashboard 8080:8080
```

La migration Prisma est un init-container : l'API ne devient jamais prête avant
que le schéma soit à jour. Le Mission Engine local doit être exposé en **HTTPS privé** (Tailscale Serve est
adapté), puis `MISSION_CONTROL_URL` doit être renseigné dans `config.yaml`.
Kubernetes ne reçoit jamais les jetons Codex, Claude ou Google.

Les réglages modifiables depuis le dashboard et les journaux utilisent le PVC
`api-state`. Le déploiement API est volontairement limité à une réplique avec
une stratégie `Recreate` : passer à plusieurs répliques exige d'abord de migrer
ces fichiers vers PostgreSQL ou un stockage transactionnel partagé.

Pour une adresse permanente, copiez `ingress.example.yaml` en `ingress.yaml`,
remplacez le domaine et le secret TLS, puis appliquez-le séparément. Cette
ressource reste volontairement hors de `kustomization.yaml` : déployer un faux
domaine ou du HTTP distant rendrait l'appairage inutilisable.

Pour une machine unique, Docker Compose reste la cible recommandée. Kubernetes
devient utile pour plusieurs serveurs Linux permanents, pas pour les postes et
téléphones intermittents.
