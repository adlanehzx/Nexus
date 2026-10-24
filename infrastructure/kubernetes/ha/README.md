# NEXUS production HA overlay

This overlay replaces the alpha single-replica data services with three application replicas, three
fenced Mission Engine replicas, a three-instance CloudNativePG cluster, and Redis Sentinel failover.
The personal Docker Compose profile remains the default and requires neither operator.

Prerequisites:

- Kubernetes 1.30 or newer across at least three failure-domain nodes;
- CloudNativePG with the `postgresql.cnpg.io/v1` API;
- Spotahome Redis Operator with the `databases.spotahome.com/v1` API;
- a `ReadWriteMany` storage class for API state and model cache;
- the `nexus-secrets` keys documented in `secret.example.yaml`.

Render and server-side validate before applying:

```sh
kubectl kustomize infrastructure/kubernetes/ha
kubectl apply --dry-run=server -k infrastructure/kubernetes/ha
```

Topology rules spread API and Mission Engine replicas across zones and hosts. A disruption budget keeps
two replicas available. Mission state and artifacts use PostgreSQL transactions; stale workers cannot
commit after lease expiry because every completion checks the current fencing token.

CloudNativePG and Redis Operator own promotion and replica repair. NEXUS does not implement a second
failover controller. Cross-region use requires low-latency private networking and operator-tested storage
replication. Without those prerequisites, deploy one HA region and use tested backups for disaster
recovery instead of weakening synchronous durability.
