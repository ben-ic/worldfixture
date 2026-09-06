# What a connector receives

Generate the pack reference for the world that you will send:

```sh
npx worldfixture connector docs
npx worldfixture connector docs --world consumer.retail-brand:v1
npx worldfixture connector docs --world-path /path/to/artifact --scale smoke
```

With no explicit world option, this command uses the current run's prepared
artifact, then the project's selected world, then the CLI default. Use the same
`--state`, `--project-dir`, `--world`, `--world-path`, `--scale`, and `--limit`
options for documentation, prompt, plan, and seed.

The command inserts a reference generated from that payload into the installed
Connector v1 documentation. It names the world, full artifact digest, scale,
packs, collections, record counts, observed field types, optional fields, and
example records. It includes commerce and social packs when present. Empty
arrays remain visible; they provide no record fields to infer.

`connector prompt <url>` includes the generated reference for the same selection.
The Workbench prompt uses its running artifact. Static protocol documentation
remains installed with WorldFixture.

A connector must map only the records that its request contains. Provider
identities and domain collections are not required in every world. Do not use
counts or field names from another world's example as a payload contract.

To read complete records from a running world, use the
[World records API](../providers/domain.md) with its current `DOMAIN_BASE_URL`
and `DOMAIN_TOKEN` bindings. It serves declared commerce and social collections,
plus finance, support, work, and identity records. List responses have explicit
pagination and artifact provenance. The Workbench **World records** screen uses
the same API. Domain writes affect that service; they do not update a connector's
application or the records seeded into other providers.
