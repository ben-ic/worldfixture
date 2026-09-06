import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { worldPathValue } from './capability-world.mjs';
import { validateExecutableRules } from './rules.mjs';
import { DOMAIN_OPERATIONS, operationErrors } from './domain-operations.mjs';
import { validateRecord } from '../../emulators/domain/src/validation.mjs';

const EVENT_TYPES = new Set(['communication.message.sent.v1','mail.message.received.v1','mail.notification.delivered.v1','software.issue.commented.v1','finance.payment.recorded.v1','storage.object.written.v1','integration.webhook.delivered.v1','application.event.delivered.v1','commerce.order.placed.v1','domain.record.created.v1','domain.record.updated.v1','domain.record.deleted.v1']);

export const ARRIVAL_CAPABILITIES = {
  'chat-message': ['slack.messaging.v1'], 'github-comment': ['github.issues.v1', 'github.repositories.v1'],
  'stripe-payment': ['stripe.customers.v1'], 's3-object': ['aws.s3.objects.v1'], 'domain-operation': ['domain.collections.v1'],
};
export function arrivalCapabilities(arrival) {
  if (arrival.kind === 'incoming-email') return [arrival.payload?.via === 'gmail' ? 'google.gmail.v1' : 'mail.smtp-submission.v1'];
  return ARRIVAL_CAPABILITIES[arrival.kind] ?? [];
}
export function emissionCapabilities(type) {
  if (type === 'mail.notification.requested.v1') return ['mail.smtp-submission.v1'];
  if (DOMAIN_OPERATIONS[type]) return ['domain.collections.v1'];
  return null;
}
function sourceCollections(world, artifactPath) {
  if (artifactPath && existsSync(join(artifactPath, 'projections/domain.json'))) {
    const domain = JSON.parse(readFileSync(join(artifactPath, 'projections/domain.json'), 'utf8'));
    return structuredClone(domain.collections ?? {});
  }
  const values = { 'identity.people': world.people ?? [], 'identity.organizations': world.organizations ?? [] };
  for (const section of ['commerce', 'social', 'support', 'work', 'finance']) {
    for (const [key, rows] of Object.entries(world[section] ?? {})) if (Array.isArray(rows)) values[`${section}.${key}`] = structuredClone(rows);
  }
  return values;
}
export function executionPreflight(world, { capabilities, artifactPath, rules = [], allowUnselected = false, applicationTarget, deferApplicationConnection = false } = {}) {
  const selected = new Set(Array.isArray(capabilities) ? capabilities : Object.keys(capabilities ?? {}));
  const errors = [], excluded = [], active = [], activeRules = [], diagnostics = [];
  const pendingArrivals = [], pendingRules = [];
  if (typeof deferApplicationConnection !== 'boolean') errors.push('deferApplicationConnection must be a boolean');
  if (!Array.isArray(rules)) { errors.push('Causal rules must be an array'); rules = []; }
  const timeline = Array.isArray(world.timeline) ? world.timeline : [];
  if (!Array.isArray(world.timeline)) errors.push(`${world.id}:${world.version}: timeline must be an array with at least one authored arrival`);
  else if (!timeline.length) errors.push(`${world.id}:${world.version}: timeline must contain at least one authored arrival; add a supported event`);
  const validTimeline = timeline.filter((arrival, index) => {
    if (arrival && typeof arrival === 'object' && !Array.isArray(arrival)) return true;
    errors.push(`${world.id}:${world.version}: timeline entry ${index} must be an object`); return false;
  });
  const people = new Map((world.people ?? []).map(person => [person.id, person]));
  const channels = world.communication?.channels ?? [];
  const collections = sourceCollections(world, artifactPath);
  const get = (collection, id) => (collections[collection] ?? []).find(row => row.id === id) ?? null;
  const has = profiles => profiles.some(profile => selected.has(profile));
  const ids = new Set();
  for (const arrival of [...validTimeline].sort((a, b) => a.after_seconds - b.after_seconds || String(a.id).localeCompare(String(b.id)))) {
    const label = `${world.id}:${world.version} arrival ${arrival.id}`, fail = message => errors.push(`${label}: ${message}`), payload = arrival.payload;
    if (!arrival.id || ids.has(arrival.id)) fail('missing or repeated arrival ID');
    ids.add(arrival.id);
    if (!Number.isSafeInteger(arrival.after_seconds) || arrival.after_seconds < 0 || !Number.isSafeInteger(arrival.after_seconds * 1000)) fail('after_seconds must be a nonnegative integer');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { fail('payload must be an object'); continue; }
    const person = field => { if (!people.has(payload[field])) fail(`${field} does not name a declared person`); };
    const string = field => { if (typeof payload[field] !== 'string') fail(`${field} must be a string`); };
    switch (arrival.kind) {
      case 'incoming-email':
        person('from_id'); person('to_id');
        if (payload.via !== undefined && !['smtp', 'gmail'].includes(payload.via)) fail('via must be smtp or gmail');
        for (const field of ['subject', 'body_text', 'snippet']) if (payload[field] !== undefined) string(field);
        if (payload.labels !== undefined && (!Array.isArray(payload.labels) || payload.labels.some(label => typeof label !== 'string' || !label))) fail('labels must be nonempty strings');
        break;
      case 'chat-message':
        person('author_id'); string('text');
        if (!channels.some(row => row.id === payload.channel_id || row.name === payload.channel_id)) fail('channel_id does not name a declared channel');
        break;
      case 'github-comment': {
        string('body'); if (payload.author_id !== undefined) person('author_id');
        const found = (world.software?.repositories ?? []).some(repo =>
          (!payload.repository_id || repo.id === payload.repository_id) && (repo.issues ?? []).some(issue =>
            issue.id === payload.issue_id || (issue.number === payload.issue_number && repo.name === payload.repository && world.organizations?.some(org => org.id === repo.owner_id && org.slug === payload.owner))));
        if (!found) fail('issue reference does not name a declared repository issue');
        break;
      }
      case 'stripe-payment': {
        if (!Number.isSafeInteger(payload.amount_cents) || payload.amount_cents <= 0) fail('amount_cents must be a positive exact integer');
        if (typeof payload.currency !== 'string' || !/^[A-Za-z]{3}$/.test(payload.currency)) fail('currency must be explicit');
        if (payload.customer_id && !world.finance?.customers?.some(row => row.id === payload.customer_id)) fail('customer_id does not name a declared customer');
        if (payload.invoice_id !== undefined) {
          const invoice = (world.finance?.resolved?.invoices ?? world.finance?.invoices ?? []).find(row => row.id === payload.invoice_id);
          if (!invoice) fail('invoice_id does not name a declared invoice');
          else {
            if (invoice.status === 'paid') fail('invoice_id is already paid at the baseline');
            if (payload.customer_id && invoice.customer_id !== payload.customer_id) fail('invoice_id belongs to another customer');
            if (invoice.amount_cents !== payload.amount_cents || (invoice.currency ?? world.finance?.currency)?.toLowerCase() !== payload.currency?.toLowerCase()) fail('invoice amount or currency does not match the settlement');
          }
        }
        break;
      }
      case 's3-object': {
        string('bucket'); string('key');
        if (payload.author_id !== undefined) person('author_id');
        if (artifactPath && existsSync(join(artifactPath, 'projections/aws.json'))) {
          const aws = JSON.parse(readFileSync(join(artifactPath, 'projections/aws.json'), 'utf8'));
          if (!(aws.s3?.buckets ?? []).some(bucket => (bucket.name ?? bucket.bucket) === payload.bucket)) fail('bucket is not declared in the selected S3 projection');
        }
        break;
      }
      case 'domain-operation': {
        for (const error of operationErrors(payload, world)) fail(error);
        const operation = DOMAIN_OPERATIONS[payload.type];
        if (operation && payload.record) {
          try {
            if (get(operation.collection, payload.record.id)) throw new Error('record.id already exists before this operation');
            validateRecord(operation.collection, payload.record, get);
            (collections[operation.collection] ??= []).push(structuredClone(payload.record));
          } catch (error) { fail(`${error.field ? `${error.field}: ` : ''}${error.message}`); }
        }
        break;
      }
      case 'application-event':
        string('kind');
        if (deferApplicationConnection === true && applicationTarget === undefined) pendingArrivals.push(arrival.id);
        else {
          try { if (!['http:', 'https:'].includes(new URL(applicationTarget).protocol)) fail('application-event requires a configured HTTP application connector'); }
          catch { fail('application-event requires a configured HTTP application connector'); }
        }
        if (payload.actor?.worldfixture_ref && !people.has(payload.actor.worldfixture_ref)) fail('actor.worldfixture_ref does not name a declared person');
        break;
      case 'webhook':
        if (payload.url !== undefined) { try { if (!['http:', 'https:'].includes(new URL(payload.url).protocol)) fail('url must use HTTP'); } catch { fail('url must be an absolute HTTP URL'); } }
        break;
      default: fail(`unknown executable kind ${JSON.stringify(arrival.kind)}`);
    }
    const required = arrivalCapabilities(arrival);
    if (required.length && !has(required)) {
      if (allowUnselected) excluded.push({ id: arrival.id, kind: arrival.kind, reason: `Capability not selected: ${required.join(' or ')}` });
      else fail(`required capability is not selected: ${required.join(' or ')}`);
    } else active.push(arrival.id);
  }
  errors.push(...validateExecutableRules(rules));
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
    if (rule.execution === 'descriptive') { diagnostics.push({ id: rule.id, status: 'descriptive', reason: rule.reason }); continue; }
    const origin = rule.when?.startsWith('communication.message.') ? ['slack.messaging.v1']
      : rule.when?.startsWith('software.issue.') ? ['github.issues.v1','github.repositories.v1']
      : rule.when?.startsWith('finance.payment.') ? ['stripe.customers.v1']
      : rule.when?.startsWith('storage.object.') ? ['aws.s3.objects.v1']
      : rule.when?.startsWith('domain.') || rule.when?.startsWith('commerce.order.') ? ['domain.collections.v1']
      : rule.when?.startsWith('mail.notification.') ? ['mail.smtp-submission.v1']
      : rule.when === 'mail.message.received.v1' ? ['mail.smtp-submission.v1', 'google.gmail.v1'] : [];
    let pendingApplication = false;
    if (rule.when === 'application.event.delivered.v1' && !applicationTarget) {
      if (deferApplicationConnection === true && applicationTarget === undefined) pendingApplication = true;
      else errors.push(`Rule ${rule.id}: application event requires a configured connector`);
    }
    let available = !origin.length || has(origin);
    if (!available && !allowUnselected) errors.push(`Rule ${rule.id}: originating capability is not selected: ${origin.join(' or ')}`);
    if (!EVENT_TYPES.has(rule.when)) errors.push(`Rule ${rule.id}: unsupported runtime event ${rule.when}; classify nonexecuting rules as descriptive`);
    const inspectTerms = term => {
      if (!term || typeof term !== 'object') return;
      if (term.lookup) {
        const rows = worldPathValue(world, term.lookup.collection ?? '');
        if (!Array.isArray(rows)) errors.push(`Rule ${rule.id}: lookup collection ${term.lookup.collection} is not declared`);
        inspectTerms(term.lookup.match?.value);
      } else if (!Object.hasOwn(term, 'value')) for (const value of Object.values(term)) inspectTerms(value);
    };
    for (const emission of rule.emit ?? []) inspectTerms(emission.with);
    for (const emission of rule.emit ?? []) {
      const required = emissionCapabilities(emission.type);
      if (!required) errors.push(`Rule ${rule.id}: unsupported executable emission ${emission.type}`);
      else if (!has(required)) {
        available = false;
        if (!allowUnselected) errors.push(`Rule ${rule.id}: required capability is not selected: ${required.join(' or ')}`);
      }
    }
    if (available) { activeRules.push(rule); if (pendingApplication) pendingRules.push(rule.id); }
    else diagnostics.push({ id: rule.id, status: 'not-selected', reason: 'Required rule capability is not selected' });
  }
  const applicationConnection = pendingArrivals.length || pendingRules.length ? {
    status: 'pending', required: true, arrival_ids: pendingArrivals, rule_ids: pendingRules,
    reason: 'Switched setup requires an explicitly confirmed application connector',
  } : undefined;
  return { errors, timeline: { active, excluded }, rules: activeRules, ruleDiagnostics: diagnostics, applicationConnection };
}
