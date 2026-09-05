# The smallest world that runs

Two people, one channel, two messages, one project and one task. Copy this
directory, edit it, and you have your own world.

`worldfixture new` makes the copy, from anywhere, whether WorldFixture came from
npm or from a checkout:

```sh
npx worldfixture new ./my-world
npx worldfixture validate ./my-world
npx worldfixture build ./my-world
npx worldfixture up ./dist/demo.minimal.v1
```

The copy keeps this world's id and version until you change them in
`world.json`, which is why `build` writes `dist/demo.minimal.v1`.

`validate` prepares the artifact in a temporary directory and then discards it,
so anything it accepts will build.

## What each file is

`world.json` is the manifest: the world's identity, its profile, its clock
anchor, and the fragments it is assembled from. Every date in the world is
relative to that anchor.

`fragments/core.json` is the world itself. A fragment `contributes` records to
domains, and several fragments can contribute to the same domain, which is how
the larger worlds in `worlds/` are split into a backbone and a story.

## The empty domains, and why they are there

The `business.operations/v1` profile projects `communication`, `finance`,
`software`, `support`, `work`, `agentic` and `stories`, and it indexes them
rather than defaulting them. A world that leaves one out is refused by
`validate`, by name, so declare the ones you have no records for as empty. That
is what most of `core.json` is.

`site` is genuinely optional; this world has one anyway, because a public site is
one of the surfaces an instance serves.

## Rules the build enforces

- Every person needs a unique `id`, `email`, `github_login` and `slack_id`, and a
  `slack_id` starts with `U`.
- Exactly one person is `primary`. The CLI acts as that person by default and
  their credentials are the ones `worldfixture env` prints.
- Every email and organization domain ends in `.test`. The build refuses
  anything else, so a world can never address a real inbox.
- `agentic.actor_id` names a person in this world.
- Nothing in a world may depend on the clock, the filesystem, or randomness. The
  same source always produces the same artifact bytes.

## What it does not do

A world you build yourself starts at its authored anchor rather than being
rebased onto today, because rebasing needs the world source and the source lives
on your machine rather than in the image. Its history will read as dated. The
worlds shipped in the image are rebased on every `up`.
