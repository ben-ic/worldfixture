# AWS IAM, SQS, and STS

WorldFixture exposes a local subset of IAM, SQS, and STS through
`@emulators/aws` 0.10.0. Overall status: **Supported but partial**.
These routes are **Not verified against the production provider**.

## Connect

Use `AWS_BASE_URL` and `AWS_TOKEN` from `worldfixture env`. Send a form-encoded
`POST` request to the service path with `Action` and the required action fields.
Authentication requires the current run's bearer token with the service scope.
Unknown, sample, and other-provider credentials are rejected.

```sh
curl "$AWS_BASE_URL/iam/" \
  -H "Authorization: Bearer $AWS_TOKEN" \
  --data-urlencode Action=ListUsers \
  --data-urlencode Version=2010-05-08
```

IAM, SQS, and STS use this local bearer-token contract. AWS SDK authentication
and SigV4 requests to these three services are **Not supported**. Use the
separate [S3 service](./s3.md) for signed object-storage requests.

## What works

| Method and path | Actions |
| --- | --- |
| `POST /iam/` | `CreateUser`, `GetUser`, `DeleteUser`, `ListUsers`, `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`, `CreateRole`, `GetRole`, `DeleteRole`, `ListRoles` |
| `POST /sqs/` | `CreateQueue`, `DeleteQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`, `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `PurgeQueue` |
| `POST /sts/` | `GetCallerIdentity`, `AssumeRole` |

Responses use the local AWS Query XML format. IAM operators come from the
world's `software.operator_teams`, `operator_ids`, and `operator_limit` policy.
An empty selection or zero limit selects no operators. Old sources without
these fields retain the documented legacy selection.

The projected AWS account and region determine returned account IDs, ARNs, and
queue URLs. Pass the returned `QueueUrl` to subsequent SQS calls. Queue URLs
from another account are rejected. Reset restores the accepted users, roles,
and queues and removes later API changes.

The AWS listener has no S3 routes. SeaweedFS owns S3 state, credentials, bucket
listing, and object operations.

## What does not work

The complete AWS APIs, SDK parity, production IAM permission evaluation, and
production STS credentials are **Not supported**. The local bearer credential
controls access to each implemented service; it does not reproduce IAM policy
evaluation.

Tests: `emulators/emulate/src/overrides/aws-control-plane.test.mjs`,
`tests/contracts/test_aws_operators.py`, `runtime/src/resolve.test.mjs`, and
`tests/image/coupling-aws-test.mjs`. The live matrix checks declared operators,
route ownership, authentication, API writes, S3 isolation, and normal reset.
