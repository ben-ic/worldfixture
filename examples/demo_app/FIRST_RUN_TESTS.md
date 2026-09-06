# Clean first-run check

From this example, run:

```sh
ACCOUNT_DESK_TEST_IMAGE=worldfixture:account-desk node scripts/check-first-run.mjs
```

The corrected local image must already exist. The check does not build or
publish an image.

This check creates a new app directory under the system temporary directory.
It copies the app package, lockfile, source, tests, and Vite configuration.
It does not copy `node_modules`, runtime state, or credentials.

It then:

1. Runs `npm ci` to make a separate dependency tree. It first tries cached
   package archives with `--offline`. If a required archive is absent, it uses
   `--prefer-offline` and can download the missing package.
2. Builds the production UI.
3. Starts a separate world with the installed `npx worldfixture` command,
   the exact local image digest, and PostgreSQL.
4. Starts the real app with `npx worldfixture run -- npm run start` on a
   dynamically assigned local port.
5. Checks the built UI assets, connection readiness, and provider reads.
6. Runs read verification. It then prepares a write plan, checks that approval
   is required, approves writes in this isolated world, and checks readback.
7. Confirms that repeated approval returns the same saved run.
8. Saves the same JSON run record used by the UI evidence download.
9. Runs the four-service customer workflow and connector tests.

The script writes a secret-free `first-run-report.json`. It also saves
`read-verification.json`, `write-plan.json`, and `write-verification.json` in
the temporary project. Missing write-plan prerequisites are listed explicitly;
they are not counted as passing writes.

## Browser review

The test app and its world remain running. The output gives their project
directory, browser URL, and app launcher PID/process group. This lets a browser
test inspect the same records that the API tests created.

To copy later app changes into that owned temporary project and rebuild:

```sh
node scripts/check-first-run.mjs --refresh /exact/test/project/path
```

Static UI changes appear after a browser reload. Server changes require an
explicit restart of only the recorded test app process. To copy the latest
source, verify and stop that process group, rebuild, restart, and repeat all API
checks:

```sh
node scripts/check-first-run.mjs --restart /exact/test/project/path
```

The restart command checks the recorded process's working directory, process
group, and command before it sends a stop signal. It does not reset the world.

To test a different image in this same owned project, use the command below
only after approval to remove the current world. This stops the app, replaces
the world, retains the app port, and repeats the checks. Later provider changes
are lost. A report backup is not a backup of provider data.

```sh
ACCOUNT_DESK_TEST_IMAGE=worldfixture:account-desk-100k \
  node scripts/check-first-run.mjs --replace-world /exact/test/project/path
```

When browser review is complete, stop that test app process. Then run this
command from its exact temporary project directory:

```sh
npx --no-install worldfixture down
```

Do not run the cleanup command from the normal demo project. Temporary test
files remain available for inspection.

## Verified result

The complete check passed on 2026-09-05 with Node 26.5.0, a separate dependency
tree installed by `npm ci --offline`, and WorldFixture 0.2.3 from the npm
registry. Cached package archives were used; installed dependencies were not
copied or linked from the repository.

The exact corrected local image was:

```text
sha256:0cc583df8dec71b84b58b143558b418884a8285dcb75180d9e136c0590a4b080
```

| Check | Result |
| --- | --- |
| Production UI build and served JavaScript/CSS | Passed |
| Provider read checks | 22 passed; none failed or skipped |
| Approved write and fresh readback checks | 16 passed; no missing prerequisites |
| Missing approval refused | Passed |
| Repeated approval returns current saved results | Passed; no repeated writes |
| Persisted run JSON matches saved evidence | Passed |
| Customer workflow across four providers | Passed |
| App draft saved and read again | Passed |
| Connector seed idempotency | Passed |
| Connector discovery, authentication, plan, and status checks | All seven passed |

The initial check found stale results after repeated write approval. The server
was corrected, the copied app was rebuilt and restarted, and the full check
passed again without resetting the test world.

## Replacement image check: 100,000 local request budget

On 2026-09-05, the same owned test project was replaced with explicit user
approval. The app retained port `50411`. The new source-built image was
`worldfixture:account-desk-100k`:

```text
sha256:a0afe0195852c4c7f859cf825db208c34c4107cd8838aa2acafd0a6862ccca8a
```

All 22 read checks and 16 approved write/readback checks passed again, with no
failed or skipped checks. The customer workflow and connector checks also
passed. A direct request to the running Google listener returned
`X-RateLimit-Limit: 100000`. This confirms the running image, not only the
source patch. Previous provider changes were removed during replacement.

## Scope

This is an installed-package, production-build, local-image test. A local
provider pass is not a production-provider contract comparison. Checking the
JSON evidence API does not prove that the browser download control works;
browser review must check that control separately.
