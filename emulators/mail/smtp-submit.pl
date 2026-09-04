#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::INET;

my ($port, $recipient, $message_path, $sender) = @ARGV;
die "usage: smtp-submit.pl <port> <recipient> <message.eml> [sender]\n"
  unless defined $port && defined $recipient && defined $message_path;
$sender = "seed\@localhost" unless defined $sender && length $sender;
$SIG{ALRM} = sub { die "SMTP request timed out\n" };
alarm 15;

my $socket = IO::Socket::INET->new(
  PeerAddr => "127.0.0.1",
  PeerPort => $port,
  Proto => "tcp",
  Timeout => 5,
) or die "SMTP connect failed: $!\n";
$socket->autoflush(1);

sub response {
  my ($expected) = @_;
  while (my $line = <$socket>) {
    $line =~ /^(\d{3})([ -])/ or next;
    my ($code, $separator) = ($1, $2);
    next if $separator eq "-";
    die "SMTP rejected the request: $line" unless int($code / 100) == $expected;
    return;
  }
  die "SMTP closed before its response\n";
}

sub command {
  my ($line, $expected) = @_;
  print {$socket} "$line\r\n";
  response($expected);
}

response(2);
command("EHLO worldfixture-mail", 2);
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
