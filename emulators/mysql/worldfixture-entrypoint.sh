#!/bin/sh
set -eu
if [ -z "${WORLDFIXTURE_WORLD_PATH:-}" ]; then
  echo "worldfixture: missing world: WORLDFIXTURE_WORLD_PATH is required" >&2
  exit 64
fi

state=/tmp/worldfixture-mysql
data=$state/data
bind=${WORLDFIXTURE_MYSQL_BIND:-127.0.0.1}
port=${WORLDFIXTURE_MYSQL_PORT:-3306}
socket=$state/mysql.sock
init_file=$state/init.sql
password=${MARIADB_PASSWORD:?MARIADB_PASSWORD is required}
escaped_password=$(printf '%s' "$password" | sed "s/'/''/g")

install -d -m 0750 -o mysql -g mysql "$state" "$data"

if [ ! -d "$data/mysql" ]; then
  mariadb-install-db \
    --user=mysql \
    --datadir="$data" \
    --auth-root-authentication-method=normal \
    --skip-test-db
fi

cat > "$init_file" <<SQL
CREATE DATABASE IF NOT EXISTS \`worldfixture\`;
CREATE USER IF NOT EXISTS 'worldfixture'@'%' IDENTIFIED BY '$escaped_password';
ALTER USER 'worldfixture'@'%' IDENTIFIED BY '$escaped_password';
GRANT ALL PRIVILEGES ON \`worldfixture\`.* TO 'worldfixture'@'%';
FLUSH PRIVILEGES;
SQL
chown mysql:mysql "$init_file"
chmod 0600 "$init_file"

exec mariadbd \
  --user=mysql \
  --datadir="$data" \
  --bind-address="$bind" \
  --port="$port" \
  --socket="$socket" \
  --pid-file="$state/mysql.pid" \
  --init-file="$init_file" \
  --skip-name-resolve
