import { surfaceRead } from "./runtime-data.mjs";

// Surface membership is runtime data. This table supplies familiar presentation
// and implemented UI action contracts; it never adds an absent service.
const KNOWN = {
  domain: { label: 'World records', note: 'domain api', group: 'WORLD RECORDS' },
  slack: { label: 'Chat', note: 'slack', group: 'COMMUNICATION' },
  google: { label: 'Gmail', note: 'google api', group: 'COMMUNICATION' },
  mail: { label: 'Local Mail', note: 'smtp + imap', group: 'COMMUNICATION' },
  twilio: { label: 'Twilio', note: 'sms + verify', group: 'COMMUNICATION' },
  resend: { label: 'Resend', note: 'email api', group: 'COMMUNICATION' },
  github: { label: 'Code', note: 'github', group: 'WORK & CONTENT' },
  notion: { label: 'Notion', note: 'rest + mcp', group: 'WORK & CONTENT' },
  linear: { label: 'Linear', note: 'issues', group: 'WORK & CONTENT' },
  s3: { label: 'Files', note: 's3', group: 'WORK & CONTENT' },
  http: { label: 'Website', note: 'http targets', group: 'WORK & CONTENT' },
  stripe: { label: 'Stripe', note: 'payments', group: 'BUSINESS SYSTEMS' },
  okta: { label: 'Okta', note: 'identity', group: 'BUSINESS SYSTEMS' },
  clerk: { label: 'Clerk', note: 'app identity', group: 'BUSINESS SYSTEMS' },
  vercel: { label: 'Vercel', note: 'deployments', group: 'BUSINESS SYSTEMS' },
  mongoatlas: { label: 'MongoDB Atlas', note: 'data', group: 'BUSINESS SYSTEMS' },
};
const ORDER = Object.keys(KNOWN);
export const PRIMARY_SCREENS = ['Overview', 'Worlds', 'Timeline', 'People', 'Activity', 'Target', 'Settings', 'Services'];
const list = value => Array.isArray(value) ? value : [];
const present = value => typeof value === 'string' && value.length > 0;
const known = id => Object.hasOwn(KNOWN, id) ? KNOWN[id] : undefined;

export function serviceScreen(surfaceOrId) {
  const id = typeof surfaceOrId === 'string' ? surfaceOrId : surfaceOrId.id;
  return known(id)?.label ?? `service:${id}`;
}

export function selectedNavigation(data) {
  return list(data?.surfaces).filter(surface => present(surface?.id)).map(surface => {
    const display = known(surface.id);
    return { id: surface.id, label: display?.label ?? surface.name ?? surface.id,
      note: display?.note ?? surface.implementation ?? surface.service ?? '',
      group: display?.group ?? 'SELECTED SERVICES', screen: serviceScreen(surface), surface };
  }).sort((left, right) => {
    const first = ORDER.indexOf(left.id), second = ORDER.indexOf(right.id);
    return (first < 0 ? ORDER.length : first) - (second < 0 ? ORDER.length : second)
      || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
  });
}

export function availableScreen(data, screen) {
  return PRIMARY_SCREENS.includes(screen) || selectedNavigation(data).some(entry => entry.screen === screen || `service:${entry.id}` === screen);
}
export function reconcileScreen(data, screen) { return availableScreen(data, screen) ? screen : 'Overview'; }
export function selectActor(data, currentId) {
  const people = list(data?.people);
  return people.find(person => person.id === currentId) ?? people.find(person => person.primary) ?? people[0] ?? null;
}
export function selectAcceptedActor(data, previousData, currentId) {
  return selectActor(data, runIdentity(data) === runIdentity(previousData) ? currentId : undefined);
}
export function runIdentity(data) {
  if (!data?.world) return '';
  return JSON.stringify([data.world.id, data.world.version, data.world.artifact_sha256 ?? data.world.digest ?? data.acceptedProof ?? '',
    data.session?.generation ?? data.generation ?? data.run?.id ?? data.run?.started_at ?? data.instance?.id ?? '']);
}

