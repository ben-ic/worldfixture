import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendEvent } from './state.mjs';
import { validate } from './schema.mjs';
import { queueEffects, worldNow } from './causal-queue.mjs';

const OPERATION_SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/runtime-operation.v1.schema.json', import.meta.url), 'utf8'));
export const DOMAIN_OPERATIONS = {
  'commerce.order.place.v1': { collection: 'commerce.orders', event: 'commerce.order.placed.v1' },
  'social.post.publish.v1': { collection: 'social.posts', event: 'domain.record.created.v1' },
  'social.review.publish.v1': { collection: 'social.reviews', event: 'domain.record.created.v1' },
  'social.comment.publish.v1': { collection: 'social.comments', event: 'domain.record.created.v1' },
};
export function operationErrors(operation, world) {
  const errors = validate(operation, OPERATION_SCHEMA);
  if (!world.people?.some(person => person.id === operation.actor_id)) errors.push('actor_id does not name a declared world person');
  return errors;
}
export async function executeDomainOperation(db, operation, context) {
  const { world, bindings, rules = [], fetchImpl = fetch, existingCommandId, causedBy, causalRule } = context;
  const descriptor = DOMAIN_OPERATIONS[operation.type];
  let action;
  if (descriptor) {
    const errors = operationErrors(operation, world);
    if (errors.length) throw new Error(errors.join('; '));
    action = { method: 'POST', collection: descriptor.collection, actor_id: operation.actor_id, record: operation.record };
  } else if (['POST', 'PATCH', 'DELETE'].includes(operation.method)) action = operation;
  else throw new Error(`Unsupported domain operation ${JSON.stringify(operation.type)}`);
  if (!world.people?.some(person => person.id === action.actor_id)) throw new Error('Domain action actor_id must name a declared world person');
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(action.collection ?? '')) throw new Error('Invalid domain collection');
  if (action.method !== 'POST' && (typeof action.recordId !== 'string' || !action.recordId)) throw new Error('Domain update or delete needs recordId');
  if (!bindings.DOMAIN_BASE_URL || !bindings.DOMAIN_TOKEN) throw new Error('Domain action requires selected domain.collections.v1');
  const now = context.now?.() ?? Date.now();
  const command = { id: existingCommandId ?? `cmd_${randomUUID().replaceAll('-', '')}`, type: descriptor ? operation.type : `domain.record.${action.method.toLowerCase()}.v1`, actor_id: action.actor_id };
  if (!existingCommandId) db.prepare(`INSERT INTO commands(id,type,actor_id,target,input,status,submitted_at) VALUES(?,?,?,?,?,'submitted',?)`)
    .run(command.id, command.type, action.actor_id, JSON.stringify({ collection: action.collection, record_id: action.recordId }), JSON.stringify(action), now);
  try {
    const body = { actor_id: action.actor_id, ...(action.method === 'POST' ? { record: action.record } : action.method === 'PATCH' ? { patch: action.patch } : {}) };
    const path = `/v1/collections/${encodeURIComponent(action.collection)}${action.method === 'POST' ? '' : `/${encodeURIComponent(action.recordId)}`}`;
    const response = await fetchImpl(`${bindings.DOMAIN_BASE_URL.replace(/\/$/, '')}${path}`, { method: action.method,
      headers: { authorization: `Bearer ${bindings.DOMAIN_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let result; try { result = await response.json(); } catch { throw new Error('Domain API returned invalid JSON'); }
    if (!response.ok || result.ok !== true) {
      const message = String(result.error?.message ?? result.error?.code ?? 'Invalid domain response').replaceAll(bindings.DOMAIN_TOKEN, '[redacted]');
      const error = new Error(`Domain ${action.method} failed: ${message}`);
      error.status = response.status; error.code = result.error?.code ?? 'invalid_response'; error.field = result.error?.field;
      throw error;
    }
    const expectedType = descriptor?.event ?? (action.method === 'POST' ? action.collection === 'commerce.orders' ? 'commerce.order.placed.v1' : 'domain.record.created.v1' : action.method === 'PATCH' ? 'domain.record.updated.v1' : 'domain.record.deleted.v1');
    if (result.event?.type !== expectedType || !result.event.id || result.event.collection !== action.collection
      || result.event.actor_id !== action.actor_id || result.event.world?.id !== world.id || result.event.world?.version !== world.version
      || result.event.record_id !== (action.record?.id ?? action.recordId)) throw new Error('Domain API acceptance evidence does not match the requested operation');
    const event = { id: `evt_${randomUUID().replaceAll('-', '')}`, type: result.event.type, actor_id: action.actor_id, source: 'domain',
      occurred_at: new Date(worldNow(db, now)).toISOString(), caused_by: causedBy ?? command.id,
      provider_evidence: { event_id: result.event.id, seq: result.event.seq, collection: action.collection, record_id: result.event.record_id,
        before: result.event.before, after: result.event.after, provenance: result.event.provenance, ...(causalRule ? { causal_rule: causalRule } : {}) } };
    appendEvent(db, event);
    db.prepare("UPDATE commands SET status='accepted',event_id=? WHERE id=?").run(event.id, command.id);
    const effects = queueEffects(db, event, { world, rules, now });
    return { ok: true, record: result.record, event, command, effects };
  } catch (error) {
    db.prepare("UPDATE commands SET status='failed',failure=? WHERE id=?").run(error.message, command.id);
    throw error;
  }
}
