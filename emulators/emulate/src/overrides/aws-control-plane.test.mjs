import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";
import { awsPlugin, seedFromConfig } from "@emulators/aws";
import { awsControlPlanePlugin, seedAwsControlPlane } from "./aws-control-plane.mjs";

const token = "current-world-aws-test-token";
const config = {
  account_id: "000000000000",
  region: "eu-west-1",
  iam: { users: [{ user_name: "river", path: "/operators/", create_access_key: false }],
    roles: [{ role_name: "queue-worker", path: "/services/", description: "Declared worker" }] },
  sqs: { queues: [{ name: "world-work" }] },
  s3: { buckets: [{ name: "must-not-be-created-here" }] },
};

function fixture(seed = config) {
  const plugin = awsControlPlanePlugin(awsPlugin);
  assert.equal(plugin.seed, undefined, "the sample seed must not run");
  const server = createServer(plugin, { tokens: {
    [token]: { login: "river", id: 1, scopes: ["iam:*", "sqs:*", "sts:*"] },
    "other-vendor-token": { login: "river", id: 1, scopes: ["repo"] },
  } });
  seedAwsControlPlane(seedFromConfig, server.store, server.baseUrl, seed);
  return server;
}

async function query(app, domain, action, fields = {}, authorization = `Bearer ${token}`) {
  const response = await app.request(`/${domain}/`, { method: "POST", headers: {
    authorization, "content-type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ Action: action, ...fields }) });
  return { status: response.status, body: await response.text() };
}

test("only world-owned IAM and SQS resources are seeded and STS names the current actor", async () => {
  const { app } = fixture();
  const users = await query(app, "iam", "ListUsers");
  assert.equal(users.status, 200);
  assert.deepEqual([...users.body.matchAll(/<UserName>(.*?)<\/UserName>/g)].map(match => match[1]), ["river"]);
  assert.match(users.body, /<Path>\/operators\/<\/Path>/);
  assert.doesNotMatch(users.body, /AKIAIOSFODNN7EXAMPLE|<UserName>admin</);
  const queues = await query(app, "sqs", "ListQueues");
  assert.equal(queues.status, 200);
  assert.match(queues.body, /world-work/);
  assert.doesNotMatch(queues.body, /emulate-default/);
  const identity = await query(app, "sts", "GetCallerIdentity");
  assert.equal(identity.status, 200);
  assert.match(identity.body, /user\/river<\/Arn>/);
  assert.match(identity.body, /<Account>000000000000<\/Account>/);
  assert.match(users.body, /arn:aws:iam::000000000000:user/);
  assert.match(queues.body, /sqs\/000000000000\/world-work/);
});

test("no S3 route is registered, including root paths, writes, HEAD and the upstream inspector", async () => {
  const { app } = fixture();
  for (const path of ["/", "/s3/", "/s3/new-bucket", "/s3/new-bucket/file", "/new-bucket", "/new-bucket/", "/new-bucket/file", "/_inspector"]) {
    for (const method of ["GET", "PUT", "POST", "DELETE", "HEAD"]) {
      const response = await app.request(path, { method, headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.doesNotMatch(await response.text(), /ListAllMyBucketsResult|must-not-be-created-here|emulate-default/);
    }
  }
});

test("missing, upstream sample and non-AWS credentials cannot call AWS routes", async () => {
  const { app } = fixture();
  for (const authorization of ["", "Bearer aws_token", "Bearer test_token_admin", "Bearer other-vendor-token",
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260905/us-east-1/iam/aws4_request, SignedHeaders=host, Signature=0"]) {
    for (const [domain, action] of [["iam", "ListUsers"], ["sqs", "ListQueues"], ["sts", "GetCallerIdentity"]]) {
      const result = await query(app, domain, action, {}, authorization);
      assert.equal(result.status, 403, `${domain}: ${authorization}`);
      assert.match(result.body, /InvalidClientTokenId/);
    }
  }
});

test("normal snapshot restore removes API changes without restoring S3 or sample users", async () => {
  const { app, store } = fixture();
  const baseline = store.snapshot();
  assert.equal((await query(app, "iam", "CreateUser", { UserName: "temporary" })).status, 200);
  assert.match((await query(app, "iam", "ListUsers")).body, /temporary/);
  store.restore(baseline);
  assert.doesNotMatch((await query(app, "iam", "ListUsers")).body, /temporary|<UserName>admin</);
  assert.equal((await app.request("/s3/", { headers: { authorization: `Bearer ${token}` } })).status, 404);
});

test("a declared AWS account with no resources has no fallback users or queues", async () => {
  const { app } = fixture({ account_id: config.account_id, region: config.region, iam: { users: [], roles: [] }, sqs: { queues: [] } });
  assert.doesNotMatch((await query(app, "iam", "ListUsers")).body, /<UserName>/);
  assert.doesNotMatch((await query(app, "sqs", "ListQueues")).body, /<QueueUrl>/);
});

test("world account and region remain consistent for new queues and QueueUrl requests", async () => {
  const { app } = fixture();
  const created = await query(app, "sqs", "CreateQueue", { QueueName: "runtime-work" });
  assert.equal(created.status, 200);
  const queueUrl = created.body.match(/<QueueUrl>([^<]*)<\/QueueUrl>/)[1];
  assert.match(queueUrl, /\/sqs\/000000000000\/runtime-work$/);
  const attributes = await query(app, "sqs", "GetQueueAttributes", { QueueUrl: queueUrl, "AttributeName.1": "All" });
  assert.equal(attributes.status, 200, attributes.body);
  assert.match(attributes.body, /arn:aws:sqs:eu-west-1:000000000000:runtime-work/);
  const sent = await query(app, "sqs", "SendMessage", { QueueUrl: queueUrl, MessageBody: "123456789012 is authored content" });
  assert.equal(sent.status, 200, sent.body);
  const received = await query(app, "sqs", "ReceiveMessage", { QueueUrl: queueUrl });
  assert.match(received.body, /123456789012 is authored content/);
  assert.equal((await query(app, "sqs", "GetQueueAttributes", { QueueUrl: queueUrl.replace("000000000000", "123456789012") })).status, 400);
});

test("AWS seed requires a declared account and region and preserves absent resource sections", () => {
  const received = [], store = {};
  seedAwsControlPlane((_store, _base, value) => received.push(value), store, 'http://aws.test', { account_id: '123400005678', region: 'eu-west-2' });
  assert.deepEqual(received, [{ region: 'eu-west-2' }]);
  seedAwsControlPlane((_store, _base, value) => received.push(value), store, 'http://aws.test', { account_id: '123400005678', region: 'eu-west-2', iam: { users: [], roles: [] }, sqs: { queues: [] } });
  assert.deepEqual(received[1], { region: 'eu-west-2', iam: { users: [], roles: [] }, sqs: { queues: [] } });
  for (const invalid of [undefined, null, [], {}, { account_id: '123400005678' }, { region: 'eu-west-2' },
    { account_id: 'bad', region: 'eu-west-2' }, { account_id: '123400005678', region: 'eu-west-2', iam: null },
    { account_id: '123400005678', region: 'eu-west-2', sqs: [] }]) {
    assert.throws(() => seedAwsControlPlane(() => assert.fail('invalid config must not seed'), store, 'http://aws.test', invalid), /AWS/);
  }
});
