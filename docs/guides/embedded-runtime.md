# Run beside an existing application runtime

WorldFixture needs Node.js 22 or later, including `node:sqlite`. An application
can keep its own Node.js version. The Node-RED integration report from
2026-09-07 used Node-RED 4.1.10 with Node.js 20.20.2 and a separate Node.js
22.23.2 executable for WorldFixture.

## Separate application and WorldFixture containers

Use the normal [application connection steps](../getting-started/connect-an-app.md)
when the application runs on the host. The WorldFixture image supplies its own
provider runtime. The host CLI still needs the supported Node.js version.

For example, with WorldFixture installed at `/opt/worldfixture`, use explicit
executable paths. Replace the paths below with your installation paths:

```sh
/opt/node22/bin/node /opt/worldfixture/runtime/bin/worldfixture.mjs up --setup --no-sample-app
/opt/node22/bin/node /opt/worldfixture/runtime/bin/worldfixture.mjs run -- /opt/node20/bin/node /app/server.mjs
/opt/node22/bin/node /opt/worldfixture/runtime/bin/worldfixture.mjs down
```

Run `down` after the application exits. The `run` command passes the ready
instance's bindings to the application. It does not own the instance lifecycle.
If the application is in another container, host loopback bindings are not
addresses inside that container. Configure reachable addresses for that network.

## One container with two Node.js executables

Package the WorldFixture runtime, provider dependencies, schemas, and world
artifact with the application. Install the supported Node.js executable at a
separate path. Check it during the image build:

```sh
/opt/worldfixture/bin/node --version
/opt/worldfixture/bin/node --input-type=module -e 'await import("node:sqlite")'
```

The provider manifests invoke `node`. Set `PATH` for the WorldFixture process
so its provider children also use the supported executable:

```sh
env PATH="/opt/worldfixture/bin:$PATH" WORLDFIXTURE_SINGLE_CONTAINER=1 \
  /opt/worldfixture/bin/node /opt/worldfixture/runtime/bin/worldfixture.mjs up \
  --world-path /opt/worldfixture/dist/business.saas-company.v3 \
  --state /data/worldfixture --only github,slack --no-rebase --setup --no-sample-app
```

This is a foreground command inside the container. It selects GitHub and Slack.
Start the application after readiness, with its original executable and the
resolved bindings. For Node-RED, the original executable in the tested image
was `/usr/local/bin/node`. Use that absolute path even if the launcher changed
`PATH`.

The container launcher must stop the application if a required provider exits.
It must also stop WorldFixture when the application exits or the container
receives a shutdown signal. Keep generated bindings in private runtime state;
read tokens from the environment in flow code.

The tested recipe copied a Node.js executable between compatible Alpine images
of the same architecture. This is not a general Linux packaging method. Check
the architecture, C library, and required shared libraries for your images.
Keep immutable image pins with the application recipe.

## Exact provider selection

`--only` selects named world parts. It currently accepts `domain`, `github`,
`slack`, `site`, `mail`, `s3`, and `providers`. `providers` selects a broader set;
`notion` is not a separate part.

Use `--environment /path/to/node-red.environment.json` instead of `--only`
to select exactly GitHub, Slack, and Notion. The file declares the five required
capabilities and six provider bindings. See the
[complete environment file and command](../reference/cli.md#exact-capability-selection).

The file uses the existing environment schema. The CLI handles resolution,
readiness, binding export, and provider shutdown. The application can use
`worldfixture run` or `worldfixture env --json` without internal imports.
Use a CLI and image build that include `--environment`; the 0.2.5 image from
the original Node-RED report does not include this option.

See [provider discovery requests](../getting-started/connect-an-app.md#discover-github-slack-and-notion)
and [integration test coverage](../contract-testing.md#node-red-integration-follow-up).
