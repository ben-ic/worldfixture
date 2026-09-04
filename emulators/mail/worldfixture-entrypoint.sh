#!/bin/sh
set -eu

state=/tmp/worldfixture-mail
share=/usr/share/worldfixture-mail
smtp_address=${WORLDFIXTURE_SMTP_LISTEN:?}
imap_address=${WORLDFIXTURE_IMAP_LISTEN:?}
health_address=${WORLDFIXTURE_HEALTH_LISTEN:?}
mailbox_address=${WORLDFIXTURE_MAILBOX_LISTEN:?}
world_path=${WORLDFIXTURE_WORLD_PATH:?}

[ -f "$world_path/projections/mail.json" ] || {
  echo "WORLDFIXTURE_WORLD_PATH has no projections/mail.json" >&2; exit 64; }

# SMTP and IMAP bind loopback unless the environment says otherwise.
#
# The rule used to be absolute, and it was right for the topology it came from:
# this service ran inside the session microVM beside the application, so loopback
# was the boundary. WorldFixture's application usually runs on the host or in
# another container, and a first run prints "SMTP localhost:2525" and "IMAP
# localhost:1143" among the bindings it hands out, so an unconditional refusal
# makes the connection values the product itself prints impossible to use.
#
# The default is unchanged. Widening it is now a deliberate act by whoever starts
# the container, and it is a synthetic world in the reserved `.test` domain with
# fixture credentials, not a mail server.
case "$smtp_address $imap_address" in
  127.0.0.1:*\ 127.0.0.1:*) ;;
  *)
    [ "${WORLDFIXTURE_MAIL_PUBLISH:-}" = "1" ] || {
      echo "SMTP and IMAP bind loopback unless WORLDFIXTURE_MAIL_PUBLISH=1" >&2
      exit 64
    }
    ;;
esac

