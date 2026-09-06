// Live AWS regression: immutable artifact inputs, public APIs, normal CLI reset.
// Usage: node tests/image/coupling-aws-test.mjs --image IMAGE --report DIR
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverArtifacts, loadArtifact, snapshotArtifact } from './coupling-artifacts.mjs';
import { paginate, probeWorld } from './coupling-probes.mjs';
import { sourceGithubLogin } from './coupling-source-contracts.mjs';
import { s3Fetch } from '../../runtime/src/s3-signing.mjs';
import { containerArguments, credentialValues, docker, mappedBindings, pauseRunClock,
  readRunBindings, readRunCredentialSet, redact, removeOwnedContainer, responseInventory,
  waitForReady } from './coupling-runner.mjs';

const options = { image: 'worldfixture:coupling-p2-aws', report: join(tmpdir(), `wf-aws-${randomUUID()}`) };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.slice(2);
  if (!['image', 'report'].includes(key) || !process.argv[index + 1]) throw new Error('Expected --image IMAGE and --report DIR');
  options[key] = process.argv[index + 1];
}
const reportRoot = resolve(options.report);
mkdirSync(reportRoot, { recursive: true });
if (existsSync(join(reportRoot, 'report.json'))) throw new Error('Refusing to overwrite an existing report');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (name, value) => writeFileSync(join(reportRoot, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const [imageInfo] = JSON.parse((await docker(['image', 'inspect', options.image])).stdout);
const report = { scope: 'AWS IAM/SQS/STS, S3 isolation and reset; not full P2 validation',
  started: new Date().toISOString(), image: { tag: options.image, id: imageInfo.Id }, worlds: [] };
const secrets = [];
const save = () => write('report.json', redact(report, secrets));
let inputs;
if (existsSync(join(reportRoot, 'inputs.json'))) inputs = read(join(reportRoot, 'inputs.json'));
else {
  inputs = [];
  mkdirSync(join(reportRoot, 'inputs'));
  for (const path of await discoverArtifacts(resolve('dist'))) {
    const artifact = await loadArtifact(path);
    const label = `${artifact.identity.id}.${artifact.identity.version}`;
    await snapshotArtifact(path, join(reportRoot, 'inputs', label));
    inputs.push({ label, identity: artifact.identity, input: `inputs/${label}` });
  }
  write('inputs.json', inputs);
}
const decode = text => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const field = (xml, tag) => decode(xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '');
const members = xml => [...xml.matchAll(/<member>([\s\S]*?)<\/member>/g)].map(match => match[1]);
const sort = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
save();
for (const input of inputs) {
  const owner = randomUUID();
  const name = `wf-aws-${owner}`;
  const result = { label: input.label, identity: input.identity, checks: [], responses: [] };
  report.worlds.push(result);
  const check = (label, expected, actual, detail) => {
    try { assert.deepEqual(actual, expected); result.checks.push({ check: label, status: 'passed', ...(detail ? { detail } : {}) }); }
    catch { result.checks.push({ check: label, status: 'failed', expected, actual, ...(detail ? { detail } : {}) }); }
  };
  let bindings;
  const responses = [];
  try {
    const artifactPath = resolve(reportRoot, input.input);
    assert.ok(artifactPath.startsWith(`${reportRoot}/inputs/`), 'Input must be an owned snapshot');
    const artifact = await loadArtifact(artifactPath);
    assert.deepEqual(artifact.identity, input.identity);
    assert.ok(artifact.checks.every(entry => entry.status === 'passed'), 'Frozen artifact verification failed');
    result.checks.push({ check: 'immutable-input', status: 'passed', digest: artifact.identity.digest });
    secrets.push(...credentialValues(artifact));
    await docker([...containerArguments({ image: imageInfo.Id, artifactPath, name, owner,
      exposedPorts: Object.keys(imageInfo.Config.ExposedPorts ?? {}) }), '--only', 'providers,s3']);
    await waitForReady(name);
    await pauseRunClock(name);
    const [inspection] = JSON.parse((await docker(['inspect', name])).stdout);
    // Docker may expose the image config digest while the selected immutable ID
    // is a manifest-list digest. Keep both proofs, and verify Config.Image input.
    result.containerImage = { requested: inspection.Config.Image, resolved: inspection.Image };
    check('immutable-image-request', imageInfo.Id, inspection.Config.Image);
    const refresh = async () => {
      const credentials = await readRunCredentialSet(name);
      secrets.push(...Object.values(credentials.values ?? {}));
      const raw = await readRunBindings(name);
      secrets.push(...credentialValues(raw));
      bindings = mappedBindings(raw, inspection.NetworkSettings.Ports);
    };
    await refresh();
    const lock = JSON.parse((await docker(['exec', name, 'cat', '/state/environment.lock.json'])).stdout);
    check('locked-world', { id: input.identity.id, version: input.identity.version, digest: input.identity.digest },
      { id: lock.world.id, version: lock.world.version, digest: lock.world.artifact_sha256 });
    const request = async (domain, action, args = {}, authorization = `Bearer ${bindings.AWS_TOKEN}`) => {
      const path = `/${domain}/`;
      const response = await fetch(`${bindings.AWS_BASE_URL.replace(/\/$/, '')}${path}`, { method: 'POST',
        signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/x-www-form-urlencoded', ...(authorization ? { authorization } : {}) },
        body: new URLSearchParams({ Action: action, Version: { iam: '2010-05-08', sqs: '2012-11-05', sts: '2011-06-15' }[domain], ...args }) });
      const body = await response.text();
      responses.push({ provider: 'aws', path: `${path}?Action=${action}`, status: response.status, body });
      return { status: response.status, body };
    };
    const query = async (...args) => {
      const response = await request(...args);
      assert.equal(response.status, 200, `${args[1]} HTTP status`);
      assert.ok(response.body.includes(`<${args[1]}Result>`), `${args[1]} result absent`);
      return response.body;
    };
    const list = (domain, action, items) => paginate(cursor => query(domain, action,
      { MaxItems: '2', MaxResults: '2', ...(cursor ? { [domain === 'iam' ? 'Marker' : 'NextToken']: cursor } : {}) }),
    { items, next: xml => {
      const cursor = field(xml, domain === 'iam' ? 'Marker' : 'NextToken');
      if (field(xml, 'IsTruncated') === 'true' && !cursor) throw new Error('Truncated AWS list has no continuation');
      return cursor;
    } });
    const snapshot = async () => ({
      users: sort(await list('iam', 'ListUsers', xml => members(xml).map(row => Object.fromEntries(['UserName', 'Path', 'UserId', 'Arn', 'CreateDate'].map(key => [key, field(row, key)]))))),
      roles: sort(await list('iam', 'ListRoles', xml => members(xml).map(row => Object.fromEntries(['RoleName', 'Path', 'RoleId', 'Arn', 'CreateDate', 'Description'].map(key => [key, field(row, key)]))))),
      queues: sort(await list('sqs', 'ListQueues', xml => [...xml.matchAll(/<QueueUrl>([^<]*)<\/QueueUrl>/g)].map(match => decode(match[1])))),
    });
    const sourceReads = async phase => {
      const probes = await probeWorld({ artifact: { ...artifact, projections: { aws: artifact.projections.aws } },
        bindings: Object.fromEntries(['AWS_BASE_URL', 'AWS_TOKEN', 'S3_BASE_URL', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION'].map(key => [key, bindings[key]])) });
      result.checks.push(...probes.checks.map(entry => ({ ...entry, check: `${phase}.${entry.check}` })));
      responses.push(...probes.responses);
    };
    result.expectationOrigins = { operators: 'Frozen source operator team/ID union and declared limit',
      roles: artifact.world.software.service_roles ? 'Frozen source service_roles' : 'No authored role collection',
      queues: artifact.world.software.queues ? 'Frozen source queues' : 'No authored queue collection',
      pagination: 'Follow every advertised continuation; server may ignore requested small page size' };
    await sourceReads('before');
    const before = await snapshot();
    result.operatorCount = before.users.length;
    const primary = artifact.world.people.find(person => person.primary);
    const actor = await query('sts', 'GetCallerIdentity');
    const account = artifact.projections.aws.account_id;
    assert.match(account, /^\d{12}$/, 'The frozen AWS projection must declare its account');
    const primaryLogin = sourceGithubLogin(primary);
    check('sts.source-actor', `arn:aws:iam::${account}:user/${primaryLogin}`, field(actor, 'Arn'));
    check('sts.account', account, field(actor, 'Account'));
    const actorUser = before.users.find(user => user.UserName === primaryLogin);
    if (actorUser) check('sts.user-id', actorUser.UserId, field(actor, 'UserId'));
    assert.ok(bindings.GOOGLE_TOKEN, 'A real non-AWS credential is required');
    for (const [label, auth] of [['absent', null], ['invalid', 'Bearer invalid-worldfixture-aws'],
      ['sample', 'Bearer aws_token'], ['upstream-sample', 'Bearer test_token_admin'], ['non-aws', `Bearer ${bindings.GOOGLE_TOKEN}`],
      ['sample-signature', 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260905/us-east-1/iam/aws4_request, SignedHeaders=host, Signature=0']]) {
      for (const [domain, action] of [['iam', 'ListUsers'], ['sqs', 'ListQueues'], ['sts', 'GetCallerIdentity']]) {
        const response = await request(domain, action, {}, auth);
        check(`auth.${label}.${domain}`, { status: 403, code: 'InvalidClientTokenId' }, { status: response.status, code: field(response.body, 'Code') });
      }
    }
    for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'HEAD']) {
      for (const path of ['/', '/s3', '/s3/', '/s3/new-bucket', '/s3/new-bucket/file', '/new-bucket', '/new-bucket/', '/new-bucket/file', '/_inspector']) {
        const response = await fetch(`${bindings.AWS_BASE_URL.replace(/\/$/, '')}${path}`, { method, signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${bindings.AWS_TOKEN}` } });
        const body = await response.text();
        responses.push({ provider: 'aws', path: `${method} ${path}`, status: response.status, body });
        // S3 itself returns 404 for unknown buckets. That is not route absence.
        check(`route-absent.${method}.${path}`, { status: 404, s3Xml: false },
          { status: response.status, s3Xml: /<(?:Error|ListBucketResult|ListAllMyBucketsResult|CreateBucketResult)(?:\s|>)/.test(body) });
      }
    }
    const temporary = `wf-reset-${owner.slice(0, 12)}`;
    const notion = async (path, init = {}) => {
      const response = await fetch(`${bindings.NOTION_BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${bindings.NOTION_TOKEN}`, 'Notion-Version': '2026-03-11', ...init.headers } });
      const body = await response.text();
      responses.push({ provider: 'notion', path, status: response.status, body });
      return { status: response.status, body: JSON.parse(body) };
    };
    const created = await notion('/v1/file_uploads', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'multi_part', filename: `${temporary}.txt`, content_type: 'text/plain', number_of_parts: 2 }) });
    assert.equal(created.status, 200, 'Notion multipart upload creation');
    const uploadId = created.body.id;
    for (const [index, content] of ['signed ', 'object store'].entries()) {
      const form = new FormData();
      form.set('file', new Blob([content], { type: 'text/plain' }), `${temporary}.txt`);
      form.set('part_number', String(index + 1));
      const part = await notion(`/v1/file_uploads/${uploadId}/send`, { method: 'POST', body: form });
      check(`notion.signed-part.${index + 1}`, 200, part.status);
    }
    const completed = await notion(`/v1/file_uploads/${uploadId}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('notion.signed-get-put-delete', { status: 200, upload: 'uploaded' }, { status: completed.status, upload: completed.body.status });
    const storage = artifact.projections.notion.object_store;
    const objectPath = `/${storage.bucket}/${storage.prefix}/${uploadId}/${temporary}.txt`;
    const readObject = async path => {
      const response = await s3Fetch(`${bindings.S3_BASE_URL}${path}`, { signal: AbortSignal.timeout(30000) }, bindings);
      const body = await response.text();
      responses.push({ provider: 's3', path, status: response.status, body });
      return { status: response.status, body };
    };
    check('notion.exact-object-bytes', { status: 200, body: 'signed object store' }, await readObject(objectPath));
    for (const part of ['00001', '00002']) check(`notion.part-removed.${part}`, 404, (await readObject(`${objectPath}.parts/${part}`)).status);
    await query('iam', 'CreateUser', { UserName: temporary, Path: '/test/' });
    const createdQueue = field(await query('sqs', 'CreateQueue', { QueueName: temporary }), 'QueueUrl');
    const changed = await snapshot();
    check('mutation.user-visible', true, changed.users.some(user => user.UserName === temporary));
    check('mutation.queue-visible', true, changed.queues.includes(createdQueue));
    check('mutation.only-one-user', before.users.length + 1, changed.users.length);
    check('mutation.only-one-queue', before.queues.length + 1, changed.queues.length);
    const reset = await docker(['exec', name, 'node', 'runtime/bin/worldfixture.mjs', 'reset', '--state', '/state'], { timeout: 180000 });
    result.resetOutput = reset.stdout + reset.stderr;
    await pauseRunClock(name);
    await refresh();
    check('reset.exact-api-records', before, await snapshot());
    check('reset.notion-upload-removed', 404, (await notion(`/v1/file_uploads/${uploadId}`)).status);
    check('reset.notion-object-removed', 404, (await readObject(objectPath)).status);
    await sourceReads('after-reset');
    const afterArtifact = await loadArtifact(artifactPath);
    check('input-unchanged', input.identity, afterArtifact.identity);
    check('input-hashes-still-valid', true, afterArtifact.checks.every(entry => entry.status === 'passed'));
  } catch (error) {
    result.checks.push({ check: 'case-completed', status: 'failed', detail: error.message });
  } finally {
    try {
      const logs = await docker(['logs', '--tail', '300', name]);
      writeFileSync(join(reportRoot, `${input.label}.log`), redact(logs.stdout + logs.stderr, secrets), { mode: 0o600 });
    } catch (error) { result.logCaptureError = error.message; }
    result.responses = responseInventory(responses);
    try { await removeOwnedContainer(name, owner, args => docker(args, { timeout: 120000 })); }
    catch (error) { result.checks.push({ check: 'owned-container-cleanup', status: 'failed', detail: error.message }); }
    result.status = result.checks.some(entry => entry.status === 'failed') ? 'failed' : 'passed';
    save();
    console.log(`${result.status.toUpperCase()} ${input.label}: ${result.checks.length} checks, ${result.responses.length} responses`);
  }
}
report.finished = new Date().toISOString();
report.status = report.worlds.length && report.worlds.every(world => world.status === 'passed') ? 'passed' : 'failed';
save();
console.log(`Report: ${reportRoot}`);
process.exitCode = report.status === 'passed' ? 0 : 1;
