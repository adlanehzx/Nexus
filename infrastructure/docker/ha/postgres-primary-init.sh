#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE nexus_replication WITH REPLICATION LOGIN PASSWORD '${POSTGRES_REPLICATION_PASSWORD}';
SQL
printf '%s\n' 'host replication nexus_replication all scram-sha-256' >> "$PGDATA/pg_hba.conf"
