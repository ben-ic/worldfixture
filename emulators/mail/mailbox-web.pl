#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::INET;
use MIME::Base64 qw(decode_base64);

my ($listen_host, $listen_port, $imap_port, $smtp_port, $world_dir) = @ARGV;
die "usage: mailbox-web.pl <host> <port> <imap-port> <smtp-port> <world-dir>\n"
  unless defined $world_dir;

# The account tabs, the folder list, the realm and the admin credential all come
# from the world the entry point prepared. None of them is compiled in.
sub read_lines {
  my ($path) = @_;
  open my $handle, "<", $path or die "cannot read $path: $!\n";
  binmode $handle;
  my @lines = <$handle>;
  close $handle;
  chomp @lines;
  return grep { length } @lines;
}

my ($default_domain) = read_lines("$world_dir/default-domain");
my ($admin_login, $admin_password) = split /\t/, (read_lines("$world_dir/admin.tsv"))[0];
my @folders = ("INBOX", read_lines("$world_dir/folders.txt"));
my %accounts;
my @account_order;
for my $row (read_lines("$world_dir/accounts.tsv")) {
  my ($id, $local, $domain, $login, $password, $address, $name) = split /\t/, $row;
  $accounts{$address} = {password => $password, address => $address, label => $name};
  push @account_order, $address;
}
die "the world prepared no mail accounts\n" unless @account_order;
my $default_account = $account_order[0];

my $server = IO::Socket::INET->new(
  LocalAddr => $listen_host,
  LocalPort => $listen_port,
  Proto => "tcp",
  Listen => 16,
  ReuseAddr => 1,
) or die "mailbox web listen failed: $!\n";

$SIG{PIPE} = "IGNORE";
$SIG{CHLD} = "IGNORE";

sub escape_html {
  my ($value) = @_;
  $value = "" unless defined $value;
  $value =~ s/&/&amp;/g;
  $value =~ s/</&lt;/g;
  $value =~ s/>/&gt;/g;
  $value =~ s/"/&quot;/g;
  $value =~ s/'/&#39;/g;
  $value =~ s/\@/&#64;/g;
  return $value;
}

sub short_url {
  my ($value) = @_;
  return $value if length($value) <= 88;
  return substr($value, 0, 72) . "...";
}

