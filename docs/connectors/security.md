# Connector security

A connector can create and remove application data. Treat it as a local
development control interface.

WorldFixture binds host services and publishes Docker host ports on
`127.0.0.1`. This applies to normal `up` and checkout `up --direct`. Neither
command enables LAN publication. Read the allocated ports from `worldfixture
env`; the port numbers can change between runs.

Inside a container, application listeners must accept connections through the
container network interface for Docker forwarding to work. These listeners can
be reached by other containers on the same Docker network. Keep untrusted
containers off that network. Host loopback publication does not authenticate
Workbench requests or isolate services within the container network.

On Linux, Docker port forwarding can bypass ordinary `ufw` rules. Always name
the loopback address in manual `-p` mappings. Docker versions before 28.0.0 also
have a documented limit on localhost publication isolation. See
[Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)
and [Docker and ufw](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw).

An implementation must:

- be disabled in production;
- be disabled when neither `WORLDFIXTURE_TOKEN` nor the development-only local
  token file is available;
- compare the full bearer token without logging it;
- require the token for plan, seed, event, status, and any supported reset;
- keep discovery limited to public capability metadata;
- reject a request body that exceeds its documented local limit;
- validate every request before it changes state;
- use transactions when the application data layer supports them;
- declare connector reset unavailable for an app-owned database;
- never return database credentials, session cookies, or application secrets.

The Workbench sends connector calls through the local WorldFixture runtime. The
browser must not receive `WORLDFIXTURE_TOKEN`.

When WorldFixture runs from an app directory, it writes
`.worldfixture/token`, makes it owner-readable only, and excludes it from Git
and Docker build context. The connector can read this file only in development.
An environment value can override the file for containers and other runtimes.
WorldFixture never writes the token to `.env`, `.env.example`, command output,
or browser state.

A coding agent must implement runtime token loading without inspecting the real
token file. It must use a separate dummy token in connector tests.

Do not enable the connector from a general `DEBUG` flag. Require an explicit
WorldFixture development setting and a non-empty token.
