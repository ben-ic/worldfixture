#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::UNIX;
use Socket qw(SOCK_STREAM);

my ($socket_path, $recipient, $message_path, $sender) = @ARGV;
die "usage: lmtp-submit.pl <socket> <recipient> <message.eml> [sender]\n"
  unless defined $socket_path && defined $recipient && defined $message_path;
# The envelope sender is the world person who sent the record. Seeding no longer
# has one fixed support address to speak for.
$sender = "seed\@localhost" unless defined $sender && length $sender;
$SIG{ALRM} = sub { die "LMTP request timed out\n" };
alarm 15;

my $socket = IO::Socket::UNIX->new(
  Type => SOCK_STREAM,
  Peer => $socket_path,
) or die "LMTP connect failed: $!\n";
$socket->autoflush(1);

sub response {
  my ($expected) = @_;
  while (my $line = <$socket>) {
    $line =~ /^(\d{3})([ -])/ or next;
    my ($code, $separator) = ($1, $2);
    next if $separator eq "-";
    die "LMTP rejected the request: $line" unless int($code / 100) == $expected;
    return;
  }
  die "LMTP closed before its response\n";
}

sub command {
  my ($line, $expected) = @_;
  print {$socket} "$line\r\n";
  response($expected);
}

response(2);
command("LHLO worldfixture-mail", 2);
command("MAIL FROM:<$sender>", 2);
command("RCPT TO:<$recipient>", 2);
command("DATA", 3);

open my $message, "<", $message_path or die "cannot read $message_path: $!\n";
while (my $line = <$message>) {
  $line =~ s/\r?\n\z//;
  $line = ".$line" if $line =~ /^\./;
  print {$socket} "$line\r\n";
}
close $message;

print {$socket} ".\r\n";
response(2);
command("QUIT", 2);
close $socket;
alarm 0;
