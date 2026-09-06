import {createHash} from 'node:crypto';

const rows = value => Array.isArray(value) ? value : [];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Independent source contract for the explicit compatibility adapter. Provider
// projections cannot select their own expected identities or population.
export function legacyBusinessContract(world) {
  return world.profile === 'business.operations/v1'
    && ['communication', 'software', 'finance', 'work', 'support', 'agentic'].every(name => object(world[name]))
    && Array.isArray(world.stories) && rows(world.people).some(row => row.primary) && rows(world.organizations).some(row => row.primary)
    && ['history_months', 'currency', 'customers', 'suppliers', 'anchor_invoices', 'billing_owner_id'].every(name => Object.hasOwn(world.finance, name))
    && ['channels', 'mail'].every(name => Object.hasOwn(world.communication, name))
    && ['projects', 'tasks'].every(name => Object.hasOwn(world.work, name));
}
export function sourceGithubLogin(person) {
  if (!person || typeof person.id !== 'string') throw new Error('Source person has no canonical identity');
  if (person.github_login !== undefined) return person.github_login;
  if (/^[a-z][a-z0-9-]+$/.test(person.id)) return person.id;
  const slug = person.id.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `${slug}-${createHash('sha256').update(person.id).digest('hex').slice(0, 10)}`;
}
export function sourceSlackId(person) {
  if (!person || typeof person.id !== 'string') throw new Error('Source person has no canonical identity');
  return person.slack_id ?? `U${createHash('sha256').update(person.id).digest('hex').slice(0, 10).toUpperCase()}`;
}
export function sourceProviderActor(world, {emailOnly = false} = {}) {
  const people = rows(world.people).filter(person => !emailOnly || person.email);
  const authored = people.find(person => person.primary);
  return {person: authored, selection: authored ? 'authored-primary' : 'none'};
}
export function sourcePrimaryPerson(world, options) {
  return sourceProviderActor(world, options).person;
}
export function sourceProviderPeople(world, {emailOnly = false} = {}) {
  const primaryOrg = rows(world.organizations).find(row => row.primary);
  return rows(world.people).filter(person => (!legacyBusinessContract(world) || person.organization_id === primaryOrg?.id) && (!emailOnly || person.email));
}

// A reader may choose a declared per-person credential to read an API. This
// does not create a generic binding or mark that person as primary.
export function sourceReadCredential({artifact, bindings, credentials, provider}) {
  const token = bindings[`${provider.toUpperCase()}_TOKEN`];
  const person = sourcePrimaryPerson(artifact.world, {emailOnly: !['github', 'slack', 'aws'].includes(provider)});
  if (token) return {token, person, selection: person ? 'authored-primary' : 'bound-service-credential'};
  if (!['google', 'slack', 'notion', 'linear'].includes(provider)) return {selection: 'missing'};
  if (!credentials || !artifact.world.id || credentials.world?.id !== artifact.world.id || String(credentials?.world?.version) !== String(artifact.world.version)) return {selection: 'missing'};
  const references = artifact.projections?.['emulator-overlay']?.tokens ?? {};
  for (const candidate of rows(artifact.world.people)) {
    const reference = `${provider}_token_${candidate.id}`;
    const expectedLogin = provider === 'slack' ? sourceGithubLogin(candidate) : candidate.email;
    const value = credentials.values?.[`token:${reference}`];
    if (expectedLogin && references[reference]?.login === expectedLogin && typeof value === 'string' && value) return {token: value, person: candidate, reference, selection: 'per-person-read'};
  }
  return {selection: 'missing'};
}
