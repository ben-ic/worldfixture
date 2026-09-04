#!/bin/sh
set -eu

data=/tmp/worldfixture-postgres/data
state=/tmp/worldfixture-postgres
bind=${WORLDFIXTURE_POSTGRES_BIND:-127.0.0.1}
port=${WORLDFIXTURE_POSTGRES_PORT:-5432}
database=${POSTGRES_DB:-postgres}
username=${POSTGRES_USER:-worldfixture}
password=${POSTGRES_PASSWORD:-worldfixture-local}
postgres_bin=/usr/lib/postgresql/15/bin

if [ ! -s "$data/PG_VERSION" ]; then
  install -d -m 0700 -o postgres -g postgres "$state" "$data"
  password_file="$state/.init-password"
  printf '%s\n' "$password" > "$password_file"
  chown postgres:postgres "$password_file"
  chmod 0600 "$password_file"
  runuser -u postgres -- "$postgres_bin/initdb" \
    --pgdata="$data" \
    --username="$username" \
    --pwfile="$password_file" \
    --auth-host=scram-sha-256 \
    --auth-local=trust
  rm -f "$password_file"
fi

exec runuser -u postgres -- "$postgres_bin/postgres" \
  -D "$data" \
  -h "$bind" \
  -p "$port" \
  -c "listen_addresses=$bind" \
  -c "password_encryption=scram-sha-256"
