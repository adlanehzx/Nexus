#!/bin/sh
set -eu

until pg_isready --host postgres-primary --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"; do
  sleep 1
done

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"
  chmod 700 "$PGDATA"
  export PGPASSWORD="$POSTGRES_REPLICATION_PASSWORD"
  pg_basebackup --host postgres-primary --username nexus_replication --pgdata "$PGDATA" --write-recovery-conf --wal-method stream
  unset PGPASSWORD
fi

exec docker-entrypoint.sh postgres -c hot_standby=on
