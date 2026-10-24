# NEXUS production HA on Kubernetes

Docker Compose remains the simplest personal deployment. This Kubernetes profile is the production HA
control plane for operators with a multi-node cluster and the required data operators. It runs three API
replicas and three fenced Mission Engine replicas while preserving the personal SQLite default outside
this profile.

This deployment targets the **control plane**: dashboard, API, PostgreSQL, and Redis. ACP agents and workers remain on the machines where their accounts and subscriptions are authenticated. A phone or laptop is never a Kubernetes node.

## k3s Installation

1. Install CloudNativePG and Spotahome Redis Operator at versions supporting the APIs listed in
   `ha/README.md`.
2. Use a published release, or build images locally with `pnpm k8s:images` and adjust their names in
   `kustomization.yaml` for your registry. Manifests pin `v1.0.0` and never track `latest`.
3. Copy `secret.example.yaml` to `secret.yaml`, generate secrets, and keep this file out of Git.
4. Apply in order:

```sh
kubectl apply -f infrastructure/kubernetes/namespace.yaml
kubectl apply -f infrastructure/kubernetes/secret.yaml
kubectl apply -k infrastructure/kubernetes
kubectl -n nexus rollout status deployment/nexus-api
kubectl -n nexus rollout status deployment/nexus-mission-engine
kubectl -n nexus port-forward service/nexus-dashboard 8080:8080
```

Prisma migrations run in an init-container: the API deployment only becomes ready once the database schema is fully up to date. The local Mission Engine must be exposed over **private HTTPS** (Tailscale Serve is recommended), with `MISSION_CONTROL_URL` populated in `config.yaml`. Kubernetes never receives Codex, Claude, or Google API credentials.

Mission state and mission artifacts use PostgreSQL. Runtime configuration and model caches use
`ReadWriteMany` volumes. Kubernetes scheduling spreads replicas across hosts, zones, and regions when
those labels exist; disruption budgets keep two application replicas available.

For a permanent domain, copy `ingress.example.yaml` to `ingress.yaml`, configure the domain and TLS secret, and apply separately. This resource is intentionally excluded from `kustomization.yaml` to prevent invalid remote hostnames or unencrypted HTTP from breaking device pairing.

Run `pnpm test:ha` before a production upgrade to exercise real PostgreSQL streaming replication and
Redis Sentinel promotion in isolated Docker volumes. Run `pnpm k8s:render` for a deterministic render.
For single-machine setups, Docker Compose remains the recommended target.
