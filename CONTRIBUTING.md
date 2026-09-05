# Contributing to WorldFixture

WorldFixture is in pre-release development. Before you prepare a change, read
the public README and the relevant service README.

## Change rules

- Keep all fixture people, organizations, messages, domains, and credentials
  synthetic.
- Keep world compilation deterministic. Do not add current time, random data,
  file-system order, or host-specific values to an artifact.
- Use provider APIs and real protocols for runtime actions. Do not write
  directly to an emulator store.
- Keep one owner for each capability in one instance.
- Add or update tests when you change a schema, compiler output, service
  manifest, provider projection, or CLI contract.
- Do not change the v2 parity fixture unless the change is intentional and the
  new baseline has review.

## Test groups

Run compiler, schema, and parity tests:

```sh
PYTHONPATH=compiler python3 -m unittest discover -s tests -t .
```

Run Node.js component tests. Install the provider emulator's pinned
dependencies first, and build the service images the runtime suite starts:

```sh
npm --prefix emulators/emulate ci
node scripts/prepare-service-images.mjs
(cd runtime && npm test)
(cd emulators/emulate && npm test)
node --test emulators/http-targets/test/*.test.mjs
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

`npm run build:worlds` compiles all three worlds into `dist/`, which is what the
image build and the checkout CLI read. The export is what makes the example test
use the image you just built rather than the published one; see below.

## Which image the CLI runs

The CLI reads its image tag from the `worldfixture.image` field in the root
`package.json`, which names the published tag for this version. A checkout that
has built its own image is therefore not using it by default. Point at yours for
the run, or for the session:

```sh
node runtime/bin/worldfixture.mjs up --image worldfixture:local
export WORLDFIXTURE_IMAGE=worldfixture:local
```

This matters whenever you change anything the image carries -- an emulator, the
supervisor, the Workbench build, or a world -- because otherwise the published
image serves the old behaviour and the change appears to have done nothing.

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
- `docs/connectors/packs.md` is generated from the built artifact and verified by
  a test. Do not hand-edit it.

## Publication

Use the [release checklist](docs/release-checklist.md) before you publish source
archives, packages, or container images.
