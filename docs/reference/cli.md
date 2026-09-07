# World selection and clock commands

## `env`

```sh
npx worldfixture env
npx worldfixture env --json
```

Exports the active world's connection values as shell assignments or JSON.
The output includes provider credentials, `WORKBENCH_URL`, and the current
application connector token, `WORLDFIXTURE_TOKEN`. These are usable secret values.
Read them again after a world switch and update the application's configuration
before you confirm its connector. Status and error messages hide tokens.

## `worlds`

```sh
npx worldfixture worlds
npx worldfixture worlds --json
```

Lists packaged artifacts, verified imports, and the session's initial and current
artifacts. Each entry uses the ID and version from its manifest. Identical valid
artifacts appear once. Different digests remain separate choices. Invalid
artifacts stay in the list with their validation errors.

Readable output includes `id:version`, validation status, artifact path,
SHA-256 digest, and verified source path or a message that the source is absent.
`--json` returns an array with these fields:

| Field | Meaning |
| --- | --- |
| `id`, `version` | Manifest world identity. |
| `digest` | Manifest artifact SHA-256. |
| `artifactPath` | Absolute artifact directory. |
| `sourcePath` | Verified source file, or `null` when unavailable. |
| `valid`, `errors` | Validation result and error strings. |
| `manifest` | Parsed artifact manifest. |
| `selectionSource` | `null` for catalogue entries. |

Malformed artifacts can have unavailable identity or manifest fields. A listed
digest is a manifest claim; check `valid` before using the artifact.

## `up`

```sh
npx worldfixture up consumer.retail-brand:v1
npx worldfixture up ./dist/demo.minimal.v1
npx worldfixture up --world-path ./dist/demo.minimal.v1 --no-rebase
npx worldfixture up --sample-app
```

Supply exactly one explicit selector: a positional world name or artifact
directory, `--world <name-or-path>`, or `--world-path <directory>`. A name can
use `id:version`, the `id.version` alias, or an ID with one catalogue match.
Unknown, ambiguous, conflicting, or invalid selections fail before project
or run files are written.

Selection follows this order:

1. The explicit selector.
2. `world.use` in the file supplied with `--environment`.
3. The `world` string in `.worldfixture/project.json`.
4. The declared default, `business.saas-company:v3`.

A project setting can name an artifact or an artifact directory. Relative
paths in that setting resolve from the project directory; explicit CLI paths
resolve from the current working directory. For example:

```json
{
  "api_version": "worldfixture.project/v1",
  "application_url": "http://localhost:3000",
  "services": [],
  "world": "./dist/demo.minimal.v1"
}
```

Startup prints `Selected world: <id>:<version> (<source>)` and `Artifact: <path>`.
The source is `selector`, `worldPath`, `environment`, `projectWorld`, or `defaultWorld`.
Both normal `up` and checkout `up --direct` use loopback for host access. Neither
command publishes to the LAN. Container listeners still accept the connections
that Docker forwards from those local host ports.

`--direct` and container launch use the same selected artifact. `--no-rebase`
keeps its original dates in both modes.

Each fresh interactive `up` for a project with the default application URL asks
whether to launch the included Account Desk demo app. This also applies when
`--only` selects part of the world. A command that reuses a running instance
does not ask again. The app starts on a free local port and connects to the
active world through Connector v1. Its first start for an installed
WorldFixture version installs its production packages. Use `--sample-app` to
start it without the prompt, or `--no-sample-app` to disable the offer. An
explicit `--application-url` selects the user's app and cannot be used with
`--sample-app`. Non-interactive runs do not prompt. `worldfixture down` stops a
sample app that it started.

The ready report prints the sample app URL when it starts. The Workbench URL is
the final line so it is easy to find. The default `http://localhost:3000`
project value is not printed as if an application was running.

A running container can be reused only if the selected artifact's ID, version,
and digest match. Use `switch` to change the active world.

### Exact capability selection

Use `up --environment <file.json>` to select capabilities and binding names
with the existing `worldfixture.environment/v1` schema. This is available in
builds that include this option; the published 0.2.5 image used in the Node-RED
report predates it. Use a matching CLI and image build.

Save this as `node-red.environment.json`:

