# Vercel

## What works

WorldFixture supports selected users, teams, projects, deployments, domains,
environment variables, OAuth, local API keys, and local Blob routes. Support
label: **Supported but partial**.

## What does not work

Production builds, edge execution, Functions, DNS changes, certificates, Git
provider work, real domain verification, webhooks, billing, marketplace,
checks, logs, observability, security, and unlisted Vercel APIs do not work.
These operations are **Not supported**. Production behavior and
`@vercel/sdk` are **Not verified against the production provider**.

## Connect

Use `VERCEL_BASE_URL` and `VERCEL_TOKEN`. Send
`Authorization: Bearer TOKEN_VALUE` and JSON bodies.

WorldFixture uses `@emulators/vercel` 0.10.0.

## Route reference

| Resource | Exact methods and paths | Input and output | Proof |
| --- | --- | --- | --- |
| User | `GET, PATCH /v2/user` | User JSON; user object | Registered route source |
| Teams | `GET, POST /v2/teams`<br>`GET, PATCH /v2/teams/:teamId` | Team JSON or query; team data | Registered route source |
| Team members | `GET, POST /v2/teams/:teamId/members` | Member JSON or query; member data | Registered route source |
| Projects | `POST /v11/projects`<br>`GET /v10/projects`<br>`GET, PATCH, DELETE /v9/projects/:idOrName` | Project JSON or query; project data | Registered route source |
| Aliases and protection | `GET /v1/projects/:projectId/promote/aliases`<br>`PATCH /v1/projects/:idOrName/protection-bypass` | Project ID or bypass JSON; alias or project data | Registered route source |
| Deployments | `POST /v13/deployments`<br>`GET /v6/deployments`<br>`GET /v13/deployments/:idOrUrl`<br>`PATCH /v12/deployments/:id/cancel`<br>`DELETE /v13/deployments/:id` | Deployment JSON or query; deployment data | Registered route source |
| Deployment data | `GET /v2/deployments/:id/aliases`<br>`GET /v3/deployments/:idOrUrl/events`<br>`GET /v6/deployments/:id/files`<br>`POST /v2/files` | Deployment ID or file body; alias, event, or file data | Registered route source |
| Domains | `POST /v10/projects/:idOrName/domains`<br>`GET /v9/projects/:idOrName/domains`<br>`GET, PATCH, DELETE /v9/projects/:idOrName/domains/:domain`<br>`POST /v9/projects/:idOrName/domains/:domain/verify` | Domain JSON or query; domain data | Registered route source |
| Environment variables | `GET, POST /v10/projects/:idOrName/env`<br>`GET /v10/projects/:idOrName/env/:id`<br>`PATCH, DELETE /v9/projects/:idOrName/env/:id` | Variable JSON or query; variable data | Registered route source |
| OAuth | `GET /oauth/authorize`<br>`POST /oauth/authorize/callback`<br>`POST /login/oauth/token`<br>`GET /login/oauth/userinfo` | OAuth query or form; redirect, token, or user data | Registered route source |
| Local API keys | `POST, GET /v1/api-keys`<br>`DELETE /v1/api-keys/:keyId` | Key JSON or query; key metadata | Registered route source |
| Local Blob | `PUT, GET /api/blob`<br>`POST /api/blob/delete`<br>`POST, PUT /api/blob/mpu`<br>`GET /blob/:storeId/:pathname` | Blob body or control JSON; blob or control result | Registered route source |
| CLI check | `GET /registration` | No input; local registration flag | Registered route source |

Project objects include local `id`, `name`, owner, framework, targets,
domains, environment data, and timestamps where defined. Deployment objects
include local `id`, `url`, `name`, `projectId`, `readyState`, creator,
target, and timestamps. A local deployment changes to `READY`. WorldFixture
does not run a build.

## State, reset, Workbench, and proof

Writes change the store that later API calls and the Workbench read. The
Workbench reads teams, projects, and deployments through live API calls. It has
no Vercel write control. Reset restarts and reseeds the store. Stop does not
preserve this state.

Implementation: emulate.dev. WorldFixture adds no Vercel API route. Proof is
the route source, compiler projection tests, and live Workbench reads. No
endpoint has a Vercel contract test or production recording. No official SDK
version has a WorldFixture test.

Provider authority: [Vercel REST API](https://vercel.com/docs/rest-api).
