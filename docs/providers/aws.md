# AWS IAM, SQS, and STS

The WorldFixture product status for these three services is **Not supported**.

## What works

Nothing in IAM, SQS, or STS is available through a running WorldFixture world.
Use [S3 object storage](./s3.md) for object storage.

## What does not work

All IAM, SQS, and STS API operations, SDK calls, state, reset behavior, events,
and webhooks are **Not supported**.

## Why these services are not supported

The installed `@emulators/aws` 0.10.0 package contains IAM, SQS, STS, and S3
code. WorldFixture does not start this package listener. Its listener also
contains another writable S3 implementation. That implementation conflicts with
the selected SeaweedFS S3 service.

The resolver rejects the advertised `aws.iam.v1`, `aws.sqs.v1`, and
`aws.sts.v1` profiles. The service manifest has no AWS readiness check. Users
do not get functional IAM, SQS, or STS bindings.

## Code that exists but is not a product API

This table is an audit of the unavailable package code. It is not a support
claim.

| Unavailable endpoint | Actions present in package code |
| --- | --- |
| `POST /sqs/` with form or query `Action` | `CreateQueue`, `DeleteQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`, `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `PurgeQueue` |
| `POST /iam/` with form or query `Action` | `CreateUser`, `GetUser`, `DeleteUser`, `ListUsers`, `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`, `CreateRole`, `GetRole`, `DeleteRole`, `ListRoles` |
| `POST /sts/` with form or query `Action` | `GetCallerIdentity`, `AssumeRole` |

Authentication, request signing, response contracts, SDK behavior, persistence,
reset, events, and webhooks for these endpoints are all **Not supported** as
WorldFixture product behavior.

Do not point an AWS SDK at the unavailable listener. Use [S3 object
storage](./s3.md) for the supported standalone object service.

## Evidence

Tests and manifests: `runtime/src/resolve.test.mjs`,
`emulators/emulate/src/ready.test.mjs`, the disclaimer in
`emulators/emulate/service.json`, and compiler contract tests under
`tests/contracts/`.
