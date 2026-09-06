import { createHash } from 'node:crypto';
import { elapsedMs, clockState } from './clock.mjs';
import { applyRules } from './rules.mjs';
import { appendEvent } from './state.mjs';

export const MAX_CAUSAL_DEPTH = 16;
export const MAX_CAUSAL_EFFECTS = 100;
export function worldNow(db, now = Date.now()) {
  const clock = clockState(db, { now });
  return clock.anchor ? Date.parse(clock.anchor) + clock.elapsed_ms : now;
}
function ancestry(db, event) {
  const rules = new Set(), seen = new Set();
  let current = event, depth = 0;
  while (current) {
    if (seen.has(current.id) || ++depth > MAX_CAUSAL_DEPTH) return { valid: false, rules, depth };
    seen.add(current.id);
    const evidence = typeof current.provider_evidence === 'string' ? JSON.parse(current.provider_evidence) : current.provider_evidence;
    if (evidence?.causal_rule) rules.add(evidence.causal_rule);
    if (current.caused_by?.startsWith('cmd_')) return { valid: true, rules, depth };
    if (!current.caused_by) return { valid: false, rules, depth };
    current = db.prepare('SELECT * FROM events WHERE id = ?').get(current.caused_by);
  }
  return { valid: false, rules, depth };
}
export function queueEffects(db, event, { world, rules = [], now = Date.now() }) {
  const chain = ancestry(db, event);
  if (!chain.valid) return [];
  const emissions = applyRules(rules, event, { world });
  const queued = [];
  for (const [index, emission] of emissions.entries()) {
    const effectId = `effect-${createHash('sha256').update(`${event.id}/${emission.rule}/${index}`).digest('hex').slice(0, 32)}`;
    if (chain.rules.has(emission.rule) || chain.depth >= MAX_CAUSAL_DEPTH || index >= MAX_CAUSAL_EFFECTS) {
      if (db.prepare('SELECT id FROM events WHERE id = ?').get(`rejected-${effectId}`)) continue;
      appendEvent(db, { id: `rejected-${effectId}`, type: 'world.causal.effect.rejected.v1', source: 'runtime',
        occurred_at: new Date(worldNow(db, now)).toISOString(), provider_evidence: { rule: emission.rule, reason: 'Causal cycle or emission limit' }, caused_by: event.id });
      continue;
    }
    const due = elapsedMs(db, now) + emission.after_ms;
    db.prepare(`INSERT INTO scheduled_events(id,due_at,type,payload,caused_by,delivered_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(id) DO NOTHING`)
      .run(effectId, due, 'world.causal.effect.v1', JSON.stringify(emission), event.id);
    queued.push({ id: effectId, type: emission.type, due_at: due, status: 'queued', caused_by: event.id });
  }
  return queued;
}
export async function deliverEffect(db, emission, context) {
  const now = context.now?.() ?? Date.now();
  let result;
  if (emission.type === 'mail.notification.requested.v1') {
    const { deliver } = await import('./commands.mjs');
    result = await deliver(db, emission, { ...context, clock: () => worldNow(db, now) });
  } else {
    const { executeDomainOperation } = await import('./domain-operations.mjs');
    result = await executeDomainOperation(db, { api_version: 'worldfixture.runtime-operation/v1', type: emission.type, ...emission.payload },
      { ...context, existingCommandId: context.commandId, causedBy: emission.caused_by, causalRule: emission.rule });
  }
  return { status: 'delivered', ...result };
}