const PROVIDER_KEYS = { google: 'gmail', http: 'website' };
const measuredCollection = (value, field) => !value?.collectionStatus?.[field] || value.collectionStatus[field].status === 'complete';
export function serviceBadge(data, id) {
  const providers = data?.providers ?? {}, value = providers[PROVIDER_KEYS[id] ?? id];
  if (!surfaceRead(data, list(data.surfaces).find(surface => surface.id === id) ?? { id }).available) return undefined;
  if (value.status === 'failed' || value.readStatus === 'failed') return undefined;
  const measured = field => measuredCollection(value, field);
  const count = (items, field) => measured(field) && Array.isArray(items) ? items.length : undefined;
  const sum = (...values) => values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : undefined;
  if (id === 'slack') return measured('messageCount') && Number.isFinite(value.messageCount) ? value.messageCount : undefined;
  if (id === 'google') return measured('inbox') && measured('sent') ? sum(value.inbox?.resultSizeEstimate, value.sent?.resultSizeEstimate) : undefined;
  if (id === 'mail') return measured('inbox') && measured('sent') ? sum(value.inbox?.exists, value.sent?.exists) : undefined;
  if (id === 's3') return measured('details') && Array.isArray(value.details) && value.details.every(bucket => Array.isArray(bucket.objects)) ? value.details.reduce((total, bucket) => total + bucket.objects.length, 0) : undefined;
  const field = { github: 'repositories', notion: 'pages', stripe: 'customers', linear: 'issues', okta: 'users', clerk: 'users', twilio: 'phone_numbers', resend: 'emails', vercel: 'projects', mongoatlas: 'projects' }[id];
  return field ? count(value[field], field) : undefined;
}

// An action's run identity is attached by App's callback, not supplied by a
// screen. A late response from an old render cannot complete the new guide.
export function recordAction(state, event, eventRunKey, data) {
  const currentRunKey = runIdentity(data);
  const current = state?.runKey === currentRunKey ? state : { runKey: currentRunKey, actions: [] };
  if (eventRunKey !== currentRunKey || event?.success !== true || !['read', 'write', 'copy', 'probe', 'reset'].includes(event.type)) return current;
  if (event.surface !== undefined && !list(data.surfaces).some(surface => surface.id === event.surface)) return current;
  if (!present(event.target)) return current;
  const action = { type: event.type, target: event.target, ...(event.surface === undefined ? {} : { surface: event.surface }),
    ...(present(event.eventId) ? { eventId: event.eventId } : {}), ...(Array.isArray(event.eventIds) ? { eventIds: event.eventIds.filter(present) } : {}) };
  const sameAction = row => row.type === action.type && row.target === action.target && row.surface === action.surface;
  return { ...current, actions: [...current.actions.filter(row => !sameAction(row)), action] };
}

const READ_CAPABILITIES = {
  domain: ['domain.collections.v1', 'domain.commerce.v1', 'domain.social.v1', 'domain.finance.v1', 'domain.work.v1', 'domain.support.v1'],
  slack: ['slack.messaging.v1'], google: ['google.gmail.v1'], mail: ['mail.imap.v1'],
  github: ['github.repositories.v1', 'github.issues.v1'], s3: ['aws.s3.objects.v1', 'aws.s3.buckets.v1'],
  notion: ['notion.pages-read.v1', 'notion.blocks-read.v1', 'notion.databases.v1', 'notion.users.v1'],
  stripe: ['stripe.customers.v1', 'stripe.catalog.v1'], linear: ['linear.issues.v1', 'linear.teams.v1'],
  okta: ['okta.users.v1', 'okta.groups.v1'], clerk: ['clerk.users.v1', 'clerk.organizations.v1'],
  twilio: ['twilio.messaging.v1', 'twilio.verify.v1'], resend: ['resend.email.v1', 'resend.contacts.v1', 'resend.domains.v1'],
  vercel: ['vercel.projects.v1', 'vercel.teams.v1'], mongoatlas: ['mongoatlas.projects.v1', 'mongoatlas.clusters.v1'],
};
function capabilities(surface) {
  return list(surface.capabilities).map(capability => typeof capability === 'string' ? capability : capability.id ?? capability.profile);
}
function hasCapability(entry, expected) { return capabilities(entry.surface).some(capability => expected.includes(capability)); }

