import assert from 'node:assert/strict';
import test from 'node:test';
import {legacyBusinessContract, sourceGithubLogin, sourcePrimaryPerson, sourceProviderActor, sourceProviderPeople, sourceReadCredential, sourceSlackId} from './coupling-source-contracts.mjs';

const legacy = () => ({profile: 'business.operations/v1', organizations: [{id: 'org-a', primary: true}], people: [
  {id: 'person-a', primary: true, organization_id: 'org-a', email: 'a@example.test'}, {id: 'person-b', organization_id: null, email: 'b@example.test'}, {id: 'person-c', organization_id: 'org-a'}],
  communication: {channels: [], mail: []}, software: {}, finance: {history_months: 0, currency: 'EUR', customers: [], suppliers: [], anchor_invoices: [], billing_owner_id: 'person-a'},
  work: {projects: [], tasks: []}, support: {}, agentic: {}, stories: []});

test('provider population follows the explicit compatibility contract, preserving external people in section worlds', () => {
  const world = legacy(); assert.equal(legacyBusinessContract(world), true);
  assert.deepEqual(sourceProviderPeople(world).map(row => row.id), ['person-a', 'person-c']);
  assert.deepEqual(sourceProviderPeople(world, {emailOnly: true}).map(row => row.id), ['person-a']);
  delete world.profile; assert.equal(legacyBusinessContract(world), false);
  assert.deepEqual(sourceProviderPeople(world).map(row => row.id), ['person-a', 'person-b', 'person-c']);
  assert.deepEqual(sourceProviderPeople(world, {emailOnly: true}).map(row => row.id), ['person-a', 'person-b']);
});

test('a profile string alone does not imply all legacy domains or an invented organization', () => {
  const world = {profile: 'business.operations/v1', people: [{id: 'person-a', organization_id: null}]};
  assert.equal(legacyBusinessContract(world), false); assert.deepEqual(sourceProviderPeople(world), world.people);
});

test('current native actor selection requires an authored primary and never selects the first person', () => {
  const world = {people: [{id: 'person-a'}, {id: 'person-b', email: 'b@example.test'}]};
  assert.equal(sourceProviderActor(world).selection, 'none');
  assert.equal(sourcePrimaryPerson(world), undefined); assert.equal(sourcePrimaryPerson(world, {emailOnly: true}), undefined);
  assert.equal(world.people.some(row => Object.hasOwn(row, 'primary')), false);
  world.people[1].primary = true; assert.equal(sourceProviderActor(world).selection, 'authored-primary');
  assert.equal(sourceProviderActor({}).selection, 'none');
});

test('native identifiers retain explicit values and distinguish canonical IDs with the same slug', () => {
  const dot = {id: 'person.47'}, hyphen = {id: 'person-47'};
  assert.match(sourceGithubLogin(dot), /^person-47-[a-f0-9]{10}$/);
  assert.notEqual(sourceGithubLogin(dot), sourceGithubLogin(hyphen));
  assert.equal(sourceGithubLogin(hyphen), 'person-47');
  assert.match(sourceSlackId(dot), /^U[A-F0-9]{10}$/);
  assert.notEqual(sourceSlackId(dot), sourceSlackId(hyphen));
  assert.equal(sourceGithubLogin({...dot, github_login: 'authored-login'}), 'authored-login');
  assert.equal(sourceSlackId({...dot, slack_id: 'UAUTHORED'}), 'UAUTHORED');
  assert.deepEqual(dot, {id: 'person.47'});
});

test('per-person read credentials do not create a default actor or generic binding', () => {
  const person = {id: 'person-a', email: 'a@example.test'}, bindings = {};
  const artifact = {world: {id: 'world-a', version: 'v1', people: [person]}, projections: {'emulator-overlay': {tokens: {linear_token_person_a: {login: person.email}, 'linear_token_person-a': {login: person.email}}}}};
  const credentials = {world: {id: 'world-a', version: 'v1'}, values: {'token:linear_token_person-a': 'personal-unit-credential'}};
  const chosen = sourceReadCredential({artifact, bindings, credentials, provider: 'linear'});
  assert.equal(chosen.selection, 'per-person-read'); assert.equal(chosen.person.id, person.id);
  assert.equal(chosen.token, 'personal-unit-credential'); assert.deepEqual(bindings, {});
  assert.equal(sourceProviderActor(artifact.world).selection, 'none');
  credentials.world.id = 'wrong'; assert.equal(sourceReadCredential({artifact, bindings, credentials, provider: 'linear'}).selection, 'missing');
  credentials.world.id = 'world-a'; artifact.projections['emulator-overlay'].tokens['linear_token_person-a'].login = 'wrong@example.test';
  assert.equal(sourceReadCredential({artifact, bindings, credentials, provider: 'linear'}).selection, 'missing');
  assert.equal(sourceReadCredential({artifact, bindings, provider: 'linear'}).selection, 'missing');
});
