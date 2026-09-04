# Connector security

A connector can create and remove application data. Treat it as a local
development control interface.

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
