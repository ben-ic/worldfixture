# Security

WorldFixture runs a synthetic world on your own machine. Every person, message,
domain and credential in a shipped world is synthetic, and world addresses use
the reserved `.worldfixture.test` domain, so they cannot reach a real inbox.

Report a vulnerability privately through
[GitHub security advisories](https://github.com/ben-ic/worldfixture/security/advisories/new),
not a public issue. Tell us what you ran and what you saw. We will reply within
a week.

Most useful to hear about: the local token in `.worldfixture/token` reaching
somewhere it should not (command output, a log, an image layer, the browser), a
world's data leaving the machine, a service listening outside loopback when the
run did not ask for it, or an upstream emulator's sample credential
authenticating in a prepared world artifact.

Not a vulnerability: synthetic credentials being readable in a world artifact,
or local services accepting those credentials. Provider emulators are local
test services. Do not use their authentication as a security boundary. Some
documented routes do not enforce production authentication. See the provider
support pages for the exact behavior.
