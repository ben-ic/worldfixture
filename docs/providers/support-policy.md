# How WorldFixture reports API support

A provider name does not mean that WorldFixture implements the complete
provider API.

## Read scope before status

Each support entry must give these facts:

1. The exact reads and writes that work.
2. The important operations or branches that do not work.
3. The Workbench behavior.
4. The tested official SDK and version, or state that there is no SDK test.
5. The test file or production recording that proves the statement.

**Supported but partial** is only an overall summary. It is never the answer to
“Does this operation work?” Use the named operation table for that answer.

## Required labels

| Label | Meaning |
| --- | --- |
| **Supported and contract-tested** | The named operation or branch has a passing test against the stated contract evidence. |
| **Supported but partial** | Some useful named behavior works. Other behavior is absent or does not have tests. Read the exact scope. |
| **Workbench-only** | The feature is a local Workbench control or view. It is not a provider API operation. |
| **Not supported** | The operation is not available in a resolved WorldFixture run. |
| **Not verified against the production provider** | No production request and response recording proves the behavior. Local tests and official schemas can still give evidence. |

A named operation can be **Supported and contract-tested** and also **Not
verified against the production provider**. The first label describes local
test proof. The second label describes production comparison proof.

## Evidence strength

Evidence is strongest in this order:

1. Production request and response recording for the selected provider version.
2. Official provider documentation or schema.
3. Official SDK type and passing SDK test against WorldFixture.
4. WorldFixture route test.
5. Executable route source.
6. Package documentation or service manifest.

A readiness probe proves only its request. A compiler projection test proves
only the input data. Neither proves all provider routes.

## Release rule

The [provider support index](./index.md) must show working and missing scope in
one scan. Each provider page must also give bindings, authentication, requests,
responses, state, reset, events, Workbench behavior, SDK versions, limitations,
implementation ownership, and test files. An automated check confirms that
cited local files and support references exist.
