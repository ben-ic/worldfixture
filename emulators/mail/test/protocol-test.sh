#!/bin/sh
# Protocol check for the WorldFixture mail emulator.
#
# Every expectation in this file is computed from the world projection, not from
# a fixture written into the test. The counts come out of `mail.json` directly,
# through a reader that is not the seeder's, so a seeding bug cannot agree with
# itself and pass.
set -eu

state=/tmp/worldfixture-mail
world_dir=$state/world
share=/usr/share/worldfixture-mail
projection=${WORLDFIXTURE_WORLD_PATH:?}/projections/mail.json
smtp_port=${WORLDFIXTURE_SMTP_LISTEN##*:}
imap_port=${WORLDFIXTURE_IMAP_LISTEN##*:}
mailbox_port=${WORLDFIXTURE_MAILBOX_LISTEN##*:}

[ -f "$projection" ] || { echo "the world projection is missing" >&2; exit 1; }
[ -f "$world_dir/accounts.tsv" ] || { echo "the fixture prepared no accounts" >&2; exit 1; }

imap() { /bin/busybox nc -w 10 127.0.0.1 "$imap_port"; }

fail() { echo "protocol check failed: $*" >&2; exit 1; }

# --- what the world says -----------------------------------------------------

expected=$state/expected.tsv
perl -MJSON::PP -e '
  open my $handle, "<", $ARGV[0] or die "cannot read projection\n";
  binmode $handle; local $/; my $raw = <$handle>; close $handle;
  my $world = JSON::PP->new->utf8->decode($raw);
  my (%inbox, %sent, %unread, %login);
  $login{$_->{id}} = lc($_->{login} // $_->{email}) for @{$world->{users}};
  for my $message (@{$world->{messages}}) {
    my %label = map { $_ => 1 } @{$message->{labels} // []};
    for my $person (@{$message->{to_ids}}) {
      $inbox{$person} += 1;
      $unread{$person} += 1 if $label{UNREAD};
    }
    $sent{$message->{from_id}} += 1 if $label{SENT};
  }
  for my $person (sort keys %login) {
    printf "%s\t%d\t%d\t%d\n", $login{$person},
      $inbox{$person} // 0, $sent{$person} // 0, $unread{$person} // 0;
  }
' "$projection" > "$expected"

people=$(/usr/bin/wc -l < "$expected" | tr -d ' ')
[ "$people" -ge 2 ] || fail "the world declares fewer than two mail people"
messages=$(perl -MJSON::PP -e '
  open my $handle, "<", $ARGV[0] or die; binmode $handle; local $/; my $raw = <$handle>;
  print scalar @{JSON::PP->new->utf8->decode($raw)->{messages}}, "\n";
' "$projection")
echo "world: $people people, $messages messages"

# --- IMAP LOGIN as every world person, with the world's own counts ------------

checked=0
while IFS='	' read -r login inbox sent unread; do
  password=$(/bin/busybox awk -F'\t' -v login="$login" '$4 == login {print $5}' "$world_dir/accounts.tsv")
  [ -n "$password" ] || fail "no runtime account for $login"

  result=$(printf 'a LOGIN "%s" "%s"\r\nb LIST "" "*"\r\nc SELECT INBOX\r\nd SEARCH UNSEEN\r\ne SELECT Sent\r\nf LOGOUT\r\n' \
    "$login" "$password" | imap)
  printf '%s\n' "$result" | grep -q '^a OK' || fail "$login could not log in over IMAP"

  seen_inbox=$(printf '%s\n' "$result" | /bin/busybox awk '/^c OK/{exit} /EXISTS/{n=$2} END{print n+0}')
  [ "$seen_inbox" = "$inbox" ] || fail "$login INBOX holds $seen_inbox, the world says $inbox"

  seen_sent=$(printf '%s\n' "$result" | /bin/busybox awk '/^d OK/{p=1} p && /EXISTS/{n=$2} END{print n+0}')
  [ "$seen_sent" = "$sent" ] || fail "$login Sent holds $seen_sent, the world says $sent"

  seen_unread=$(printf '%s\n' "$result" \
    | /bin/busybox awk '/^\* SEARCH/{n=NF-2} END{print n<0?0:n}')
  [ "$seen_unread" = "$unread" ] || fail "$login has $seen_unread unseen, the world says $unread"

  for folder in $(cat "$world_dir/folders.txt"); do
    printf '%s\n' "$result" | tr -d '\r' | grep -qE "^\* LIST .*[\"/ ]$folder\$" \
      || fail "$login is missing the world folder $folder"
  done

  checked=$((checked + 1))
done < "$expected"
[ "$checked" -ge 2 ] || fail "fewer than two people were checked"
echo "IMAP: $checked world people logged in; INBOX and Sent counts match the world"

# --- a message one world person sent is readable by its world recipient -------

read_case=$(perl -MJSON::PP -e '
  open my $handle, "<", $ARGV[0] or die; binmode $handle; local $/; my $raw = <$handle>; close $handle;
  my $world = JSON::PP->new->utf8->decode($raw);
  my %person = map { $_->{id} => $_ } @{$world->{users}};
  for my $message (sort { $a->{id} cmp $b->{id} } @{$world->{messages}}) {
    next unless grep { $_ eq "SENT" } @{$message->{labels} // []};
    my $to = $message->{to_ids}[0];
    next if $to eq $message->{from_id};
    my $id = $message->{id}; $id =~ s/[^A-Za-z0-9._-]/-/g;
    my ($first) = split /\n/, ($message->{body_text} // "");
    printf "%s\t%s\t%s\t%s\n", lc($person{$to}{login}), $id,
      lc($person{$message->{from_id}}{email}), $first;
    last;
  }
' "$projection")
[ -n "$read_case" ] || fail "the world has no person-to-person message to read back"
recipient=$(printf '%s' "$read_case" | /bin/busybox cut -f1)
record=$(printf '%s' "$read_case" | /bin/busybox cut -f2)
author=$(printf '%s' "$read_case" | /bin/busybox cut -f3)
opening=$(printf '%s' "$read_case" | /bin/busybox cut -f4)
domain=$(cat "$world_dir/default-domain")
recipient_password=$(/bin/busybox awk -F'\t' -v login="$recipient" '$4 == login {print $5}' "$world_dir/accounts.tsv")

read_back=$(printf 'a LOGIN "%s" "%s"\r\nb SELECT INBOX\r\nc UID SEARCH HEADER Message-ID "<%s@%s>"\r\nd LOGOUT\r\n' \
  "$recipient" "$recipient_password" "$record" "$domain" | imap)
uid=$(printf '%s\n' "$read_back" | /bin/busybox sed -n 's/^\* SEARCH \([0-9][0-9]*\).*/\1/p' | head -n 1)
[ -n "$uid" ] || fail "$recipient cannot find the world message $record"
body=$(printf 'a LOGIN "%s" "%s"\r\nb SELECT INBOX\r\nc UID FETCH %s (BODY.PEEK[])\r\nd LOGOUT\r\n' \
  "$recipient" "$recipient_password" "$uid" | imap)
printf '%s\n' "$body" | grep -q "From:.*<$author>" || fail "$record is not from $author"
printf '%s\n' "$body" | grep -qF "$opening" || fail "$record does not carry the world's body text"
printf '%s\n' "$body" | grep -q '^Date: ' || fail "$record has no Date header"
printf '%s\n' "$body" | grep -q "^X-WorldFixture-Record: " || fail "$record lost its world record id"
echo "IMAP: $recipient read the message $author sent, with the world's own text"

# --- the Date is the world's, not the delivery clock --------------------------

world_date=$(perl -MJSON::PP -e '
  open my $handle, "<", $ARGV[0] or die; binmode $handle; local $/; my $raw = <$handle>; close $handle;
  my $world = JSON::PP->new->utf8->decode($raw);
  for my $message (@{$world->{messages}}) {
    next unless $message->{id} eq $ARGV[1];
    print substr($message->{sent_at}, 0, 4), "\n";
    last;
  }
' "$projection" "$record")
printf '%s\n' "$body" | grep -q "^Date: .* $world_date " \
  || fail "$record does not carry the year the world states ($world_date)"
echo "seeding: the Date header is the world's sent_at, not the delivery clock"

# --- SMTP submission reaching Cyrus through LMTP ------------------------------

sender_login=$(/bin/busybox awk -F'\t' 'NR == 1 {print $4}' "$world_dir/accounts.tsv")
target_login=$(/bin/busybox awk -F'\t' 'NR == 2 {print $4}' "$world_dir/accounts.tsv")
target_password=$(/bin/busybox awk -F'\t' 'NR == 2 {print $5}' "$world_dir/accounts.tsv")
[ "$sender_login" != "$target_login" ] || fail "two distinct world people are required"

subject="Protocol check $$"
message=$state/protocol-check.eml
{
  printf 'From: <%s>\n' "$sender_login"
  printf 'To: <%s>\n' "$target_login"
  printf 'Subject: %s\n' "$subject"
  printf '\nThe SMTP to LMTP check passed.\n'
} > "$message"
"$share/smtp-submit.pl" "$smtp_port" "$target_login" "$message" "$sender_login"

i=0
while :; do
  fetched=$(printf 'a LOGIN "%s" "%s"\r\nb SELECT INBOX\r\nc UID SEARCH HEADER Subject "%s"\r\nd LOGOUT\r\n' \
    "$target_login" "$target_password" "$subject" | imap)
  uid=$(printf '%s\n' "$fetched" | /bin/busybox sed -n 's/^\* SEARCH \([0-9][0-9]*\).*/\1/p')
  [ -n "$uid" ] && break
  i=$((i + 1))
  [ "$i" -lt 100 ] || fail "the SMTP message never reached Cyrus"
  sleep 0.1
done

result=$(
  {
    printf 'a LOGIN "%s" "%s"\r\n' "$target_login" "$target_password"
    printf 'b SELECT INBOX\r\n'
    printf 'c UID FETCH %s (UID BODY.PEEK[])\r\n' "$uid"
    printf 'd UID STORE %s +FLAGS (\\Seen)\r\n' "$uid"
    printf 'e CREATE Integration\r\n'
    printf 'f LIST "" "Integration"\r\n'
    printf 'g UID STORE %s +FLAGS (\\Deleted)\r\n' "$uid"
    printf 'h EXPUNGE\r\n'
    printf 'i DELETE Integration\r\n'
    printf 'j LOGOUT\r\n'
  } | imap
)
printf '%s\n' "$result" | grep -q "Subject: $subject" || fail "the SMTP message body was not readable"
printf '%s\n' "$result" | grep -q '\\Seen' || fail "the \\Seen flag did not stick"
printf '%s\n' "$result" | grep -q 'Integration' || fail "a folder could not be created"
printf '%s\n' "$result" | grep -q '^h OK' || fail "EXPUNGE failed"
echo "SMTP: $sender_login submitted to $target_login and Cyrus delivered it over LMTP"

# --- the mailbox page shows the world's people --------------------------------

mailbox_get() {
  printf 'GET %s HTTP/1.0\r\nHost: mailbox\r\n\r\n' "$1" \
    | /bin/busybox nc -w 15 127.0.0.1 "$mailbox_port"
}

first_name=$(/bin/busybox awk -F'\t' 'NR == 1 {print $7}' "$world_dir/accounts.tsv")
second_name=$(/bin/busybox awk -F'\t' 'NR == 2 {print $7}' "$world_dir/accounts.tsv")
page=$(mailbox_get "/?account=$(printf '%s' "$sender_login" | /bin/busybox sed 's/@/%40/')")
printf '%s\n' "$page" | grep -q 'Session mailbox' || fail "the mailbox page did not render"
printf '%s\n' "$page" | grep -qF "$first_name" || fail "the mailbox page is missing $first_name"
printf '%s\n' "$page" | grep -qF "$second_name" || fail "the mailbox page is missing $second_name"
echo "mailbox page: the world's people are the account tabs"

echo "mail protocol checks passed"
