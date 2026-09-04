#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::INET;
use IO::Socket::UNIX;
use Socket qw(SOCK_STREAM);

my ($host, $port, $lmtp_socket, $domain) = @ARGV;
die "usage: smtp-server.pl <host> <port> <lmtp-socket> <domain>\n"
  unless defined $host && defined $port && defined $lmtp_socket && defined $domain;
die "SMTP domain is invalid\n" unless $domain =~ /^[A-Za-z0-9.-]+$/;
my $banner = "smtp.$domain";

my $server = IO::Socket::INET->new(
  LocalAddr => $host,
  LocalPort => $port,
  Proto => "tcp",
  Listen => 32,
  ReuseAddr => 1,
) or die "SMTP listen failed: $!\n";

$SIG{PIPE} = "IGNORE";
$SIG{CHLD} = "IGNORE";

sub lmtp_response {
  my ($socket, $wanted) = @_;
  while (my $line = <$socket>) {
    next unless $line =~ /^(\d{3})([ -])/;
    next if $2 eq "-";
    return int($1 / 100) == $wanted;
  }
  return 0;
}

sub deliver {
  my ($sender, $recipient, $message) = @_;
  my $socket = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $lmtp_socket)
    or return 0;
  $socket->autoflush(1);
  return 0 unless lmtp_response($socket, 2);
  for my $step (
    ["LHLO $banner", 2],
    ["MAIL FROM:<$sender>", 2],
    ["RCPT TO:<$recipient>", 2],
    ["DATA", 3],
  ) {
    print {$socket} "$step->[0]\r\n";
    return 0 unless lmtp_response($socket, $step->[1]);
  }
  for my $line (split /\r?\n/, $message, -1) {
    $line = ".$line" if $line =~ /^\./;
    print {$socket} "$line\r\n";
  }
  print {$socket} ".\r\n";
  my $ok = lmtp_response($socket, 2);
  print {$socket} "QUIT\r\n";
  close $socket;
  return $ok;
}

sub address_from {
  my ($line) = @_;
  return undef unless $line =~ /<([^<>\s]+\@[^<>\s]+)>/;
  return $1;
}

sub session {
  my ($client) = @_;
  $client->autoflush(1);
  print {$client} "220 $banner ESMTP WorldFixture session mail\r\n";
  my $sender = "";
  my @recipients;
  while (my $line = <$client>) {
    $line =~ s/\r?\n\z//;
    if ($line =~ /^(?:EHLO|HELO)\b/i) {
      print {$client} "250-$banner\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n";
    } elsif ($line =~ /^MAIL FROM:/i) {
      my $address = address_from($line);
      if (defined $address) {
        $sender = $address;
        @recipients = ();
        print {$client} "250 Sender accepted\r\n";
      } else {
        print {$client} "501 Invalid sender\r\n";
      }
    } elsif ($line =~ /^RCPT TO:/i) {
      my $address = address_from($line);
      if ($sender ne "" && defined $address && @recipients < 100) {
        push @recipients, $address;
        print {$client} "250 Recipient accepted\r\n";
      } else {
        print {$client} "503 Sender required or recipient limit reached\r\n";
      }
    } elsif ($line =~ /^DATA$/i) {
      if ($sender eq "" || !@recipients) {
        print {$client} "503 Sender and recipient required\r\n";
        next;
      }
      print {$client} "354 End data with <CR><LF>.<CR><LF>\r\n";
      my $message = "";
      my $too_large = 0;
      my $complete = 0;
      while (my $data = <$client>) {
        if ($data =~ /^\.\r?\n$/) {
          $complete = 1;
          last;
        }
        $data =~ s/^\.\././;
        $too_large = 1 if length($message) + length($data) > 10 * 1024 * 1024;
        $message .= $data unless $too_large;
      }
      my $ok = $complete && !$too_large;
      if ($ok) {
        for my $recipient (@recipients) {
          $ok = 0 unless deliver($sender, $recipient, $message);
        }
      }
      print {$client} $ok ? "250 Message delivered\r\n" : "451 Session delivery failed\r\n";
      $sender = "";
      @recipients = ();
    } elsif ($line =~ /^RSET$/i) {
      $sender = "";
      @recipients = ();
      print {$client} "250 Reset\r\n";
    } elsif ($line =~ /^NOOP$/i) {
      print {$client} "250 OK\r\n";
    } elsif ($line =~ /^QUIT$/i) {
      print {$client} "221 Bye\r\n";
      last;
    } else {
      print {$client} "502 Command not supported\r\n";
    }
  }
}

while (my $client = $server->accept()) {
  my $pid = fork();
  if (!defined $pid) {
    close $client;
    next;
  }
  if ($pid == 0) {
    close $server;
    eval {
      local $SIG{ALRM} = sub { die "SMTP session timed out\n" };
      alarm 30;
      session($client);
      alarm 0;
    };
    close $client;
    exit 0;
  }
  close $client;
}
