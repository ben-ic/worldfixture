#!/usr/bin/perl
# Turns one verified world mail projection into everything the mail fixture
# needs at runtime: accounts, folders, RFC 5322 messages, an LMTP delivery plan,
# and the read-state pass that follows delivery.
#
# Nothing here reads the wall clock. Every message header, every file name and
# every delivery is a function of the projection alone, so two runs of the same
# artifact seed the same mailboxes in the same order.
use strict;
use warnings;
use JSON::PP;
use MIME::Base64 qw(encode_base64);
use IO::Socket::INET;
use Time::Local qw(timegm);

my $max_projection_bytes = 8 * 1024 * 1024;
my @weekdays = qw(Sun Mon Tue Wed Thu Fri Sat);
my @months = qw(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec);

# The admin exists only so the seeding path can CREATE another user's mailbox.
# It is not a world person and never appears in the projection.
my $admin_user = "cyrus";
my $admin_password_ref = "mail-password:cyrus-admin";

sub bytes {
  my ($value) = @_;
  $value = "" unless defined $value;
  utf8::encode($value) if utf8::is_utf8($value);
  return $value;
}

sub read_file {
  my ($path) = @_;
  open my $handle, "<", $path or die "cannot read $path: $!\n";
  binmode $handle;
  local $/;
  my $content = <$handle>;
  close $handle;
  return $content;
}

sub write_file {
  my ($path, $content) = @_;
  open my $handle, ">", $path or die "cannot write $path: $!\n";
  binmode $handle;
  print {$handle} $content;
  close $handle;
}

sub load_projection {
  my ($world_path) = @_;
  my $path = "$world_path/projections/mail.json";
  my @stat = stat $path or die "mail projection is missing at $path\n";
  die "mail projection size is invalid\n" if $stat[7] < 2 || $stat[7] > $max_projection_bytes;
  my $value = JSON::PP->new->utf8->decode(read_file($path));
  die "mail projection users must be an array\n" unless ref $value->{users} eq "ARRAY";
  die "mail projection messages must be an array\n" unless ref $value->{messages} eq "ARRAY";
  return $value;
}

