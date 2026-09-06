import { paginate, seedReceiptMappings } from './coupling-probes.mjs';
import { sourceProviderActor } from './coupling-source-contracts.mjs';

const rows = value => Array.isArray(value) ? value : [];
const sort = value => [...value].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = encodeURIComponent;
const addresses = value => sort(String(value ?? '').match(/[^\s<>,]+@[^\s<>,]+/g) ?? []);
const newline = value => String(value ?? '').replace(/\r\n/g, '\n');
// Protocol constants, independent of the live label table.
const SYSTEM_LABELS = new Set(['INBOX', 'SENT', 'UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'DRAFT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);

export function gmailText(message) {
  if (typeof message.body_text === 'string') return newline(message.body_text);
  function plain(part) {
    if (part?.mimeType === 'text/plain' && !part.filename) return Buffer.from(part.body?.data ?? '', 'base64url').toString('utf8');
    for (const child of rows(part?.parts)) { const value = plain(child); if (value !== undefined) return value; }
    return undefined;
  }
  return newline(plain(message.payload));
}

export async function probeGoogleWorld({ artifact, bindings, credentials, fetchImpl = fetch, elapsedMs = 0, arrivalReceipts = [] }) {
  const world = artifact.world, projection = artifact.projections?.google ?? {};
  const overlay = artifact.projections?.['emulator-overlay'] ?? {};
  const people = rows(world.people), {person: primary, selection: actorSelection} = sourceProviderActor(world, {emailOnly: true});
  const versioned = overlay.google?.worldfixture_seed_version === 1;
  const declaredMailboxes = world.communication?.mailboxes;
  const mailboxIds = new Set(Array.isArray(declaredMailboxes) ? declaredMailboxes.map(row => row.owner_id) : people.filter(person => person.email).map(person => person.id));
  const checks = [], responses = [], coverage = [];
  const add = (check, passed, detail = {}) => checks.push({ check, status: passed ? 'passed' : 'failed', ...detail });
  const compare = (check, expected, actual, finding) => add(check, same(expected, actual), { expected, actual, ...(finding ? { finding } : {}) });
  const secrets = [...Object.values(credentials?.values ?? {}), bindings.GOOGLE_TOKEN].filter(value => typeof value === 'string' && value);
  const clean = value => {
    if (typeof value === 'string') { for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /token|password|secret|authorization/i.test(key) ? '[redacted]' : clean(entry)]));
    return value;
  };
  const run = async (name, action) => {
    const start = checks.length;
    try { await action(); add(name, !checks.slice(start).some(entry => entry.status === 'failed')); }
    catch (error) { add(name, false, { detail: clean(error.message), failure_kind: 'assertion' }); }
  };
  const evidence = (collections, path, prefixes, detail) => {
    const failed = checks.some(entry => entry.status === 'failed' && prefixes.some(prefix => entry.check.startsWith(prefix)));
    for (const collection of collections) coverage.push({ collection, provider: 'google', path, status: failed ? 'failed' : 'passed', detail });
  };
  if (!bindings.GOOGLE_BASE_URL) {
    add('google.exact.binding', false, { detail: 'Missing GOOGLE_BASE_URL', failure_kind: 'assertion' });
    return { checks, responses, coverage };
  }
  if (credentials && (credentials.world?.id !== world.id || String(credentials.world?.version) !== String(world.version))) {
    add('google.exact.credentials-world', false, { detail: 'Google credentials belong to a different or unspecified world.', finding: 8 });
    return { checks, responses, coverage };
  }
  add('google.exact.current-actor-selection', Boolean(primary) || !bindings.GOOGLE_TOKEN, {actual: {source_person_id: primary?.id ?? null, selection: actorSelection}, detail: 'Only an authored primary can supply the generic token; per-person mailbox reads do not require a primary.'});
  async function request(path, actor, media = false) {
    const response = await fetchImpl(`${bindings.GOOGLE_BASE_URL.replace(/\/$/, '')}${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${actor.token}`, accept: 'application/json' },
    });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    responses.push({ provider: 'google', path, actor_id: actor.person.id, status: response.status, body: clean(body) });
    if (!response.ok || body?.error) throw new Error(`${path} returned HTTP ${response.status}${body?.error?.status ? ` (${body.error.status})` : ''}`);
    if (media) return text;
    if (!body || typeof body !== 'object') throw new Error(`${path} did not return JSON.`);
    return body;
  }
  const actors = new Map();
  async function actorFor(email) {
    if (actors.has(email)) return actors.get(email);
    const person = people.find(entry => entry.email === email);
    if (!person) throw new Error(`Google owner ${email} is not a source person.`);
    const reference = Object.entries(overlay.tokens ?? {}).find(([key, entry]) => (key === 'demo_token' || key.startsWith('google_token')) && entry.login === email)?.[0];
    const token = credentials?.values?.[`token:google_token_${person.id}`]
      ?? (reference ? credentials?.values?.[`token:${reference}`] : undefined)
      ?? (person.id === primary?.id ? bindings.GOOGLE_TOKEN : undefined);
    if (!token) throw new Error(`No current Google credential is mapped to source person ${person.id}.`);
    const actor = { person, token };
    const identity = await request('/oauth2/v2/userinfo', actor);
    compare(`google.exact.identity.${person.id}`, person.email, identity.email, 8);
    if (identity.email !== person.email) throw new Error(`Google credential does not identify source person ${person.id}.`);
    actors.set(email, actor);
    return actor;
  }
  const list = (path, key, actor) => paginate(cursor => request(`${path}${path.includes('?') ? '&' : '?'}maxResults=100${cursor ? `&pageToken=${enc(cursor)}` : ''}`, actor), {
    items: value => value[key] ?? (key === 'messages' && value.resultSizeEstimate === 0 ? [] : undefined), next: value => value.nextPageToken,
  });
  const owner = record => {
    if (record.user_email !== undefined) return record.user_email;
    if (record.owner_id !== undefined) return people.find(person => person.id === record.owner_id)?.email;
    return primary?.email;
  };
  const mail = [...new Map([...rows(world.communication?.resolved_mail), ...rows(world.communication?.mail)].map(message => [message.id, message])).values()];
  const ownedMail = id => mail.filter(message => rows(message.to_ids).includes(id) || message.from_id === id && rows(message.labels).includes('SENT'));
  let mapping, driveMapping;
  if (versioned) await run('google.exact.receipt', async () => {
    const receiptPerson = people.find(person => mailboxIds.has(person.id)) ?? people.find(person => person.email && credentials?.values?.[`token:google_token_${person.id}`]);
    const actor = receiptPerson ? await actorFor(receiptPerson.email) : { person: { id: 'receipt' }, token: primary ? bindings.GOOGLE_TOKEN : undefined };
    if (!actor.token) throw new Error('No current world credential can read the empty Google seed receipt.');
    const receipt = await request('/_worldfixture/seed-receipt', actor);
    mapping = seedReceiptMappings(receipt, artifact, 'google', { collection: 'messages', sourceFields: ['source_person_id', 'source_message_id'], providerField: 'provider_message_id', providerScopeFields: ['source_person_id'],
      expectedKeys: [...mailboxIds].flatMap(id => ownedMail(id).map(message => [id, message.id])) });
    const owners = seedReceiptMappings(receipt, artifact, 'google', { collection: 'mailboxes', sourceFields: ['source_person_id'], providerField: 'email', expectedKeys: [...mailboxIds].map(id => [id]) });
    for (const id of mailboxIds) compare(`google.exact.receipt.owner.${id}`, people.find(person => person.id === id)?.email, owners.get(JSON.stringify([id])), 8);
    driveMapping = seedReceiptMappings(receipt, artifact, 'google', { collection: 'drive_items', sourceFields: ['source_person_id', 'source_document_id'], providerField: 'provider_file_id',
      expectedKeys: rows(world.communication?.documents).map(document => [document.owner_id, document.id]) });
  });
  else add('google.exact.seed-contract.legacy', true, { detail: 'Legacy artifact has no seed receipt. Canonical IDs are used as diagnostics; no durable identity mapping is claimed.' });
  const calendars = rows(world.communication?.calendars), events = rows(world.communication?.calendar_events);
  compare('google.exact.calendar.projection-ids', sort(calendars.map(calendar => calendar.id)), sort(rows(projection.calendars).map(calendar => calendar.id)));
  compare('google.exact.event.projection-ids', sort(events.map(event => event.id)), sort(rows(projection.calendar_events).map(event => event.id)));
  compare('google.exact.event.calendar-references', [], events.filter(event => !calendars.some(calendar => (event.calendar_id === calendar.id || ((!event.calendar_id || event.calendar_id === 'primary') && calendar.primary)) && (event.user_email ?? (event.owner_id ? owner(event) : owner(calendar))) === owner(calendar))).map(event => event.id));
  const calendarOwners = new Set(calendars.map(owner));
  if (primary?.email && mailboxIds.has(primary.id)) calendarOwners.add(primary.email);
  for (const email of calendarOwners) await run(`google.exact.calendar-owner.${email}`, async () => {
    const actor = await actorFor(email);
    const expected = calendars.filter(calendar => owner(calendar) === email);
    const actual = await list(`/calendar/v3/users/${enc(email)}/calendarList`, 'items', actor);
    compare(`google.exact.calendar.ids.${actor.person.id}`, sort(expected.map(calendar => calendar.id)), sort(actual.map(calendar => calendar.id)));
    for (const calendar of expected) {
      const live = actual.find(entry => entry.id === calendar.id);
      const wanted = { summary: calendar.summary ?? calendar.name ?? calendar.title ?? calendar.id };
      const got = { summary: live?.summary };
      for (const [sourceKey, apiKey] of [['description', 'description'], ['time_zone', 'timeZone'], ['primary', 'primary']]) if (calendar[sourceKey] !== undefined) {
        wanted[apiKey] = calendar[sourceKey]; got[apiKey] = apiKey === 'primary' ? Boolean(live?.[apiKey]) : live?.[apiKey];
      }
      compare(`google.exact.calendar.fields.${calendar.id}`, wanted, got);
    }
    for (const calendarId of new Set([...actual.map(calendar => calendar.id), ...expected.map(calendar => calendar.id)])) {
      await run(`google.exact.event-list.${email}.${calendarId}`, async () => {
        const sourceCalendar = expected.find(calendar => calendar.id === calendarId);
        const expectedEvents = events.filter(event => {
          const belongs = event.calendar_id === calendarId || ((!event.calendar_id || event.calendar_id === 'primary') && sourceCalendar?.primary);
          return belongs && (event.user_email ?? (event.owner_id ? owner(event) : owner(sourceCalendar ?? {}))) === email;
        });
        const actualEvents = await list(`/calendar/v3/calendars/${enc(calendarId)}/events`, 'items', actor);
        compare(`google.exact.event.ids.${email}.${calendarId}`, sort(expectedEvents.map(event => event.id)), sort(actualEvents.map(event => event.id)));
        for (const event of expectedEvents) {
          const live = actualEvents.find(entry => entry.id === event.id);
          const time = (value, record, boundary) => {
            const raw = typeof value === 'string' ? value : value?.dateTime ?? value?.date ?? record?.[`${boundary}_date_time`] ?? record?.[`${boundary}_date`];
            if (!raw) return null;
            return raw.length === 10 ? raw : new Date(raw).toISOString();
          };
          compare(`google.exact.event.fields.${event.id}`, { summary: event.summary, description: event.description ?? '', start: time(event.start, event, 'start'), end: time(event.end, event, 'end') },
            live ? { summary: live.summary, description: live.description ?? '', start: time(live.start, live, 'start'), end: time(live.end, live, 'end') } : null);
          const attendees = rows(event.attendees).map(attendee => typeof attendee === 'string' ? attendee : attendee.email);
          compare(`google.exact.event.attendees.${event.id}`, sort(attendees), sort(rows(live?.attendees).map(attendee => attendee.email)));
        }
      });
    }
  });
  evidence(['communication.calendars'], '/calendar/v3/users/{email}/calendarList', ['google.exact.identity.', 'google.exact.calendar'], 'Complete source calendar IDs and declared fields, read with each owner credential.');
  evidence(['communication.calendar_events', 'communication.calendar_events[].attendees'], '/calendar/v3/calendars/{id}/events', ['google.exact.identity.', 'google.exact.calendar-owner.', 'google.exact.event'], 'Complete source event IDs, parent calendar, summary, description, start/end, and attendee emails after pagination.');

  compare('google.exact.mail.projection-ids', versioned ? sort([...mailboxIds].flatMap(id => ownedMail(id).map(message => JSON.stringify([id, message.id])))) : sort(mail.map(message => message.id)),
    sort(rows(projection.messages).map(message => versioned ? JSON.stringify([message.worldfixture_owner_id, message.worldfixture_message_id]) : message.id)), 8);
  for (const id of mailboxIds) await run(`google.exact.mailbox.${id}`, async () => {
    const person = people.find(entry => entry.id === id);
    if (!person?.email) throw new Error(`Mailbox ${id} is not a source person with an email.`);
    const actor = await actorFor(person.email);
    const prefix = `/gmail/v1/users/${enc(person.email)}`;
    if (versioned && !mapping) throw new Error('Google seed receipt did not establish source message identities.');
    const providerId = sourceId => versioned ? mapping.get(JSON.stringify([id, sourceId])) : sourceId;
    const expected = ownedMail(id);
    const listed = await list(`${prefix}/messages?includeSpamTrash=true`, 'messages', actor);
    const allArrivals = rows(world.timeline).filter(event => event.kind === 'incoming-email' && event.payload?.via === 'gmail' && event.payload.to_id === id);
    const allowedArrivals = allArrivals.filter(event => Number.isFinite(event.after_seconds) && event.after_seconds * 1000 <= elapsedMs);
    if (versioned) {
      const recorded = arrivalReceipts.filter(row => row.source === 'google' && row.actor_id === id && allowedArrivals.some(event => event.id === row.provider_evidence?.arrival));
      const sourceIds = recorded.map(row => row.provider_evidence.arrival), liveIds = recorded.map(row => row.provider_evidence.message_id);
      add(`google.exact.mail.arrival-identities.${id}`, new Set(sourceIds).size === sourceIds.length && new Set(liveIds).size === liveIds.length
        && liveIds.every(value => typeof value === 'string' && value && !expected.some(message => providerId(message.id) === value)),
      { detail: 'Each successful Gmail arrival event must map a distinct source arrival to a distinct non-baseline provider ID.', finding: 8 });
    }
    const arrivalIds = new Map(allowedArrivals.map(event => [event.id, versioned
      ? arrivalReceipts.find(row => row.source === 'google' && row.actor_id === id && row.provider_evidence?.arrival === event.id)?.provider_evidence?.message_id : event.id]));
    const allowedIds = new Set([...arrivalIds.values()].filter(Boolean));
    compare(`google.exact.mail.list-identities.${id}`, listed.length, new Set(listed.map(message => message.id)).size, 8);
    // Already delivered authored arrivals may be present when the clock is paused.
    // They never substitute for a missing baseline message.
    compare(`google.exact.mail.ids.${id}`, sort(expected.map(message => providerId(message.id))), sort(listed.filter(message => !allowedIds.has(message.id)).map(message => message.id)), 8);
    const actual = [];
    for (const reference of listed) actual.push(await request(`${prefix}/messages/${enc(reference.id)}?format=full`, actor));
    const labels = (await request(`${prefix}/labels`, actor)).labels;
    if (!Array.isArray(labels)) throw new Error('Gmail labels response omitted its labels array.');
    const labelNames = new Map(labels.map(label => [label.id, label.name]));
    const normalizeActualLabels = values => sort(values.map(value => labelNames.get(value) ?? value));
    compare(`google.exact.mail.label-table-identities.${id}`, labels.length, new Set(labels.map(label => label.id)).size, 3);
    const declaredNames = new Set(Array.isArray(declaredMailboxes) ? rows(declaredMailboxes.find(row => row.owner_id === id)?.labels)
      : [...expected.flatMap(message => rows(message.labels)), ...allArrivals.flatMap(event => rows(event.payload.labels ?? ['INBOX', 'UNREAD']))]);
    // Future arrival labels may exist already, but need not be created before delivery.
    const requiredNames = new Set([...expected.flatMap(message => rows(message.labels)), ...(Array.isArray(declaredMailboxes) ? [...declaredNames, ...SYSTEM_LABELS] : labels.filter(label => declaredNames.has(label.name)).map(label => label.name))]);
    for (const name of requiredNames) {
      if (SYSTEM_LABELS.has(name)) {
        const definition = labels.find(label => label.id === name);
        compare(`google.exact.mail.system-label.${id}.${name}`, { id: name, name, type: 'system' }, definition ? { id: definition.id, name: definition.name, type: definition.type } : null, 3);
      } else {
        const definitions = labels.filter(label => label.name === name);
        compare(`google.exact.mail.custom-label.${id}.${name}`, [{ name, type: 'user' }], definitions.map(label => ({ name: label.name, type: label.type })), 3);
      }
    }
    compare(`google.exact.mail.foreign-custom-labels.${id}`, [], labels.filter(label => label.type !== 'system' && !declaredNames.has(label.name)).map(label => ({ id: label.id, name: label.name })), 3);
    const expectedRecords = [...expected.map(message => ({ ...message, provider_id: providerId(message.id) })), ...allowedArrivals.filter(event => actual.some(message => message.id === arrivalIds.get(event.id))).map(event => ({ id: event.id, provider_id: arrivalIds.get(event.id), ...event.payload, subject: event.payload.subject ?? '', body_text: event.payload.body_text ?? event.payload.snippet ?? '', labels: event.payload.labels ?? ['INBOX', 'UNREAD'], to_ids: [event.payload.to_id], thread_id: event.payload.thread_id ?? `thread-${event.id}` }))];
    const bodyText = async message => {
      if (!message) return '';
      const plain = part => {
        if (part?.mimeType === 'text/plain' && !part.filename) return part;
        for (const child of rows(part?.parts)) { const found = plain(child); if (found) return found; }
        return null;
      };
      const part = plain(message.payload);
      if (part?.body?.attachmentId && !part.body.data) {
        const attachment = await request(`${prefix}/messages/${enc(message.id)}/attachments/${enc(part.body.attachmentId)}`, actor);
        if (typeof attachment.data !== 'string') throw new Error('Gmail text body attachment omitted base64url data.');
        return newline(Buffer.from(attachment.data, 'base64url').toString('utf8'));
      }
      if (part?.body?.size > 0 && !part.body.data && typeof message.body_text !== 'string') throw new Error('Gmail text body has positive size but no data or attachment ID.');
      return gmailText(message);
    };
    for (const source of expectedRecords) {
      const live = actual.find(message => message.id === source.provider_id);
      const headers = Object.fromEntries(rows(live?.payload?.headers).map(header => [header.name.toLowerCase(), header.value]));
      compare(`google.exact.mail.record.${id}.${source.id}`, { id: source.provider_id, thread: source.thread_id, subject: source.subject, body: newline(source.body_text), from: people.find(person => person.id === source.from_id)?.email, to: sort(rows(source.to_ids).map(to => people.find(person => person.id === to)?.email)) },
        live ? { id: live.id, thread: live.threadId ?? live.thread_id, subject: headers.subject ?? live.subject, body: await bodyText(live), from: addresses(headers.from ?? live.from)[0], to: addresses(headers.to ?? live.to) } : null, 8);
      compare(`google.exact.mail.labels.${id}.${source.id}`, sort(rows(source.labels)), normalizeActualLabels(rows(live?.labelIds ?? live?.label_ids)), 3);
      compare(`google.exact.mail.label-references.${id}.${source.id}`, [], sort(rows(live?.labelIds ?? live?.label_ids).filter(label => !labelNames.has(label))), 3);
    }
  });
  evidence(['communication.mail', 'communication.resolved_mail', 'communication.mail[].labels', 'communication.resolved_mail[].labels', 'communication.mail[].to_ids', 'communication.resolved_mail[].to_ids'], '/gmail/v1/users/{email}/messages/{id}?format=full',
    ['google.exact.identity.', 'google.exact.receipt', 'google.exact.mail'], 'Complete mailbox source IDs, thread IDs, text bodies, sender/recipient relationships, and exact labels; each owner uses a verified current credential.');
  if (Array.isArray(declaredMailboxes)) evidence(['communication.mailboxes', 'communication.mailboxes[].labels'], '/oauth2/v2/userinfo + /gmail/v1/users/{email}/labels',
    ['google.exact.identity.', 'google.exact.receipt', 'google.exact.mail'], 'Declared owners identify themselves through userinfo; exact custom labels and system labels are read for each account. An empty declaration has no owner records to read.');
  if (versioned) {
    for (const id of mailboxIds) await run(`google.exact.drive.${id}`, async () => {
      if (!driveMapping) throw new Error('Google seed receipt did not establish source Drive identities.');
      const person = people.find(person => person.id === id), actor = await actorFor(person?.email);
      const documents = rows(world.communication?.documents).filter(document => document.owner_id === id);
      const files = await paginate(cursor => request(`/drive/v3/files?pageSize=100${cursor ? `&pageToken=${enc(cursor)}` : ''}`, actor), { items: page => page.files, next: page => page.nextPageToken });
      const fileId = document => driveMapping.get(JSON.stringify([id, document.id]));
      compare(`google.exact.drive.ids.${id}`, sort(documents.map(fileId)), sort(files.map(file => file.id)));
      for (const document of documents) {
        const path = `/drive/v3/files/${enc(fileId(document))}`, file = await request(path, actor);
        compare(`google.exact.drive.fields.${document.id}`, { name: document.name ?? document.title ?? document.id, mime: document.mime_type ?? 'text/markdown' }, { name: file.name, mime: file.mimeType });
        compare(`google.exact.drive.body.${document.id}`, document.content ?? document.body_md ?? document.body ?? '', await request(`${path}?alt=media`, actor, true));
      }
    });
    evidence(['communication.documents'], '/drive/v3/files + /drive/v3/files/{id}?alt=media', ['google.exact.identity.', 'google.exact.receipt', 'google.exact.drive.'], 'Each declared owner reads complete Drive IDs, source name/MIME type and exact content through public routes; receipt supplies IDs only.');
  }
  return { checks, responses, coverage };
}
