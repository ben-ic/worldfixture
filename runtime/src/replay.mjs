// Turning a world event into an application event.
//
// WHY THIS EXISTS. The headline capability of this product is that something
// happens in the world and arrives in your application. The runtime observes
// world events and the connector accepts application events, and until now
// nothing joined them: `worldfixture events` printed one shape, `connector event
// --file` demanded another, and no command, flag or button converted between
// them. Two of the three people who built a connector against this wrote their
// own translator before they could demonstrate the feature at all, and the third
// routed a note-shaped placeholder into an inbox project.
//
// THE PART THAT IS NOT A RENAME. A world event names a channel the way a person
// would -- `provider_evidence.channel_name` is `"data"` -- and the pack that the
// connector was seeded from calls the same channel `"channel-data"`. So the
// obvious `channel/<channel_name>` reference misses every reference the seed
// receipt returned, and the connector answers 422 for a reason nobody can see.
// Resolving the name against the world, once, here, is what makes a replayed
// event address the records the application already has.

import { findChannel, findPerson } from "./world.mjs";

export const EVENT_VERSION = "worldfixture.application-event/v1";

// `worldfixture_ref` is `<collection>/<id>`. The receipt example in
// `protocol-v1.md` is `person/maya-chen`, and nothing else in the contract says
// so, which is why connector authors kept guessing at it.
function reference(collection, id) {
  return id ? { worldfixture_ref: `${collection}/${id}` } : undefined;
}

// What the event is about, resolved against the world rather than copied.
function subjectOf(event, world) {
  const evidence = event.provider_evidence ?? {};

  const channelName = evidence.channel_name ?? evidence.channel;
  if (channelName) {
    const channel = findChannel(world, String(channelName));
    if (channel) return reference("channel", channel.id);
  }

  for (const field of ["to", "recipient", "person", "person_id"]) {
    if (!evidence[field]) continue;
    const person = findPerson(world, String(evidence[field]));
    if (person) return reference("person", person.id);
  }

  for (const [field, collection] of [["issue_id", "issue"], ["invoice_id", "invoice"], ["task_id", "task"], ["case_id", "case"]]) {
    if (evidence[field]) return reference(collection, String(evidence[field]));
  }

  return undefined;
}

export function connectorEventFromWorldEvent(event, world) {
  if (!event?.id || !event?.type || !event?.occurred_at) {
    throw new Error("a world event needs id, type and occurred_at before it can be delivered");
  }

  const evidence = event.provider_evidence ?? {};
  const actorPerson = event.actor_id ? findPerson(world, String(event.actor_id)) : null;
  const channelName = evidence.channel_name ?? evidence.channel;
  const channel = channelName ? findChannel(world, String(channelName)) : null;

  return {
    api_version: EVENT_VERSION,
    event_id: event.id,
    kind: event.type,
    occurred_at: event.occurred_at,
    ...(actorPerson ? { actor: reference("person", actorPerson.id) } : {}),
    ...(subjectOf(event, world) ? { subject: subjectOf(event, world) } : {}),
    // The evidence as observed, plus the identifiers it implied. A connector
    // that wants the raw provider view still has it; one that wants to look a
    // record up no longer has to reverse a display name into an id.
    data: {
      ...evidence,
      ...(channel ? { channel_id: channel.id, channel_name: channel.name } : {}),
      ...(actorPerson ? { actor_id: actorPerson.id, actor_name: actorPerson.name } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(event.caused_by ? { caused_by: event.caused_by } : {}),
    },
  };
}

// The event a replay should pick when the caller did not name one.
//
// The most recent observation, because that is the one somebody has just caused
// and is watching for. `--event` takes either the `evt_...` id or the sequence
// number the ledger prints, since both are on screen.
export function selectWorldEvent(events, reference) {
  if (events.length === 0) throw new Error("this instance has observed no events yet");
  if (reference === undefined || reference === null || reference === "") return events.at(-1);

  const wanted = String(reference);
  const found = events.find((event) => event.id === wanted || String(event.seq) === wanted);
  if (found) return found;

  // A kind rather than an identifier: take the most recent of that kind, which
  // is what somebody typing `--event communication.message.sent.v1` means.
  const ofKind = events.filter((event) => event.type === wanted);
  if (ofKind.length > 0) return ofKind.at(-1);

  throw new Error(
    `no observed event matches ${JSON.stringify(wanted)}; ` +
      `run \`worldfixture events\` to see the ledger`,
  );
}

// The kinds this world has actually produced, most recent first, for a client
// offering a choice. A hard-coded list is how the Workbench came to offer four
// kinds that no connector in the conformance set accepted.
export function observedKinds(events) {
  const seen = new Map();
  for (const event of events) seen.set(event.type, (seen.get(event.type) ?? 0) + 1);
  return [...seen.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
}
