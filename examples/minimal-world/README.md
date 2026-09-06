# The smallest world that runs

Two people, one channel, two messages, one project, one task and one scheduled
arrival. After thirty seconds of world time, Tomas posts in `#general` about
checking the export retry. Copy this directory and edit it to make your own world.

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

## Optional sections

The starter includes empty collections to show where more records can go. You
can omit sections that your world does not use. The `business.operations/v1`
profile does not require unrelated sections or provider identities.

Keep references valid when you remove a section. For example, the scheduled
chat arrival needs both its author and its channel. Replace that arrival with
another real action if you remove the channel.

## Rules the build enforces

- Every world needs a nonempty authored `timeline`. Give each arrival a unique
  `id`, a nonnegative integer `after_seconds`, a supported `kind`, and its
  required `payload`. An empty timeline is not an open-ended event model.
- Each person needs a unique canonical `id` and a name. Provider adapters derive
  native IDs when you do not declare them. Mail and some identity APIs need email.
- A `primary` person is optional. When one is declared, personal default bindings
  use that person. An operation that needs an actor must name an existing person.
- Every email and organization domain ends in `.test`. The build refuses
  anything else, so a world can never address a real inbox.
- `agentic.actor_id` names a person in this world.
- Nothing in a world may depend on the clock, the filesystem, or randomness. The
  same source always produces the same artifact bytes.

## Session dates

A normal start can prepare a session copy at the current date when it can verify
this source. `--no-rebase` keeps the authored anchor. Keep the source with your
artifact so the runtime can verify and rebuild it.