sub render_message_text {
  my ($value) = @_;
  my @parts = split /(https?:\/\/[^\s<>"']+)/, ($value // "");
  return join "", map {
    /^https?:\/\//
      ? '<a href="' . escape_html($_) . '" title="' . escape_html($_) . '">' . escape_html(short_url($_)) . '</a>'
      : escape_html($_)
  } @parts;
}

sub url_decode {
  my ($value) = @_;
  $value //= "";
  $value =~ tr/+/ /;
  $value =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/eg;
  return $value;
}

sub url_encode {
  my ($value) = @_;
  $value //= "";
  $value =~ s/([^A-Za-z0-9_.~-])/sprintf("%%%02X", ord($1))/eg;
  return $value;
}

sub parse_form {
  my ($raw) = @_;
  my %form;
  for my $pair (split /&/, ($raw // "")) {
    my ($key, $value) = split /=/, $pair, 2;
    $form{url_decode($key)} = url_decode($value);
  }
  return %form;
}

sub imap_quote {
  my ($value) = @_;
  $value =~ s/([\\"])/\\$1/g;
  return qq{"$value"};
}

sub imap_exchange {
  my (@commands) = @_;
  my $socket = IO::Socket::INET->new(
    PeerAddr => "127.0.0.1", PeerPort => $imap_port, Proto => "tcp", Timeout => 5,
  ) or die "Cannot connect to Cyrus IMAP\n";
  $socket->autoflush(1);
  my $greeting = <$socket> // die "Cyrus IMAP closed the connection\n";
  die "Cyrus IMAP was not ready\n" unless $greeting =~ /^\* OK/;

  my $read_result = sub {
    my ($tag) = @_;
    my $result = "";
    while (length($result) < 12 * 1024 * 1024) {
      my $chunk = "";
      my $count = sysread($socket, $chunk, 65536);
      last unless $count;
      $result .= $chunk;
      last if $result =~ /^\Q$tag\E (?:OK|NO|BAD).*\r?$/m;
    }
    return $result;
  };

  print {$socket} "a LOGIN ", imap_quote($admin_login), " ", imap_quote($admin_password), "\r\n";
  my $response = $read_result->("a");
  die "IMAP login failed\n" unless $response =~ /^a OK/m;

  for my $index (0 .. $#commands) {
    my $tag = chr(ord("b") + $index);
    print {$socket} "$tag $commands[$index]\r\n";
    my $result = $read_result->($tag);
    $response .= $result;
    unless ($result =~ /^\Q$tag\E OK/m) {
      my ($status, $detail) = $result =~ /^\Q$tag\E (OK|NO|BAD)([^\r\n]*)/m;
      close $socket;
      die "IMAP request failed" . (defined $status ? ": $status$detail" : "") . "\n";
    }
  }
  close $socket;
  return $response;
}

sub mailbox_name {
  my ($account, $folder) = @_;
  my $address = $accounts{$account}{address};
  my ($local, $domain) = $address =~ /^([^\@]+)\@(.+)$/;
  die "Invalid mailbox address\n" unless defined $domain;
  my $name = "user/$local";
  $name .= "/$folder" unless $folder eq "INBOX";
  $name .= "\@$domain" unless $domain eq $default_domain;
  return $name;
}

sub discover_accounts {
  my $response = imap_exchange('LIST "" "user/%"');
  while ($response =~ /^\* LIST \(([^)]*)\) "[^"]*" (?:"((?:\\.|[^"])*)"|([^\r\n ]+))/mg) {
    my $flags = $1;
    # A \Noselect entry is the placeholder Cyrus reports for the parent of a
    # mailbox in another domain. It is not an account.
    next if $flags =~ /\\Noselect/i;
    my $mailbox = defined $2 ? $2 : $3;
    $mailbox =~ s/\\([\\"])/$1/g;
    next unless $mailbox =~ m{^user/([^/]+)$};
    my $identity = $1;
    my $address = $identity =~ /\@/ ? $identity : "$identity\@$default_domain";
    $accounts{$address} //= {address => $address, label => $address};
  }
}

sub literal_from {
  my ($response) = @_;
  return undef unless $response =~ /\{(\d+)\}\r\n/s;
  my $length = $1;
  my $start = $+[0];
  return substr($response, $start, $length);
}

sub split_message {
  my ($raw) = @_;
  my ($head, $body) = split /\r?\n\r?\n/, ($raw // ""), 2;
  return ($head // "", $body // "");
}

sub headers_from {
  my ($head) = @_;
  $head =~ s/\r?\n[ \t]+/ /g;
  my %headers;
  for my $line (split /\r?\n/, $head) {
    next unless $line =~ /^([^:]+):\s*(.*)$/;
    my $name = lc $1;
    $headers{$name} = $2 unless exists $headers{$name};
  }
  return %headers;
}

sub decode_quoted_printable {
  my ($value) = @_;
  $value =~ s/=\r?\n//g;
  $value =~ s/=([0-9A-Fa-f]{2})/chr(hex($1))/eg;
  return $value;
}

sub html_to_text {
  my ($value) = @_;
  $value =~ s/<(?:script|style)\b[^>]*>.*?<\/(?:script|style)>//gis;
  $value =~ s/<br\s*\/?>/\n/gi;
  $value =~ s/<\/p\s*>/\n\n/gi;
  $value =~ s/<[^>]+>//g;
  $value =~ s/&nbsp;/ /gi;
  $value =~ s/&lt;/</gi;
  $value =~ s/&gt;/>/gi;
  $value =~ s/&quot;/"/gi;
  $value =~ s/&#39;/'/gi;
  $value =~ s/&amp;/&/gi;
  return $value;
}

sub message_text {
  my ($raw) = @_;
  my ($head, $body) = split_message($raw);
  my %headers = headers_from($head);
  my $type = $headers{"content-type"} // "text/plain";
  if ($type =~ /boundary=(?:"([^"]+)"|([^;\s]+))/i) {
    my $boundary = defined $1 ? $1 : $2;
    my @parts = grep { $_ !~ /^\s*--\s*$/ && $_ =~ /\S/ } split /--\Q$boundary\E(?:--)?\r?\n/, $body;
    my ($plain) = grep { /content-type:\s*text\/plain/i } @parts;
    my ($html) = grep { /content-type:\s*text\/html/i } @parts;
    return message_text(defined $plain ? $plain : defined $html ? $html : ($parts[0] // ""));
  }
  my $encoding = $headers{"content-transfer-encoding"} // "";
  $body = decode_base64($body) if $encoding =~ /base64/i;
  $body = decode_quoted_printable($body) if $encoding =~ /quoted-printable/i;
  $body = html_to_text($body) if $type =~ /text\/html/i;
  $body =~ s/\r//g;
  $body =~ s/^\s+|\s+$//g;
  return $body;
}

sub parse_message {
  my ($uid, $raw, $flags) = @_;
  my ($head) = split_message($raw);
  my %headers = headers_from($head);
  my $text = message_text($raw);
  my $preview = $text;
  $preview =~ s/\s+/ /g;
  $preview = substr($preview, 0, 180);
  return {
    uid => $uid,
    from => $headers{from} // "Unknown sender",
    to => $headers{to} // "",
    subject => $headers{subject} // "(no subject)",
    date => $headers{date} // "",
    text => $text,
    preview => $preview,
    seen => ($flags // "") =~ /\\Seen/ ? 1 : 0,
  };
}

sub list_messages {
  my ($account, $folder) = @_;
  my $mailbox = mailbox_name($account, $folder);
  my $search = imap_exchange(
    "SETACL " . imap_quote($mailbox) . " cyrus lrswipkxtecdan",
    "SELECT " . imap_quote($mailbox),
    "UID SEARCH ALL");
  my ($found) = $search =~ /^\* SEARCH(?: ([0-9 ]+))?\r?$/m;
  my @uids = defined $found && $found =~ /\S/ ? split(/\s+/, $found) : ();
  @uids = reverse @uids;
  splice @uids, 50 if @uids > 50;
  my @messages;
  for my $uid (@uids) {
    my $response = imap_exchange(
      "SELECT " . imap_quote($mailbox), "UID FETCH $uid (UID FLAGS BODY.PEEK[])");
    my $raw = literal_from($response);
    next unless defined $raw;
    my ($flags) = $response =~ /FLAGS \(([^)]*)\)/;
    push @messages, parse_message($uid, $raw, $flags);
  }
  return @messages;
}

sub read_message {
  my ($account, $folder, $uid) = @_;
  die "Invalid message id\n" unless $uid =~ /^\d+$/;
  my $mailbox = mailbox_name($account, $folder);
  my $response = imap_exchange(
    "SETACL " . imap_quote($mailbox) . " cyrus lrswipkxtecdan",
    "SELECT " . imap_quote($mailbox),
    "UID FETCH $uid (UID FLAGS BODY.PEEK[])",
    "UID STORE $uid +FLAGS (\\Seen)");
  my $raw = literal_from($response);
  die "Message was not found\n" unless defined $raw;
  return parse_message($uid, $raw, "\\Seen");
}

sub delete_message {
  my ($account, $folder, $uid) = @_;
  die "Invalid message id\n" unless $uid =~ /^\d+$/;
  my $mailbox = mailbox_name($account, $folder);
  imap_exchange(
    "SETACL " . imap_quote($mailbox) . " cyrus lrswipkxtecdan",
    "SELECT " . imap_quote($mailbox),
    "UID STORE $uid +FLAGS (\\Deleted)",
    "EXPUNGE");
}

sub smtp_response {
  my ($socket, $wanted) = @_;
  while (my $line = <$socket>) {
    next unless $line =~ /^(\d{3})([ -])/;
    next if $2 eq "-";
    die "SMTP rejected the message\n" unless int($1 / 100) == $wanted;
    return;
  }
  die "SMTP closed the connection\n";
}

sub send_mail {
  my ($from, $to, $subject, $body) = @_;
  die "Invalid From address\n" unless $from =~ /^[^<>\s\@]+\@[^<>\s\@]+$/ && $from !~ /[\r\n]/;
  die "Invalid To address\n" unless $to =~ /^[^<>\s\@]+\@[^<>\s\@]+$/ && $to !~ /[\r\n]/;
  die "Invalid subject\n" if $subject =~ /[\r\n]/;
  die "Message is too large\n" if length($body) > 256 * 1024;
  my $socket = IO::Socket::INET->new(
    PeerAddr => "127.0.0.1", PeerPort => $smtp_port, Proto => "tcp", Timeout => 5,
  ) or die "Cannot connect to session SMTP\n";
  $socket->autoflush(1);
  smtp_response($socket, 2);
  for my $command (["EHLO mailbox.$default_domain", 2], ["MAIL FROM:<$from>", 2],
    ["RCPT TO:<$to>", 2], ["DATA", 3]) {
    print {$socket} $command->[0], "\r\n";
    smtp_response($socket, $command->[1]);
  }
  $body =~ s/(^|\r?\n)\./$1../g;
  print {$socket} "From: $from\r\nTo: $to\r\nSubject: $subject\r\n",
    "Content-Type: text/plain; charset=utf-8\r\n\r\n$body\r\n.\r\n";
  smtp_response($socket, 2);
  print {$socket} "QUIT\r\n";
  smtp_response($socket, 2);
  close $socket;
}

sub page {
  my ($account, $folder, $selected, $notice, $error) = @_;
  my $account_query = "account=" . url_encode($account);
  my $folder_query = "folder=" . url_encode($folder);
  my $tabs = join "", map {
    my $class = $_ eq $account ? "account active" : "account";
    '<a class="' . $class . '" href="/?account=' . url_encode($_) . '">' . escape_html($accounts{$_}{label}) . '</a>'
  } sort { $accounts{$a}{label} cmp $accounts{$b}{label} } keys %accounts;
  my $folder_links = join "", map {
    my $class = $_ eq $folder ? "folder active" : "folder";
    '<a class="' . $class . '" href="/?' . $account_query . '&folder=' . url_encode($_) . '">' . escape_html($_) . '</a>'
  } @folders;
  my @messages = list_messages($account, $folder);
  my $rows = join "", map {
    my $message = $_;
    my $class = $message->{seen} ? "message" : "message unread";
    '<a class="' . $class . '" href="/message?' . $account_query . '&' . $folder_query . '&uid=' . $message->{uid} . '">' .
    '<div class="message-top"><strong>' . escape_html($message->{from}) . '</strong><time>' . escape_html($message->{date}) . '</time></div>' .
    '<div class="subject">' . escape_html($message->{subject}) . '</div><div class="preview">' . escape_html($message->{preview}) . '</div></a>'
  } @messages;
  $rows = '<div class="empty">This folder is empty.</div>' unless length $rows;
  my $detail = "";
  if ($selected) {
    $detail = '<section class="detail"><a class="back" href="/?' . $account_query . '&' . $folder_query . '">← Back to ' . escape_html($folder) . '</a>' .
      '<h2>' . escape_html($selected->{subject}) . '</h2><div class="meta"><b>From</b> ' . escape_html($selected->{from}) .
      '<br><b>To</b> ' . escape_html($selected->{to}) . '<br><span>' . escape_html($selected->{date}) . '</span></div>' .
      '<pre class="body">' . render_message_text($selected->{text}) . '</pre>' .
      '<form method="post" action="/delete"><input type="hidden" name="account" value="' . escape_html($account) . '">' .
      '<input type="hidden" name="folder" value="' . escape_html($folder) . '"><input type="hidden" name="uid" value="' . escape_html($selected->{uid}) . '">' .
      '<button class="danger" type="submit">Delete message</button></form></section>';
  }
  my $address = $accounts{$account}{address};
  my $banner = $notice ? '<div class="notice ok">' . escape_html($notice) . '</div>' : "";
  $banner .= '<div class="notice error">' . escape_html($error) . '</div>' if $error;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' .
    '<title>Session mailbox</title><style>' .
    '*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#172033;font:15px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' .
    'a{color:inherit;text-decoration:none}header{background:#172033;color:white;padding:22px max(22px,calc((100% - 1180px)/2))}header h1{margin:0;font-size:24px}header p{margin:5px 0 0;color:#bac4d6}' .
    '.accounts{display:flex;gap:8px;margin-top:18px}.account{padding:7px 12px;border:1px solid #536078;border-radius:999px}.account.active{background:#fff;color:#172033}' .
    '.shell{max-width:1180px;margin:24px auto;padding:0 20px;display:grid;grid-template-columns:170px minmax(0,1fr);gap:20px}.sidebar,.panel,.compose,.detail{background:white;border:1px solid #dce1e8;border-radius:13px;box-shadow:0 2px 10px #1720330d}' .
    '.sidebar{padding:10px;height:max-content}.folder{display:block;padding:10px 12px;border-radius:8px}.folder.active{background:#e9eef8;color:#174ea6;font-weight:700}' .
    '.main{min-width:0}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #e5e8ed}.panel-head h2{margin:0}.count{color:#697386}' .
    '.message{display:block;padding:14px 20px;border-bottom:1px solid #edf0f3}.message:last-child{border-bottom:0}.message:hover{background:#f8faff}.message.unread{border-left:4px solid #2767c5;padding-left:16px}' .
    '.message-top{display:flex;gap:15px;justify-content:space-between}.message-top time,.preview,.meta{color:#697386}.subject{margin-top:3px}.preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}' .
    '.compose,.detail{margin-top:20px;padding:20px}.compose h2,.detail h2{margin-top:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:block;font-size:13px;font-weight:700;margin-bottom:4px}' .
    'input,textarea{width:100%;border:1px solid #cbd2dc;border-radius:8px;padding:10px 11px;font:inherit;background:white}textarea{min-height:150px;resize:vertical}.wide{grid-column:1/-1}' .
    'button{border:0;border-radius:8px;background:#2767c5;color:white;padding:10px 16px;font:700 14px inherit;cursor:pointer}.danger{background:#b42318}.body{white-space:pre-wrap;font:15px/1.6 inherit;background:#f7f8fa;padding:18px;border-radius:9px;margin:18px 0}.body a,.back{color:#2767c5;text-decoration:underline}.notice{max-width:1180px;margin:18px auto -6px;padding:11px 18px;border-radius:9px}.notice.ok{background:#e6f6ed;color:#166534}.notice.error{background:#fdecec;color:#991b1b}.empty{padding:35px;text-align:center;color:#697386}' .
    '.connection{font-size:13px;color:#697386;margin-top:16px}@media(max-width:720px){.shell{grid-template-columns:1fr}.sidebar{display:flex;overflow:auto}.folder{white-space:nowrap}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.message-top{display:block}.message-top time{display:block}.accounts{overflow:auto}}' .
    '</style></head><body><header><h1>Session mailbox</h1><p>Cyrus is the only mailbox authority. Every account and message comes from the world.</p><nav class="accounts">' . $tabs . '</nav></header>' .
    $banner . '<main class="shell"><nav class="sidebar">' . $folder_links . '</nav><div class="main">' . $detail .
    '<section class="panel"><div class="panel-head"><h2>' . escape_html($folder) . '</h2><span class="count">' . scalar(@messages) . ' messages</span></div>' . $rows . '</section>' .
    '<section class="compose"><h2>Compose</h2><form method="post" action="/send" class="grid">' .
    '<input type="hidden" name="account" value="' . escape_html($account) . '"><input type="hidden" name="folder" value="' . escape_html($folder) . '">' .
    '<div><label>From</label><input name="from" value="' . escape_html($address) . '" required></div><div><label>To</label><input name="to" value="' . escape_html($default_account) . '" required></div>' .
    '<div class="wide"><label>Subject</label><input name="subject" value="Hello from this world" required></div><div class="wide"><label>Plain-text message</label><textarea name="body" required>Sent through the fixture SMTP service.</textarea></div>' .
    '<div class="wide"><button type="submit">Send message</button></div></form><p class="connection">IMAP 127.0.0.1:' . escape_html($imap_port) . ' · SMTP 127.0.0.1:' . escape_html($smtp_port) . ' · no external relay</p></section></div></main></body></html>';
}

sub respond {
  my ($client, $status, $type, $body, $extra) = @_;
  $extra //= "";
  print {$client} "HTTP/1.1 $status\r\nContent-Type: $type\r\nContent-Length: ", length($body),
    "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\r\n$extra\r\n$body";
}

sub handle_client {
  my ($client) = @_;
  $client->autoflush(1);
  my $request = <$client> // return;
  return unless $request =~ /^(GET|POST) ([^ ]+) HTTP\/1\.[01]\r?$/;
  my ($method, $target) = ($1, $2);
  my %headers;
  while (my $line = <$client>) {
    last if $line =~ /^\r?$/;
    $headers{lc $1} = $2 if $line =~ /^([^:]+):\s*(.*?)\r?$/;
  }
  my $body = "";
  my $length = int($headers{"content-length"} // 0);
  die "Request is too large\n" if $length > 512 * 1024;
  read($client, $body, $length) if $length;
  my ($path, $query) = split /\?/, $target, 2;
  my %params = parse_form($query);
  my %form = $method eq "POST" ? parse_form($body) : ();
  discover_accounts();
  my $account = $form{account} // $params{account} // $default_account;
  $account = "$account\@$default_domain" if !exists $accounts{$account} && $account !~ /\@/;
  $account = $default_account unless exists $accounts{$account};
  my $folder = $form{folder} // $params{folder} // "INBOX";
  $folder = "INBOX" unless grep { $_ eq $folder } @folders;

  if ($method eq "GET" && $path eq "/readyz") {
    return respond($client, "200 OK", "text/plain; charset=utf-8", "ok\n");
  }
  if ($method eq "POST" && $path eq "/send") {
    send_mail($form{from} // "", $form{to} // "", $form{subject} // "", $form{body} // "");
    return respond($client, "303 See Other", "text/plain", "sent\n",
      "Location: /?account=" . url_encode($account) . "&folder=" . url_encode($folder) . "&sent=1\r\n");
  }
  if ($method eq "POST" && $path eq "/delete") {
    delete_message($account, $folder, $form{uid} // "");
    return respond($client, "303 See Other", "text/plain", "deleted\n",
      "Location: /?account=" . url_encode($account) . "&folder=" . url_encode($folder) . "&deleted=1\r\n");
  }
  my $selected;
  $selected = read_message($account, $folder, $params{uid} // "") if $method eq "GET" && $path eq "/message";
  if ($method eq "GET" && ($path eq "/" || $path eq "/message")) {
    my $notice = $params{sent} ? "Message accepted through session SMTP and delivered to Cyrus." :
      $params{deleted} ? "Message deleted from Cyrus." : "";
    return respond($client, "200 OK", "text/html; charset=utf-8", page($account, $folder, $selected, $notice, ""));
  }
  respond($client, "404 Not Found", "text/plain; charset=utf-8", "not found\n");
}

while (my $client = $server->accept()) {
  eval {
    local $SIG{ALRM} = sub { die "Request timed out\n" };
    alarm 20;
    handle_client($client);
    alarm 0;
  };
  if ($@) {
    my $error = $@;
    eval { respond($client, "500 Internal Server Error", "text/plain; charset=utf-8", "Mailbox request failed.\n") };
    warn $error;
  }
  close $client;
}
