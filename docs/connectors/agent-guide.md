# Coding-agent guide

Use the `add-worldfixture-connector` skill when it is installed. Otherwise, get
the current task prompt with:

```sh
npx worldfixture connector prompt http://localhost:3000
```

The skill must read `protocol-v1.md`, `security.md`, and `mapping-guide.md`. It
then inspects the target repository, identifies all local service dependencies,
and preserves the application's normal start path. It proposes a mapping,
implements the local connector, adds application tests, and runs the
WorldFixture conformance check.

The agent can request optional WorldFixture database, object storage, and mail
services in `.worldfixture/project.json` when the user wants them. It must not
replace working app-owned services by default. The user starts the app through
its normal development command and does not copy connector secrets.

The skill does not redefine the protocol. The versioned docs and JSON Schemas
are the source of truth.