# The realm is the world's own domain. The world states it in `world.json`, as
# the domain of its primary organization. `mail.json` carries no domain field,
# so when the projection is used on its own the most common user domain stands
# in for it. Both answers come from the world; neither is a baked constant.
sub default_domain {
  my ($world_path, $projection) = @_;
  my $world_file = "$world_path/world.json";
  if (-f $world_file) {
    my $world = eval { JSON::PP->new->utf8->decode(read_file($world_file)) };
    if (ref($world) eq "HASH" && ref($world->{organizations}) eq "ARRAY") {
      for my $organization (@{$world->{organizations}}) {
        next unless ref $organization eq "HASH" && $organization->{primary};
        my $domain = bytes($organization->{domain});
        return $domain if $domain =~ /^[a-z0-9.-]+\.test$/;
      }
    }
  }
  my (%count, @order);
  for my $user (@{$projection->{users}}) {
    my $domain = lc((split /\@/, bytes($user->{email}), 2)[1] // "");
    next unless length $domain;
    push @order, $domain unless $count{$domain}++;
  }
  my ($best) = sort { $count{$b} <=> $count{$a} || $a cmp $b } @order;
  die "the world declares no mail domain\n" unless defined $best;
  return $best;
}

# The projection carries `password_ref` and never a secret. A file named by
# WORLDFIXTURE_MAIL_PASSWORDS resolves the reference when the environment owns
# real credentials. Without it the reference resolves to its own identifier, so
# a first run needs no setup. That default is a local fixture convention for a
# synthetic world inside the reserved `.test` domain. It is not a security
# mechanism and it is not a secret store.
sub password_resolver {
  my $path = $ENV{WORLDFIXTURE_MAIL_PASSWORDS};
  my $table = {};
  if (defined $path && length $path) {
    die "WORLDFIXTURE_MAIL_PASSWORDS is not readable: $path\n" unless -r $path;
    $table = JSON::PP->new->utf8->decode(read_file($path));
    die "WORLDFIXTURE_MAIL_PASSWORDS must hold a JSON object\n" unless ref $table eq "HASH";
  }
  return sub {
    my ($ref) = @_;
    $ref = bytes($ref);
    if (exists $table->{$ref}) {
      my $password = bytes($table->{$ref});
      die "password for $ref is empty\n" unless length $password;
      die "password for $ref contains a control character\n" if $password =~ /[\x00-\x20\x7f]/;
      return $password;
    }
    my $derived = $ref;
    $derived =~ s/^mail-password://;
    $derived =~ s/[^A-Za-z0-9._-]/-/g;
    die "cannot derive a password from $ref\n" unless length $derived;
    return $derived;
  };
}

sub accounts_from {
  my ($projection, $domain) = @_;
  my $resolve = password_resolver();
  my (@accounts, %seen_login);
  for my $user (@{$projection->{users}}) {
    my $id = bytes($user->{id});
    my $email = lc bytes($user->{email});
    my $login = lc bytes($user->{login} // $user->{email});
    my ($local, $user_domain) = $email =~ /^([^\@]+)\@(.+)$/;
    die "mail user $id has no usable address\n" unless defined $user_domain;
    die "mail user $id has an unsafe address\n"
      unless $local =~ /^[a-z0-9._-]+$/ && $user_domain =~ /^[a-z0-9.-]+$/;
    die "duplicate mail login: $login\n" if $seen_login{$login}++;
    my @folders = grep { $_ ne "INBOX" } map { bytes($_) } @{$user->{folders} // []};
    for my $folder (@folders) {
      die "mail user $id declares an unsafe folder name\n"
        unless $folder =~ /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
    }
    push @accounts, {
      id => $id,
      local => $local,
      domain => $user_domain,
      login => $login,
      password => $resolve->(bytes($user->{password_ref})),
      address => $email,
      name => bytes($user->{name}) || $email,
      folders => \@folders,
    };
  }
  die "the mail projection declares no users\n" unless @accounts;
  return @accounts;
}

sub mailbox_name {
  my ($account, $folder, $domain) = @_;
  my $name = "user/$account->{local}";
  $name .= "/$folder" unless $folder eq "INBOX";
  $name .= "\@$account->{domain}" unless $account->{domain} eq $domain;
  return $name;
}

sub rfc5322_date {
  my ($value) = @_;
  my ($year, $month, $day, $hour, $minute, $second) =
    bytes($value) =~ /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/
    or die "message sent_at is not an ISO 8601 instant: $value\n";
  my $epoch = timegm($second, $minute, $hour, $day, $month - 1, $year);
  my $weekday = (gmtime $epoch)[6];
  return sprintf "%s, %02d %s %04d %02d:%02d:%02d +0000",
    $weekdays[$weekday], $day, $months[$month - 1], $year, $hour, $minute, $second;
}

sub encode_header {
  my ($value) = @_;
  $value = bytes($value);
  $value =~ s/[\r\n]+/ /g;
  return $value unless $value =~ /[^\x20-\x7e]/;
  my $encoded = encode_base64($value, "");
  return "=?UTF-8?B?$encoded?=";
}

sub address_header {
  my ($name, $address) = @_;
  my $display = encode_header($name);
  return "<$address>" unless length $display;
  return $display =~ /^[A-Za-z0-9 .'-]+$/ ? "$display <$address>" : "\"$display\" <$address>";
}

sub message_id {
  my ($id, $domain) = @_;
  my $local = bytes($id);
  $local =~ s/[^A-Za-z0-9._-]/-/g;
  return "<$local\@$domain>";
}

sub build_message {
  my ($record, $accounts_by_id, $domain, $thread_history) = @_;
  my $sender = $accounts_by_id->{bytes($record->{from_id})}
    or die "message $record->{id} names an unknown sender\n";
  my @recipient_ids = map { bytes($_) } @{$record->{to_ids} // []};
  die "message $record->{id} has no recipient\n" unless @recipient_ids;
  my @recipients = map {
    $accounts_by_id->{$_} or die "message $record->{id} names an unknown recipient $_\n"
  } @recipient_ids;

  my $id = message_id($record->{id}, $domain);
  my @headers = (
    "Message-ID: $id",
    "Date: " . rfc5322_date($record->{sent_at}),
    "From: " . address_header($sender->{name}, $sender->{address}),
    "To: " . join(", ", map { address_header($_->{name}, $_->{address}) } @recipients),
    "Subject: " . encode_header($record->{subject}),
  );

  # A thread's later messages answer its first. Ordering is the seeding order,
  # which is the projection's own (sent_at, id) order, so the chain is stable.
  my $thread = bytes($record->{thread_id} // "");
  if (length $thread) {
    my $earlier = $thread_history->{$thread} ||= [];
    if (@$earlier) {
      push @headers, "In-Reply-To: " . $earlier->[-1];
      push @headers, "References: " . join(" ", @$earlier);
    }
    push @$earlier, $id;
  }

  push @headers,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "X-WorldFixture-Record: " . bytes($record->{id});
  my @labels = map { bytes($_) } @{$record->{labels} // []};
  push @headers, "X-WorldFixture-Labels: " . join(", ", @labels) if @labels;

  my $body = bytes($record->{body_text} // $record->{snippet} // "");
  $body =~ s/\r\n/\n/g;
  $body .= "\n" unless $body =~ /\n\z/;
  return {
    id => $id,
    text => join("\n", @headers) . "\n\n" . $body,
    sender => $sender,
    recipients => \@recipients,
    labels => \@labels,
  };
}

sub prepare {
  my ($world_path, $out_dir) = @_;
  my $projection = load_projection($world_path);
  my $domain = default_domain($world_path, $projection);
  my @accounts = accounts_from($projection, $domain);
  my %accounts_by_id = map { $_->{id} => $_ } @accounts;

  mkdir $out_dir;
  mkdir "$out_dir/messages";

  write_file("$out_dir/default-domain", "$domain\n");
  write_file("$out_dir/admin.tsv",
    join("\t", $admin_user, password_resolver()->($admin_password_ref)) . "\n");

  # One row per account: the fixture's own account table, replacing the three
  # names that used to be compiled into the image.
  write_file("$out_dir/accounts.tsv", join "", map {
    join("\t", $_->{id}, $_->{local}, $_->{domain}, $_->{login}, $_->{password},
      $_->{address}, $_->{name}, join(",", "INBOX", @{$_->{folders}})) . "\n"
  } @accounts);

  # Every mailbox the world declares, admin-created in a stable order. A folder
  # that is not INBOX is also given the `anyone p` right, because Cyrus files a
  # plus-addressed delivery into a subfolder only when that folder accepts a
  # post; without it every `local+Sent@domain` copy silently lands in INBOX.
  my (@mailboxes, %folder_union, @folder_order);
  for my $account (@accounts) {
    push @mailboxes, [mailbox_name($account, "INBOX", $domain), "inbox"];
    for my $folder (@{$account->{folders}}) {
      push @mailboxes, [mailbox_name($account, $folder, $domain), "folder"];
      push @folder_order, $folder unless $folder_union{$folder}++;
    }
  }
  write_file("$out_dir/mailboxes.tsv", join "", map { join("\t", @$_) . "\n" } @mailboxes);
  write_file("$out_dir/folders.txt", join "", map { "$_\n" } @folder_order);

  my @messages = sort {
    bytes($a->{sent_at}) cmp bytes($b->{sent_at}) || bytes($a->{id}) cmp bytes($b->{id})
  } @{$projection->{messages}};

  my (%thread_history, @delivery, @flags);
  my $index = 0;
  for my $record (@messages) {
    my $message = build_message($record, \%accounts_by_id, $domain, \%thread_history);
    $index += 1;
    my $file = sprintf "%s/messages/%04d.eml", $out_dir, $index;
    write_file($file, $message->{text});

    my $unread = grep { $_ eq "UNREAD" } @{$message->{labels}};
    for my $recipient (@{$message->{recipients}}) {
      push @delivery, [$message->{sender}{address}, $recipient->{address}, $file];
      push @flags, [$recipient->{login}, "INBOX", $message->{id}, $unread ? 0 : 1];
    }
    # A message the world says its sender sent is in that person's Sent folder.
    if (grep { $_ eq "SENT" } @{$message->{labels}}) {
      my $sender = $message->{sender};
      push @delivery, [
        $sender->{address},
        "$sender->{local}+Sent\@$sender->{domain}",
        $file,
      ];
      push @flags, [$sender->{login}, "Sent", $message->{id}, 1];
    }
  }

  write_file("$out_dir/delivery.tsv", join "", map { join("\t", @$_) . "\n" } @delivery);
  write_file("$out_dir/flags.tsv", join "", map { join("\t", @$_) . "\n" } @flags);
  printf "accounts %d mailboxes %d messages %d deliveries %d domain %s\n",
    scalar @accounts, scalar @mailboxes, scalar @messages, scalar @delivery, $domain;
}

sub imap_session {
  my ($port, $login, $password) = @_;
  my $socket = IO::Socket::INET->new(
    PeerAddr => "127.0.0.1", PeerPort => $port, Proto => "tcp", Timeout => 10,
  ) or die "cannot reach Cyrus IMAP on port $port: $!\n";
  $socket->autoflush(1);
  my $greeting = <$socket> // die "Cyrus IMAP closed the connection\n";
  die "Cyrus IMAP was not ready: $greeting" unless $greeting =~ /^\* OK/;
  my $session = {socket => $socket, tag => 0};
  command($session, "LOGIN " . quoted($login) . " " . quoted($password));
  return $session;
}

sub quoted {
  my ($value) = @_;
  $value =~ s/([\\"])/\\$1/g;
  return qq{"$value"};
}

sub command {
  my ($session, $line, $tolerate) = @_;
  $session->{tag} += 1;
  my $tag = "w$session->{tag}";
  my $socket = $session->{socket};
  print {$socket} "$tag $line\r\n";
  my $response = "";
  while (length $response < 4 * 1024 * 1024) {
    my $chunk = "";
    my $count = sysread($socket, $chunk, 65536);
    last unless $count;
    $response .= $chunk;
    last if $response =~ /^\Q$tag\E (?:OK|NO|BAD)/m;
  }
  return $response if $response =~ /^\Q$tag\E OK/m;
  return $response if $tolerate;
  my ($detail) = $response =~ /^\Q$tag\E (?:NO|BAD)([^\r\n]*)/m;
  die "IMAP $line failed:" . ($detail // " no response") . "\n";
}

sub create_mailboxes {
  my ($port, $out_dir) = @_;
  my ($admin, $admin_password) = split /\t/, (split /\n/, read_file("$out_dir/admin.tsv"))[0];
  my $session = imap_session($port, $admin, $admin_password);
  my $created = 0;
  my $posted = 0;
  for my $row (split /\n/, read_file("$out_dir/mailboxes.tsv")) {
    next unless length $row;
    my ($mailbox, $kind) = split /\t/, $row;
    # An existing mailbox is not an error: seeding has to be repeatable.
    my $response = command($session, "CREATE " . quoted($mailbox), 1);
    if ($response =~ /^w\d+ OK/m) {
      $created += 1;
    } else {
      die "CREATE $mailbox failed: $response\n" unless $response =~ /already exists/i;
    }
    next unless $kind eq "folder";
    command($session, "SETACL " . quoted($mailbox) . " anyone p");
    $posted += 1;
  }
  command($session, "LOGOUT", 1);
  print "created $created mailboxes, $posted folders accept local delivery\n";
}

# Read state comes from the projection: a message carrying the UNREAD label
# stays unseen, and every other seeded copy is \Seen. \Seen is per-user state in
# Cyrus, so each flag is set in that person's own session, not the admin's.
sub apply_flags {
  my ($port, $out_dir) = @_;
  my %password = map {
    my @field = split /\t/, $_;
    ($field[3] => $field[4])
  } grep { length } split /\n/, read_file("$out_dir/accounts.tsv");

  my (%plan, @order);
  for my $row (grep { length } split /\n/, read_file("$out_dir/flags.tsv")) {
    my ($login, $folder, $id, $seen) = split /\t/, $row;
    push @order, "$login\t$folder" unless $plan{"$login\t$folder"};
    push @{$plan{"$login\t$folder"}}, [$id, $seen];
  }

  my $marked = 0;
  my $unseen = 0;
  for my $key (@order) {
    my ($login, $folder) = split /\t/, $key;
    my $session = imap_session($port, $login, $password{$login}
      // die "no password for $login\n");
    command($session, "SELECT " . quoted($folder));
    command($session, "UID STORE 1:* +FLAGS.SILENT (\\Seen)", 1);
    for my $entry (@{$plan{$key}}) {
      my ($id, $seen) = @$entry;
      next if $seen;
      my $search = command($session, "UID SEARCH HEADER Message-ID " . quoted($id));
      my ($found) = $search =~ /^\* SEARCH([0-9 ]*)\r?$/m;
      my @uids = grep { length } split /\s+/, ($found // "");
      die "seeded message $id is missing from $login/$folder\n" unless @uids;
      command($session, "UID STORE " . join(",", @uids) . " -FLAGS.SILENT (\\Seen)");
      $unseen += scalar @uids;
    }
    $marked += 1;
    command($session, "LOGOUT", 1);
  }
  print "flagged $marked mailboxes, $unseen messages left unseen\n";
}

my $subcommand = shift @ARGV // "";
if ($subcommand eq "prepare") {
  my ($world_path, $out_dir) = @ARGV;
  die "usage: world-mail.pl prepare <world-path> <out-dir>\n"
    unless defined $world_path && defined $out_dir;
  prepare($world_path, $out_dir);
} elsif ($subcommand eq "mailboxes") {
  my ($port, $out_dir) = @ARGV;
  die "usage: world-mail.pl mailboxes <imap-port> <out-dir>\n"
    unless defined $port && defined $out_dir;
  create_mailboxes($port, $out_dir);
} elsif ($subcommand eq "flags") {
  my ($port, $out_dir) = @ARGV;
  die "usage: world-mail.pl flags <imap-port> <out-dir>\n"
    unless defined $port && defined $out_dir;
  apply_flags($port, $out_dir);
} else {
  die "usage: world-mail.pl <prepare|mailboxes|flags> ...\n";
}
