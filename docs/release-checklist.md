# Release checklist

The release is the local world that exists now. Do not add another product
surface to complete this checklist.

## Proof

- [x] License the project under Apache License 2.0.
- [x] Build `worldfixture:local` from a clean checkout.
- [x] Run the test commands in `CONTRIBUTING.md`.
- [x] Resolve the v3 mail readiness timeout. The `--direct` route runs mail as
  its own `linux/amd64` service container, which on an arm64 machine runs under
  Rosetta and takes the default world past a 300-second budget. The CLI tests
  now start the smaller v2 world, because they test what the CLI prints rather
  than how fast Cyrus seeds; `tests/image/protocol-test.mjs` covers the default
  world on the real image, which loads it natively in about 90 seconds.
- [x] Review the source and included assets for credentials and material that
  cannot be published.
- [x] Publish the container image for `linux/amd64` and `linux/arm64`, and the
  CLI to npm, from one commit.
- [x] Record the commit and image digest in the release notes. See the release
  record at the end of each `CHANGELOG.md` entry.
- [ ] Give the README to one developer who did not build WorldFixture.
- [ ] Confirm that the developer can start the default world, use the Workbench
  or an example, reset the world, and stop it without private instructions.
- [ ] Fix only the problems that block that run.

## Before a push to a new remote

Publishing a repository publishes its history, not its working tree.

This history was squashed to a single initial commit before the first push, and
the commits that preceded it were bundled outside the repository. Nothing that
was ever tracked and later removed survives in any reachable object, no commit
message names a private path, and every commit is authored under a real address.

That is a property of the history as it stands, not a guarantee about the next
one. Check it again before pushing to any remote that has not seen this history
before:

```sh
git log --all --oneline                              # the commits a clone gets
git log --all --format='%an <%ae>' | sort -u         # the identities it gets
git worktree list                                    # branches you forgot
git remote -v                                        # where it would go

# Every path that has ever been in the history, which is not the same set as
# `git ls-files`. Read it, and check that everything in it is meant to be public.
git rev-list --all | while read -r c; do git ls-tree -r --name-only "$c"; done | sort -u
```

The rules that keep it that way:

- Nothing that is git-ignored may ever be committed. The ignore file names the
  design working directories and the private notes directory for that reason.
- `tests/contracts/test_schemas.py` refuses any tracked file that cites a path
  under the ignored notes directory, so a comment can never send a reader to a
  document they cannot have.
- A branch that is not meant to be published must be deleted before
  `git push --all`, not after.

## Connector conformance

Connector v1 is the part of the product an outside developer has to implement
themselves, so it is proven against applications this project did not write.
Each one runs the whole flow -- discovery, conformance check, plan, seed, repeat
seed, live event -- from both the CLI and the Workbench.

- [x] Vikunja (Go, SQLite)
- [x] Ghost (Node.js, WorldFixture-supplied MySQL)
- [x] Rocket.Chat (Node.js, MongoDB)
- [x] Chatwoot (Ruby on Rails, PostgreSQL)
- [x] Plane (Python/Django, PostgreSQL)

## Fixed while proving it

These were found by running the product rather than by reading it, and each one
would have reached the first outside developer.

- [x] The finance pack exported invoices and bills whose `customer_id` and
  `supplier_id` named records it did not carry. The accounts those keys name
  were in the world source and were never projected. A connector could not
  resolve a customer to a name, to billing terms, or to its organization.
  Declared as a parity migration in `tests/parity`.
- [x] `protocol-v1.md` described the connector responses in prose that left out
  required fields, and disagreed with the JSON Schemas it called authoritative.
  A connector written from the prose passed the conformance check and then
  crashed the Workbench in the browser. The check now validates every response
  against its schema and names the missing field; the document now names every
  required field, including the closed `state` and `status` enums.
- [x] `worldfixture connector` with no action answered "an application URL is
  required", which is true of the action it was not given and useless as a first
  contact with the subcommand.
- [x] A time-dependent assertion in the runtime tests measured the world's mail
  history against a fifty-day window, and the world drifted out of it. A
  contributor cloning the repository would have seen a failing suite.
- [x] Running `worldfixture up` and then `npm test`, which is what the README and
  CONTRIBUTING tell a new person to do in that order, failed with
  `EADDRINUSE 127.0.0.1:4703`: a test asserting the fixed single-container ports
  cannot run while an instance is holding them. It now says so and skips.
- [x] Installing the published package in an empty directory left the reader
  with nothing to copy: the README told them to `cp -r examples/minimal-world`,
  which only exists in a checkout. `worldfixture new <dir>` does it either way.
- [x] The first screen ended with a bare `worldfixture slack send ...`, and
  somebody who installed the documented way has no `worldfixture` on their PATH.
  Every suggested command is now written the way the reader invoked the CLI.
