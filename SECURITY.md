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
authenticating in a compiled world.

Not a vulnerability: a world's own synthetic credentials being readable in its
artifact, or the local services accepting them. That is what a world is.
