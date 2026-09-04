# Release checklist

The release is the local world that exists now. Do not add another product
surface to complete this checklist.

## Proof

- [x] License the project under Apache License 2.0.
- [x] Build `worldfixture:local` from a clean checkout.
- [x] Run the test commands in `CONTRIBUTING.md`.
- [ ] Resolve the v3 mail readiness timeout. The current direct-runtime test
  reaches 90 seconds while mail creates and seeds its mailboxes.
- [ ] Give the README to one developer who did not build WorldFixture.
- [ ] Confirm that the developer can start v3, use the Workbench or an example,
  reset the world, and stop it without private instructions.
- [ ] Fix only the problems that block that run.
- [ ] Review the source and included assets for credentials and material that
  cannot be published.
- [ ] Publish the source and the `arm64` and `amd64` container image from the
  same commit.
- [ ] Record the commit and image digest in the release notes.

## Before the first push

Publishing a repository publishes its history, not its working tree. This
repository's history still carries four design documents that were tracked from
the first commit and only removed in `a1e7d22`. They are git-ignored now, so
they are invisible in a `git status` and in a fresh checkout, and they are still
in every object a clone would receive.

**What is actually there.** Verified on the 50 commits reachable from all refs:

| Path | Commits containing it | Added | Removed |
| --- | --- | --- | --- |
| `docs/extraction-status.md` | 35 | `2ccee03` | `a1e7d22` |
| `docs/product-experience.md` | 35 | `2ccee03` | `a1e7d22` |
| `docs/system-design.md` | 35 | `2ccee03` | `a1e7d22` |
| `docs/service-manifest-fit.md` | 21 | `bd77d25` | `a1e7d22` |

`docs/extraction-status.md` line 10 reads "The repository is private and has no
licence, so nothing here is ready for public distribution", and the same file
carries 421 occurrences of the old product name. No other path has ever been
added and later removed, and no credential, key, personal email address, or
local filesystem path appears anywhere in the history.

Separately, and not fixed by removing those four paths: five commit **messages**
name the old product, two name `.private/design/`, and all 50 commits are
authored as `Benjamin Cates <benjamincates@Benjamins-MacBook-Pro.local>`, which
is a hostname, not an address. Commit messages and author identities are
published with the history too.

**No remote is configured.** `git remote -v` is empty, so nothing has been
pushed and either option below is safe to run locally and verify before a remote
is added.

Reconcile before either option:

- [ ] Commit or stash the working tree. Both options require a clean tree.
- [ ] `git worktree list` shows two prunable worktrees under `/private/tmp` on
  branches `codex/application-connector` and `codex/notion-api-plan`. Both
  branches carry the same four documents. Run `git worktree prune`, then delete
  the branches you do not intend to publish — otherwise a `git push --all`
  publishes exactly what the rewrite removed.

Then pick one.

### Option A — squash to a single initial commit

```sh
git checkout --orphan release
git add -A
git commit -m "WorldFixture 0.1.0"
git branch -D main
git branch -m main
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

Costs: every commit message is lost, including the engineering record of why
each service was extracted the way it was. Authorship dates collapse to one day.
Nothing that was ever in the history survives, so this also removes the old
product name and `.private/design/` from the commit messages, and lets the
single commit be authored with a real email address. Requires no new tooling.

### Option B — remove only those four paths

```sh
pipx install git-filter-repo     # or: brew install git-filter-repo
git filter-repo --force --invert-paths \
  --path docs/extraction-status.md \
  --path docs/product-experience.md \
  --path docs/service-manifest-fit.md \
  --path docs/system-design.md
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

Costs: installs a tool. Every commit SHA changes, so any SHA quoted in a
document or a release note has to be requoted — including the four in the table
above and any in `CHANGELOG` or `docs/`. Commits that only ever touched those
four files become empty and are dropped, which shortens the history. The commit
messages that name the old product and `.private/design/` are **not** touched;
add `--replace-message <file>` in the same run if you want them rewritten too.
The author identity is not touched either; add `--mailmap <file>` for that. What
you keep is the real history: 50 messages, dates, and the order things were
built in.

Recommended: Option B if the commit history is worth publishing as a record of
how the project was built, plus `--replace-message` and `--mailmap` in the same
invocation. Option A if it is not.

After either:

- [ ] `git log --all --oneline` and confirm the count is what you expect.
- [ ] `git rev-list --all | while read c; do git ls-tree -r --name-only "$c"; done | sort -u | grep -E 'extraction-status|product-experience|service-manifest-fit|system-design'`
  returns nothing.
- [ ] `git log --all --format='%an <%ae>' | sort -u` shows the identity you mean
  to publish.
- [ ] Only then add the remote and push.

## Connector conformance

Connector v1 is the part of the product an outside developer has to implement
themselves, so it is proven against applications this project did not write.
Each one runs the whole flow — discovery, conformance check, plan, seed, repeat
seed, live event — from both the CLI and the Workbench.

- [ ] Vikunja (Go, SQLite)
- [ ] Ghost (Node.js, WorldFixture-supplied MySQL)
- [ ] Rocket.Chat (Node.js, MongoDB)
- [ ] Chatwoot (Ruby on Rails, PostgreSQL)
- [ ] Plane (Python/Django, PostgreSQL)

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
