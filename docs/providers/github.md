# GitHub

WorldFixture uses `@emulators/github` 0.10.0. WorldFixture adds issue data from
the selected world.

| Question | Answer |
| --- | --- |
| Overall API status | **Supported but partial** |
| Production comparison | **Not verified against the production provider** |
| Workbench | Live repository and issue reads; live issue create |
| State | Writes persist for the life of the world |
| Reset | Restores the accepted world snapshot |
| Implementation owner | emulate.dev, with a WorldFixture issue seed override |

“Partial” means that only the route families below are registered. A registered
route is not proof of full GitHub behavior.

## What works

You can read and change common users, repositories, issues, pull requests,
comments, labels, branches, releases, hooks, Actions data, and checks. The
Workbench reads repositories and issues from the live API. It can create an
issue in the same API state.

## What does not work

GraphQL does not work. Gists, notifications, deployments, packages, projects,
billing, enterprise administration, code scanning, secret scanning, Dependabot,
and Copilot do not work. A route group that is not in this page does not work.

## Connection and authentication

Use `GITHUB_BASE_URL` and `GITHUB_TOKEN`. Send
`Authorization: Bearer <token>`. Some public reads accept no token. Private
resources and writes require a known token.

WorldFixture does not enforce all production `User-Agent`, `Accept`,
`X-GitHub-Api-Version`, media type, permission, or rate-limit rules.

## Registered REST routes

The table gives the registered method and path patterns. In a long row, `...`
means the complete `/repos/:owner/:repo` prefix from the first path in that
row. These routes do not have complete contract tests against GitHub.

