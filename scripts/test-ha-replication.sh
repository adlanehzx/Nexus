#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose -f infrastructure/docker/docker-compose.ha-test.yml)
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null
}
trap cleanup EXIT

cleanup
"${compose[@]}" up -d --wait

"${compose[@]}" exec -T postgres-primary psql -U nexus -d nexus -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE replication_probe(id integer primary key, value text not null); INSERT INTO replication_probe VALUES (1, 'replicated');" >/dev/null

for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T postgres-replica psql -U nexus -d nexus -Atc \
    "SELECT value FROM replication_probe WHERE id=1" | grep -qx replicated; then
    break
  fi
  sleep 1
done
"${compose[@]}" exec -T postgres-replica psql -U nexus -d nexus -Atc \
  "SELECT value FROM replication_probe WHERE id=1" | grep -qx replicated

backup_file=$(mktemp)
trap 'rm -f "$backup_file"; cleanup' EXIT
"${compose[@]}" exec -T postgres-primary pg_dump -U nexus -d nexus --format=custom > "$backup_file"
"${compose[@]}" exec -T postgres-primary createdb -U nexus nexus_restore
"${compose[@]}" exec -T postgres-primary pg_restore -U nexus -d nexus_restore < "$backup_file"
"${compose[@]}" exec -T postgres-primary psql -U nexus -d nexus_restore -Atc \
  "SELECT value FROM replication_probe WHERE id=1" | grep -qx replicated

"${compose[@]}" exec -T redis-primary redis-cli SET replication-probe replicated >/dev/null
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T redis-replica redis-cli GET replication-probe | grep -qx replicated; then
    break
  fi
  sleep 1
done
"${compose[@]}" exec -T redis-replica redis-cli GET replication-probe | grep -qx replicated

"${compose[@]}" stop redis-primary >/dev/null
for _ in $(seq 1 30); do
  role=$(timeout 3 "${compose[@]}" exec -T redis-replica redis-cli ROLE | head -1 | tr -d '\r' || true)
  if [ "$role" = master ]; then
    break
  fi
  sleep 1
done
timeout 3 "${compose[@]}" exec -T redis-replica redis-cli ROLE | head -1 | grep -qx master
"${compose[@]}" exec -T redis-replica redis-cli SET failover-probe recovered | grep -qx OK

echo "PostgreSQL streaming replication: PASS"
echo "PostgreSQL backup and isolated restore: PASS"
echo "Redis replication and Sentinel failover: PASS"
