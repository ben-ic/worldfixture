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

Run Node.js component tests:

```sh
(cd runtime && npm test)
(cd emulators/emulate && npm test)
node --test emulators/http-targets/test/*.test.mjs
```

Build the product image before image or complete example tests:

```sh
PYTHONPATH=compiler python3 -m worldfixture_compiler build \
  worlds/business.saas-company.v3/world.json \
  --output dist/business.saas-company.v3
docker buildx build --load -t worldfixture:local .
node tests/image/protocol-test.mjs
node --test examples/real-container.test.mjs
```

The S3 protocol test builds its own service image:

```sh
node emulators/s3/test/protocol-test.mjs
```

## Documentation

- Write commands that work from the directory the document names.
- State when a command needs Docker or a prebuilt image.
- Use relative links for repository documents.
- Separate current behavior from proposed design.
- Update the public README when a default world, command, requirement, or
  release limitation changes.

## Publication

Use the [release checklist](docs/release-checklist.md) before you publish source
archives, packages, or container images.
