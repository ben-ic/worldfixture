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
```

Supply exactly one explicit selector: a positional world name or artifact
directory, `--world <name-or-path>`, or `--world-path <directory>`. A name can
use `id:version`, the `id.version` alias, or an ID with one catalogue match.
Unknown, ambiguous, conflicting, or invalid selections fail before project
or run files are written.

Selection follows this order:

1. The explicit selector.
2. The `world` string in `.worldfixture/project.json`.
3. The declared default, `business.saas-company:v3`.

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
The source is `selector`, `worldPath`, `projectWorld`, or `defaultWorld`.
`--direct` and container launch use the same selected artifact. `--no-rebase`
keeps its original dates in both modes.

A running container can be reused only if the selected artifact's ID, version,
and digest match. Use `switch` to change the active world.

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