export function guideSteps(data, evidence, { actor = selectActor(data) } = {}) {
  const navigation = selectedNavigation(data), ready = navigation.filter(entry => entry.surface.state === 'ready');
  const actions = evidence?.runKey === runIdentity(data) ? list(evidence.actions) : [];
  const done = (type, target, surface) => actions.some(action => action.type === type && (target === undefined || action.target === target) && (surface === undefined || action.surface === surface));
  const steps = [];
  if (navigation.length) steps.push({ id: 'probe', title: 'Check service readiness', body: 'Run the connection probe and check its result.', target: 'Overview', done: actions.some(action => action.type === 'probe' && action.target === 'services' && action.surface === undefined) });
  if (Object.keys(data?.bindings ?? {}).length) steps.push({ id: 'copy', title: 'Copy connection values', body: 'Copy a current binding for your application.', target: 'Target', done: done('copy', 'bindings') });
  const readable = ready.filter(entry => hasCapability(entry, READ_CAPABILITIES[entry.id] ?? []));
  const read = readable[0];
  if (read) steps.push({ id: 'read', title: `Read from ${read.label}`, body: 'Use Refresh or a read action and wait for a successful API result.', target: read.screen,
    done: done('read', undefined, read.id) });
  const values = data?.providers ?? {};
  const write = actor && ready.find(entry => {
    if (!surfaceRead(data, entry.surface).available) return false;
    if (entry.id === 'domain') return measuredCollection(values.domain, 'collections') && list(values.domain?.collections).some(collection => collection.writable);
    if (entry.id === 'slack') return hasCapability(entry, ['slack.messaging.v1']) && measuredCollection(values.slack, 'channels') && list(values.slack?.channels).length > 0;
    if (entry.id === 'google') return hasCapability(entry, ['google.gmail.v1']) && present(actor.email) && list(data.people).some(person => person.id !== actor.id && present(person.email));
    if (entry.id === 'mail') return hasCapability(entry, ['mail.smtp-submission.v1']) && present(actor.email) && list(data.people).some(person => person.id !== actor.id && present(person.email));
    if (entry.id === 'github') return hasCapability(entry, ['github.issues.v1']) && measuredCollection(values.github, 'repositories') && list(values.github?.repositories).length > 0;
    if (entry.id === 's3') return hasCapability(entry, ['aws.s3.objects.v1']) && measuredCollection(values.s3, 'details') && list(values.s3?.details).length > 0;
    if (entry.id === 'notion') return hasCapability(entry, ['notion.pages-write.v1', 'notion.blocks-write.v1']) && measuredCollection(values.notion, 'pages') && list(values.notion?.pages).length > 0;
    if (entry.id === 'stripe') return hasCapability(entry, ['stripe.customers.v1']) && measuredCollection(values.stripe, 'customers') && list(values.stripe?.customers).length > 0;
    return false;
  });
  if (write) steps.push({ id: 'write', title: `Make a test write in ${write.label}`, body: 'Submit a test change and wait for provider acceptance.', target: write.screen, done: done('write', undefined, write.id) });
  const lastWrite = actions.findLastIndex(action => action.type === 'write' && navigation.some(entry => entry.id === action.surface));
  if (lastWrite >= 0) {
    const eventId = actions[lastWrite].eventId;
    const readIndex = actions.findLastIndex(action => action.type === 'read' && action.target === 'activity');
    steps.push({ id: 'activity', title: eventId ? 'Confirm the accepted event' : 'Read activity after the write', body: eventId ? 'Refresh Activity and find the accepted write event.' : 'Refresh Activity after the accepted write.', target: 'Activity',
      done: readIndex > lastWrite && (!eventId || list(actions[readIndex].eventIds).includes(eventId)) });
  }
  const http = ready.find(entry => entry.id === 'http' && capabilities(entry.surface).some(capability => capability.startsWith('http.')));
  if (http && list(values.website?.targets).length) steps.push({ id: 'http', title: 'Read an HTTP target', body: 'Fetch a declared target and inspect the returned response.', target: http.screen, done: done('read', undefined, 'http') });
  if (navigation.length) steps.push({ id: 'reset', title: 'Restore the starting state', body: 'Reset this run and wait for the accepted starting state check.', target: 'Overview', done: done('reset', 'world') });
  return steps;
}
