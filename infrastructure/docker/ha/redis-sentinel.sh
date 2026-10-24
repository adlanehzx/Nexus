#!/bin/sh
set -eu

cat > /tmp/sentinel.conf <<EOF
port 26379
dir /tmp
sentinel monitor nexus 172.31.239.10 6379 2
sentinel down-after-milliseconds nexus 1000
sentinel failover-timeout nexus 5000
sentinel parallel-syncs nexus 1
EOF
exec redis-server /tmp/sentinel.conf --sentinel