```json
{
  "api_version": "worldfixture.environment/v1",
  "world": { "use": "business.saas-company:v3" },
  "requires": [
    "github.repositories.v1",
    "github.issues.v1",
    "slack.messaging.v1",
    "notion.pages-read.v1",
    "notion.blocks-read.v1"
  ],
  "bindings": {
    "GITHUB_BASE_URL": "github.repositories.v1/base_url",
    "GITHUB_TOKEN": "github.repositories.v1/token",
    "SLACK_BASE_URL": "slack.messaging.v1/base_url",
    "SLACK_TOKEN": "slack.messaging.v1/token",
    "NOTION_BASE_URL": "notion.pages-read.v1/base_url",
    "NOTION_TOKEN": "notion.pages-read.v1/token"
  }
}
```

```sh
npx worldfixture up --environment ./node-red.environment.json --no-rebase --setup --no-sample-app
npx worldfixture env --json
npx worldfixture run -- node /path/to/application.mjs
npx worldfixture down
```

The same file is included at `examples/environments/node-red.json` in the
package and source checkout. Inside a combined application container, pass
`--environment` to its foreground `up` command as described in the
[runtime packaging guide](../guides/embedded-runtime.md).

- The file path is relative to the current directory. The CLI reads and
  validates it before startup and copies the accepted request into private run
  state for container launch. Editing the original file does not change a run.
- An explicit world name or `--world-path` must match the file's `world.use`.
  Use `--world-path` when that world is a custom artifact outside the catalogue.
- `requires` selects the requested capabilities and their declared dependencies.
  This example starts only GitHub, Slack, and Notion listeners. It does not add
  default providers, optional project databases, or OAuth capabilities. Add
  each capability your app needs. This selection does not disable other API
  routes on a selected listener or replace token permission checks.
- `bindings` maps application environment names to `<capability>/<attribute>`.
  Unknown capabilities and unavailable binding attributes fail resolution.
  Use the standard binding names above for built-in CLI and timeline actions.
  `env` and `run` also include the Workbench URL and connector token.
- If `target` is absent, the CLI uses `kind: "none"` and the world's primary
  person. Set `target.identity` to select another person. CLI environment files
  do not start an application command or an experience; use `run` for the app.
- If `execution` is absent, the CLI uses `mode: "selected-capabilities"`.
  Only compatible timeline actions are selected. `--setup` keeps delivery
  paused until you choose a starting position.
- `--environment` cannot be repeated or combined with `--only`. A repeated
  host `up --environment` can reuse a run only when the saved request matches.
  Stop the run before changing its capability or binding selection.
- `switch` retains the saved capabilities, bindings, rules, and explicit target
  identity. It uses the new world's primary person if the file omitted an
  identity. An incompatible selection fails before replacing the active world.

Bindings are published after readiness. Stop a foreground run with Ctrl-C or
SIGTERM; use `down` for a normal host run. The runtime stops its provider
processes. No imports from internal source modules are needed by the app.

## `switch`

```sh
npx worldfixture switch consumer.retail-brand:v1 --no-rebase
npx worldfixture switch ./my-built-world
npx worldfixture switch --status --json
npx worldfixture switch --connect http://localhost:3000
npx worldfixture clock start 0s
```

The switch verifies the candidate artifact before it stops the current providers.
It restores provider state with new credentials and preserves application
database services. Manual provider changes are removed. Compatible service ports
are reused. The new world starts in setup mode, before scheduled delivery.

Update the application's bindings, then confirm its connector URL. If the world
does not need an application connector, use `switch --without-application`.
Delivery stays blocked until this confirmation succeeds. The Workbench provides
the same controls under **Choose world** and **Timeline**.

If provider startup fails, the runtime attempts to restore the previous world's
baseline in a new generation. This also removes manual provider changes. If
recovery fails, the session stays stopped and reports the required repair.
Use `switch --status` to inspect the transition.

## `clock`

```sh
npx worldfixture clock --json
npx worldfixture clock pause
npx worldfixture clock advance 90s
npx worldfixture clock resume
npx worldfixture clock start 5m
```

`advance` applies due records once and keeps a paused clock paused. `start`
applies the initial position of a setup session and starts delivery. Duration
units include seconds, minutes, hours, days, and weeks, for example `90s`, `5m`,
or `1w`. See [Timeline controls](../guides/timeline.md) for repeat, reset,
delivery outcomes, and API generation checks.

## `doctor`

```sh
npx worldfixture doctor --world-path ./dist/demo.minimal.v1
```

Checks artifact paths, file sizes and hashes, aggregate digest, and world
identity through the shared artifact inspector. For a damaged artifact, a
rebuild command names its verified source and actual output directory, with
shell arguments quoted. Renaming the artifact directory does not change its
source identity. If no source can be verified, doctor reports that the source
path is unavailable instead of guessing a rebuild command.

See [How worlds work](../guides/worlds.md) for the build and selection workflow.
