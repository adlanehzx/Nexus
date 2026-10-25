# Hosted deployment overlay

This overlay exposes only the authenticated API and dashboard through TLS. Replace the `.invalid`
hosts, provide `nexus-hosted-tls`, and install the database/Redis operators documented in
`../kubernetes/ha/README.md` before applying it. Workers, PostgreSQL, Redis, and the Mission Engine
remain private cluster services. Personal Docker Compose does not use this overlay.

Render without contacting a cluster:

```bash
kubectl kustomize infrastructure/kubernetes-hosted
```
