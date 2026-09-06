#!/bin/sh
set -eu
if [ -z "${WORLDFIXTURE_WORLD_PATH:-}" ]; then
  echo "worldfixture: missing world: WORLDFIXTURE_WORLD_PATH is required" >&2
  exit 64
fi

data=/tmp/worldfixture-postgres/data
state=/tmp/worldfixture-postgres
bind=${WORLDFIXTURE_POSTGRES_BIND:-127.0.0.1}
port=${WORLDFIXTURE_POSTGRES_PORT:-5432}
database=${POSTGRES_DB:-postgres}
username=${POSTGRES_USER:-worldfixture}
password=${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
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

# initdb permits TCP authentication only from localhost by default. A client
# using a Docker-published loopback port reaches PostgreSQL from the bridge
# address, not from container localhost. Keep password authentication mandatory
# for every TCP source, including those forwarded clients. The launcher limits
# the published port to host loopback; this is not a public database listener.
# Generate this file on every service start so existing data directories get
# the same policy without a database reset. Preserve local socket behavior.
hba_file="$state/pg_hba.conf"
hba_temporary=$(mktemp "$state/.pg_hba.XXXXXX")
printf '%s\n' \
  '# Generated WorldFixture authentication policy. TCP requires SCRAM.' \
  'local all all trust' \
  'host all all 0.0.0.0/0 scram-sha-256' \
  'host all all ::/0 scram-sha-256' > "$hba_temporary"
chown postgres:postgres "$hba_temporary"
chmod 0600 "$hba_temporary"
mv -f "$hba_temporary" "$hba_file"

exec runuser -u postgres -- "$postgres_bin/postgres" \
  -D "$data" \
  -h "$bind" \
  -p "$port" \
  -c "hba_file=$hba_file" \
  -c "listen_addresses=$bind" \
  -c "password_encryption=scram-sha-256"
