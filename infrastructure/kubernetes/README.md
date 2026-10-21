# NEXUS on Kubernetes / k3s

This deployment targets the **control plane**: dashboard, API, PostgreSQL, and Redis. ACP agents and workers remain on the machines where their accounts and subscriptions are authenticated. A phone or laptop is never a Kubernetes node.

## k3s Installation

1. Use a published release, or build images locally with `pnpm k8s:images` and adjust their names in `kustomization.yaml` for your k3s registry. Manifests pin `v1.0.0` and never implicitly track `latest`.
2. Copy `secret.example.yaml` to `secret.yaml`, generate secrets, and keep this file out of Git.
3. Apply in order:

```sh
kubectl apply -f infrastructure/kubernetes/namespace.yaml
kubectl apply -f infrastructure/kubernetes/secret.yaml
kubectl apply -k infrastructure/kubernetes
kubectl -n nexus rollout status deployment/nexus-api
kubectl -n nexus port-forward service/nexus-dashboard 8080:8080
```

Prisma migrations run in an init-container: the API deployment only becomes ready once the database schema is fully up to date. The local Mission Engine must be exposed over **private HTTPS** (Tailscale Serve is recommended), with `MISSION_CONTROL_URL` populated in `config.yaml`. Kubernetes never receives Codex, Claude, or Google API credentials.

Dashboard settings and logs use the `api-state` PVC. The API deployment is intentionally configured with a single replica and `Recreate` strategy: scaling to multiple replicas requires migrating state files to PostgreSQL or shared transactional storage.

For a permanent domain, copy `ingress.example.yaml` to `ingress.yaml`, configure the domain and TLS secret, and apply separately. This resource is intentionally excluded from `kustomization.yaml` to prevent invalid remote hostnames or unencrypted HTTP from breaking device pairing.

For single-machine setups, Docker Compose remains the recommended target. Kubernetes is intended for persistent multi-node Linux infrastructure.
