# Contributing to WorldFixture

WorldFixture is in pre-release development. Before you prepare a change, read
the public README, the applicable documentation-site page, and the
[contract-testing policy](docs/contract-testing.md).

## Change rules

- Keep all fixture people, organizations, messages, domains, and credentials
  synthetic.
- Keep world artifact builds deterministic. Do not add current time, random data,
  file-system order, or host-specific values to an artifact.
- Use provider APIs and real protocols for runtime actions. Do not write
  directly to an emulator store.
- Keep one owner for each capability in one instance.
- Add or update tests when you change a schema, compiler output, service
  manifest, provider projection, or CLI contract.
- Do not change the v2 parity fixture unless the change is intentional and the
  new baseline has review.

## Test groups

Run compiler, schema, and parity tests. The compiler validates against the
schemas with `jsonschema`, so install the package once first:

```sh
python3 -m pip install .
PYTHONPATH=compiler python3 -m unittest discover -s tests -t .
```

This used to need nothing but Python 3.11. It now needs one dependency, pinned
in `requirements.txt` -- which `pyproject.toml` reads, so `pip install .` and
`pip install -r requirements.txt` agree -- and installed in the image as
`python3-jsonschema`. Without it every test errors at import with `No module
named 'jsonschema'`, which reads as a broken checkout rather than a missing
install.

The Node.js runtime needs it too, and not only the Python tests: `worldfixture
up` rebases the selected world onto today by calling the compiler through the
`python3` on your PATH. Without the dependency the rebase fails, the world
starts at its authored anchor weeks behind today, and four unrelated-looking
runtime tests fail. `up` now names the missing dependency and this command when
that happens.

On a PEP 668 interpreter -- a Homebrew or distribution Python that refuses to be
written to -- either add `--break-system-packages`, or use a virtual environment
and make sure it is the `python3` on PATH when you run the CLI.

Run Node.js component tests. Install pinned dependencies, build the Workbench,
and prepare the service images first:

```sh
npm --prefix emulators/emulate ci
npm --prefix runtime/workbench-ui ci
npm --prefix runtime/workbench-ui run build
node scripts/prepare-service-images.mjs
(cd runtime && npm test)
(cd emulators/emulate && npm test)
node --test emulators/http-targets/test/feed-clock.test.mjs
node emulators/http-targets/test/protocol-test.mjs
```

Both preparation steps are for the runtime suite, not only the emulator one.
`emulate` runs as a child process that imports `@emulators/core` on its first
line, so without its dependencies it exits immediately and 22 runtime tests fail
on a readiness check reporting only `fetch failed`. `prepare-service-images.mjs`
builds or pulls what the manifests name; without it the supervisor builds a
missing image inside a test's own readiness budget, and building Cyrus from a
Debian base does not fit in it. Both are no-ops once they have run.

Build the product image before image or complete example tests:

```sh
npm run build:worlds
docker buildx build --load -t worldfixture:local .
export WORLDFIXTURE_IMAGE=worldfixture:local
node tests/image/protocol-test.mjs
node --test examples/real-container.test.mjs
```

`npm run build:worlds` builds all three worlds into `dist/` for checkout tests
and the checkout CLI. The Dockerfile does not copy this `dist/` directory. Its
compiler stage builds the same world sources again for the product image. The
export makes the example test use the image you built instead of the published
image.

## Which image the CLI runs

The CLI reads its image tag from the `worldfixture.image` field in the root
`package.json`, which names the published tag for this version. A checkout that
has built its own image is therefore not using it by default. Point at yours for
the run, or for the session:

```sh
node runtime/bin/worldfixture.mjs up --image worldfixture:local
export WORLDFIXTURE_IMAGE=worldfixture:local
```

This matters when you change content that the image carries: an emulator, the
supervisor, the Workbench, the documentation site, or a world. Without the
override, the published image serves the old content.

The S3 protocol test builds its own service image:

```sh
node emulators/s3/test/protocol-test.mjs
```

## Documentation

- Write commands that work from the directory the document names.
- State when a command needs Docker or a prebuilt image.
- Use relative links for repository documents.
- Document what is implemented. Plans, working audits and design notes for
  upcoming work do not belong in the published tree; the reasoning for a change
  goes in its commit message and in comments beside the code.
- Count things rather than asserting them, and name the world a count came from.
  Worlds differ in size, so an unattributed number goes stale the moment the
  default world changes.
- Update the public README when a default world, command, requirement, or
  release limitation changes.
- `docs/connectors/packs.md` is generated from the prepared artifact and verified by
  a test. Do not hand-edit it.

Run the documentation checks from the repository root:

```sh
npm --prefix docs ci
npm run docs:check
npm run docs:diagrams:check
npm run docs:build
```

`docs:check` checks internal links, provider support references, allowed support
labels, and required architecture assets. `docs:diagrams:check` proves that the
committed SVG files match their D2 sources.

## Publication

Use the [release checklist](docs/release-checklist.md) before you publish source
archives, packages, or container images.

Package builds require Python 3.11 or later with `venv` and Node.js 22 or later.
`npm run build:worlds` creates an ignored Python environment at
`.worldfixture/build-venv` and installs the dependencies from `pyproject.toml`.
It does not install packages into system Python or require shell activation.
The first build needs access to the Python package index.

Run `npm pack` to check the complete package build before `npm publish`.
Both commands build the worlds and Workbench through `prepack`. A preview with
`--ignore-scripts` does not check these builds.
