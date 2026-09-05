# How worlds work

A world is a versioned source dataset for one synthetic organization and its
related organizations. It includes people, provider identities, communication,
software, work, finance, support, stories, and scheduled arrivals.

`worldfixture build` validates the source and creates a prepared,
content-addressed artifact.
The artifact contains the normalized world and one JSON projection for each
service. The runtime selects service implementations, assigns host ports,
supplies the projections, and waits for declared readiness checks.

The default world is `business.saas-company:v3`. Use `worldfixture new` to copy
the small starter source:

```sh
npx worldfixture new ./my-world
npx worldfixture validate ./my-world
npx worldfixture build ./my-world
npx worldfixture up ./dist/demo.my-world.v1
```

World data is dynamic. Application and Workbench code must discover people,
channels, pages, repositories, products, and identifiers from the active world
or provider API. Code must not depend on names from the default world.

See [how WorldFixture fits your development loop](../architecture.md) for what
happens before and during a run.