smtp_host=${smtp_address%:*}
smtp_port=${smtp_address##*:}
imap_host=${imap_address%:*}
imap_port=${imap_address##*:}
health_host=${health_address%:*}
health_port=${health_address##*:}
mailbox_host=${mailbox_address%:*}
mailbox_port=${mailbox_address##*:}

case "$mailbox_host" in
  0.0.0.0|127.0.0.1) ;;
  *) echo "Mailbox web must bind the container or loopback interface" >&2; exit 64 ;;
esac

mkdir -p "$state/cyrus/db" "$state/cyrus/socket" "$state/cyrus/quota" "$state/cyrus/user" \
  "$state/spool" "$state/run/proc" "$state/run/lock" "$state/health"

# The world is read before Cyrus starts. Accounts, folders, mailbox names, the
# realm and every seed message are derived here, from the projection, and never
# from a value compiled into the image.
"$share/world-mail.pl" prepare "$world_path" "$state/world"
domain=$(cat "$state/world/default-domain")
folders=$(tr '\n' '|' < "$state/world/folders.txt" | sed 's/|$//; s/|/ | /g')
# Cyrus master hands its services no config path, so every one of them reads
# `/etc/imapd.conf`. The rendered configuration has to land there, not beside the
# session state: an imapd that falls back to the compiled-in defaults answers
# every login with "couldn't create proc directory".
sed "s/@@DOMAIN@@/$domain/g; s/@@FOLDERS@@/$folders/" \
  /etc/worldfixture-mail/imapd.conf > /etc/imapd.conf

# SASL accounts are created here, not in the image, because the realm is the
# world's domain and the world only exists at runtime. Each person is registered
# in the realm of their own address; the one admin exists so the seeding path can
# create another person's mailbox.
rm -f /etc/sasldb2
while IFS='	' read -r id local user_domain login password address name folder_list; do
  [ -n "${local:-}" ] || continue
  printf '%s' "$password" | saslpasswd2 -p -c -u "$user_domain" "$local"
done < "$state/world/accounts.tsv"
while IFS='	' read -r admin_user admin_password; do
  [ -n "${admin_user:-}" ] || continue
  printf '%s' "$admin_password" | saslpasswd2 -p -c -u "$domain" "$admin_user"
done < "$state/world/admin.tsv"
chown cyrus:mail /etc/sasldb2
chmod 640 /etc/sasldb2

chown -R cyrus:mail "$state/cyrus" "$state/spool" "$state/run"
sed "s/127.0.0.1:1143/$imap_host:$imap_port/" /etc/worldfixture-mail/cyrus.conf > "$state/cyrus.conf"

/usr/sbin/cyrus master -C /etc/imapd.conf -M "$state/cyrus.conf" -d &
cyrus_pid=$!

i=0
while [ ! -S "$state/run/lmtp" ]; do
  i=$((i + 1))
  [ "$i" -lt 300 ] || { echo "Cyrus LMTP did not start" >&2; exit 1; }
  sleep 0.1
done

i=0
until printf 'z LOGOUT\r\n' | /bin/busybox nc -w 5 127.0.0.1 "$imap_port" | grep -q '^\* OK'; do
  i=$((i + 1))
  [ "$i" -lt 300 ] || { echo "Cyrus IMAP did not start" >&2; exit 1; }
  sleep 0.1
done

"$share/world-mail.pl" mailboxes "$imap_port" "$state/world"

if [ ! -e "$state/seeded-v2" ]; then
  # The world's own messages are delivered through Cyrus LMTP, in projection
  # order, with the Date each record states. Seeding reads no clock.
  while IFS='	' read -r sender recipient message; do
    [ -n "${message:-}" ] || continue
    "$share/lmtp-submit.pl" "$state/run/lmtp" "$recipient" "$message" "$sender"
  done < "$state/world/delivery.tsv"
  "$share/world-mail.pl" flags "$imap_port" "$state/world"
  touch "$state/seeded-v2"
fi

"$share/smtp-server.pl" "$smtp_host" "$smtp_port" "$state/run/lmtp" "$domain" &
smtp_pid=$!

i=0
until perl -MIO::Socket::INET -e \
  '$s = IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => $ARGV[0], Proto => "tcp", Timeout => 1) or exit 1' \
  "$smtp_port"; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || { echo "SMTP bridge did not start" >&2; exit 1; }
  sleep 0.1
done

"$share/mailbox-web.pl" "$mailbox_host" "$mailbox_port" "$imap_port" "$smtp_port" "$state/world" &
mailbox_pid=$!

i=0
until perl -MIO::Socket::INET -e \
  '$s = IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => $ARGV[0], Proto => "tcp", Timeout => 1) or exit 1; print {$s} "GET /readyz HTTP/1.0\r\n\r\n"; $line = <$s>; exit(($line // "") =~ m{^HTTP/1.[01] 200} ? 0 : 1)' \
  "$mailbox_port"; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || { echo "Mailbox web did not start" >&2; exit 1; }
  sleep 0.1
done

printf 'ok\n' > "$state/health/readyz"
/bin/busybox httpd -f -p "$health_host:$health_port" -h "$state/health" &
health_pid=$!

stop() {
  trap - INT TERM EXIT
  kill "$health_pid" "$mailbox_pid" "$smtp_pid" 2>/dev/null || true

  # Cyrus leaves its launcher and runs `master` under container init. The PID
  # saved from `master -d &` is therefore not the process that owns IMAP. Debian
  # pidof does not find it under Rosetta, but BusyBox reads /proc/<pid>/comm and
  # does. Do not let this shell exit until every Cyrus master is gone: reset
  # starts mail again as soon as the shell exits.
  for pid in $(/bin/busybox pidof master 2>/dev/null || true); do
    kill -TERM "$pid" 2>/dev/null || true
  done

  wait "$health_pid" "$mailbox_pid" "$smtp_pid" "$cyrus_pid" 2>/dev/null || true

  attempts=0
  while /bin/busybox pidof master >/dev/null 2>&1 && [ "$attempts" -lt 100 ]; do
    attempts=$((attempts + 1))
    sleep 0.1
  done
  if /bin/busybox pidof master >/dev/null 2>&1; then
    for pid in $(/bin/busybox pidof master 2>/dev/null || true); do
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi
}
trap stop INT TERM EXIT

while kill -0 "$health_pid" 2>/dev/null \
  && kill -0 "$mailbox_pid" 2>/dev/null \
  && kill -0 "$smtp_pid" 2>/dev/null \
  && /bin/busybox pidof master >/dev/null; do
  sleep 1
done
kill -0 "$health_pid" 2>/dev/null || echo "health server exited" >&2
kill -0 "$mailbox_pid" 2>/dev/null || echo "mailbox web exited" >&2
kill -0 "$smtp_pid" 2>/dev/null || echo "SMTP bridge exited" >&2
/bin/busybox pidof master >/dev/null || echo "Cyrus exited" >&2
exit 1