| Area | Exact HTTP method and path patterns | What works |
| --- | --- | --- |
| Current user | `GET` and `PATCH /user`; `GET /user/repos`, `/user/orgs`, `/user/emails` | Read and change the local current user; list linked resources |
| Users | `GET /users`, `/users/:username`, `/users/:username/repos`, `/users/:username/orgs`, `/users/:username/followers`, `/users/:username/following`, `/users/:username/hovercard` | Read local users and relations |
| Repositories | `GET /repos/:owner/:repo`, `/repositories/:id`; `POST /user/repos`, `/orgs/:org/repos`; `PATCH` and `DELETE /repos/:owner/:repo` | Read, create, change, and delete local repositories |
| Repository metadata | `GET` and `PUT /repos/:owner/:repo/topics`; `GET .../languages`, `.../contributors`, `.../forks`, `.../tags`; `POST .../forks` | Read and change topics; read metadata; create a fork |
| Collaborators and transfer | `GET /repos/:owner/:repo/collaborators`; `PUT` and `DELETE .../collaborators/:username`; `GET .../collaborators/:username/permission`; `POST .../transfer` | Manage local collaborators and repository owner |
| Issues | `GET` and `POST /repos/:owner/:repo/issues`; `GET` and `PATCH .../issues/:issue_number`; `PUT` and `DELETE .../issues/:issue_number/lock` | List, create, read, change, lock, and unlock issues |
| Issue relations | `GET .../issues/:issue_number/timeline`, `.../events`; `POST` and `DELETE .../issues/:issue_number/assignees` | Read events and change assignees |
| Issue comments | `GET /repos/:owner/:repo/issues/comments`, `.../issues/comments/:comment_id`, `.../issues/:issue_number/comments`; `POST .../issues/:issue_number/comments`; `PATCH` and `DELETE .../issues/comments/:comment_id` | List, create, change, and delete issue comments |
| Pull requests | `GET` and `POST /repos/:owner/:repo/pulls`; `GET` and `PATCH .../pulls/:pull_number`; `PUT .../pulls/:pull_number/merge`, `.../update-branch`; `GET .../commits`, `.../files` | Manage local pull requests and merge state |
| Pull-request reviewers | `POST` and `DELETE .../pulls/:pull_number/requested_reviewers` | Add and remove requested reviewers |
| Review comments | `GET /repos/:owner/:repo/pulls/comments`, `.../pulls/comments/:comment_id`, `.../pulls/:pull_number/comments`; `POST .../pulls/:pull_number/comments`; `PATCH` and `DELETE .../pulls/comments/:comment_id` | Manage local review comments |
| Commit comments | `GET /repos/:owner/:repo/comments`, `.../comments/:comment_id`, `.../commits/:commit_sha/comments`; `POST .../commits/:commit_sha/comments`; `PATCH` and `DELETE .../comments/:comment_id` | Manage local commit comments |
| Reviews | `GET` and `POST .../pulls/:pull_number/reviews`; `GET` and `PUT .../reviews/:review_id`; `POST .../reviews/:review_id/events`; `PUT .../reviews/:review_id/dismissals`; `GET .../reviews/:review_id/comments` | Create, submit, dismiss, and read reviews |
| Labels | `GET` and `POST /repos/:owner/:repo/labels`; `GET`, `PATCH`, and `DELETE .../labels/:name`; `GET`, `POST`, `PUT`, and `DELETE .../issues/:issue_number/labels`; `DELETE .../labels/:name` | Manage repository and issue labels |
| Milestones | `GET` and `POST /repos/:owner/:repo/milestones`; `GET`, `PATCH`, and `DELETE .../milestones/:milestone_number`; `GET .../milestones/:milestone_number/labels` | Manage local milestones |
| Branches and protection | `GET /repos/:owner/:repo/branches`, `.../branches/:branch`; `GET`, `PUT`, and `DELETE .../branches/:branch/protection`; protection subroutes for `required_status_checks`, `enforce_admins`, and `required_pull_request_reviews` | Read branches and manage a subset of protection settings |
| Git references | `GET .../git/ref/:ref`, `.../git/matching-refs/:ref`; `POST .../git/refs`; `PATCH` and `DELETE .../git/refs/:ref` | Read and manage local refs |
| Git objects | `GET` and `POST` routes for `git/commits`, `git/trees`, `git/blobs`, and `git/tags` with the applicable SHA path | Read and create local Git objects |
| Contents and commits | `GET .../readme`, `GET .../contents`, `GET .../contents/`, `GET .../contents/:path`, `GET .../commits`, `GET .../commits/:ref`, `GET .../compare/:basehead`, and `GET /:owner/:repo/raw/:ref/:path`; `PUT` and `DELETE .../contents/:path` | Read and change local file content; read commits and comparisons |
| Organizations | `GET /organizations`, `/orgs/:org`; `PATCH /orgs/:org`; member and membership routes under `/orgs/:org/members` and `memberships` | Read and change local organizations and membership |
| Teams | `GET` and `POST /orgs/:org/teams`; `GET`, `PATCH`, and `DELETE .../teams/:team_slug`; member, membership, and repository subroutes; `GET /teams/:team_id` and `/teams/:team_id/members` | Manage local teams |
| Releases | `GET` and `POST /repos/:owner/:repo/releases`; get, patch, delete, latest, tag, generate-notes, asset list, asset upload, asset get, asset patch, and asset delete subroutes | Manage local releases and assets |
| Repository hooks | `GET` and `POST .../hooks`; `GET`, `PATCH`, and `DELETE .../hooks/:hook_id`; `POST .../pings`, `.../tests`; `GET .../deliveries`, `.../deliveries/:delivery_id` | Manage local webhook configuration and delivery records |
| Organization hooks | `GET` and `POST /orgs/:org/hooks`; `GET`, `PATCH`, and `DELETE .../hooks/:hook_id`; `POST .../pings` | Manage local organization hooks |
| Search | `GET /search/repositories`, `/search/issues`, `/search/users`, `/search/code`, `/search/commits`, `/search/topics`, `/search/labels` | Search local records |
| Actions | Workflow, run, job, log, artifact, and repository or organization secret routes under `/repos/:owner/:repo/actions` and `/orgs/:org/actions/secrets` | Read and change local Actions state; dispatch, cancel, rerun, delete, and secret operations exist |
| Checks | Check-suite and check-run routes under `/repos/:owner/:repo/check-suites`, `check-runs`, and `commits/:ref/check-*` | Create, change, rerequest, and read local checks |
| Service metadata | `GET /rate_limit`, `/meta`, `/octocat`, `/emojis`, `/zen`, `/versions` | Static or local service metadata |
| OAuth | `GET /login/oauth/authorize`; `POST /login/oauth/callback`, `/login/oauth/access_token` | Local OAuth authorization-code flow |
| GitHub App | `GET /app`, `/app/installations`, `/app/installations/:installation_id`; `POST .../access_tokens`; repository, organization, and user installation lookup routes | Read local app data and create installation tokens |
| OAuth app settings | `GET /settings/applications`, `/settings/connections/applications/:client_id`; `POST .../revoke` | Read and revoke local OAuth app connections |

Important response objects follow the selected GitHub resource shape. Common
fields are `id`, `node_id`, `login`, `name`, `full_name`, `number`,
`title`, `state`, `body`, `html_url`, `created_at`, and `updated_at`.
List routes return JSON arrays unless the GitHub route uses an object envelope.

## Workbench, webhooks, and SDKs

The Workbench reads repositories and issues from the live API. It creates an
issue with `POST /repos/:owner/:repo/issues`. This write changes the same store
that API clients read.

Repository and organization webhook state and delivery records exist. Exact
GitHub signatures, headers, retries, timing, and payloads are **Not verified
against the production provider**.

No Octokit version has a provider contract test. An Octokit call is
**Not supported** if it maps to a route that this page does not list.

## Detailed limits

GraphQL is **Not supported**. Gists, notifications, deployments, packages,
projects, billing, enterprise administration, code scanning, secret scanning,
Dependabot, Copilot, and other route groups not listed above are **Not
supported**.

## Evidence and authority

Tests: `emulators/emulate/src/overrides/github-issues.test.mjs`,
`tests/contracts/test_compiler_core.py`, Workbench tests under
`runtime/src/`, and the readiness check in `emulators/emulate/service.json`.
The tests prove seed mapping and the Workbench issue path. They do not prove all
registered routes.

Authority: [GitHub REST API](https://docs.github.com/en/rest) and
[webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
