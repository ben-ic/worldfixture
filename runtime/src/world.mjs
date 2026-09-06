// Reading a world artifact for the things a person is shown.
//
// The first screen has to answer "what did I get?" -- what the user received,
// not internal orchestration. That means counting what is actually in this
// artifact. The printed history is measured from the world's own records rather
// than asserted: this world was designed to carry a month of history and holds
// eight Slack messages, and printing "30 days" over eight messages is the kind
// of claim this project keeps finding and removing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from 'node:crypto';

export function readWorld(artifactPath) {
  return JSON.parse(readFileSync(join(artifactPath, "world.json"), "utf8"));
}

// Native user names follow the compiler's documented identity adapter. The
// canonical person ID remains unchanged in world records and connector data.
export function providerLogin(person) {
  if (person.github_login !== undefined) return person.github_login;
  if (/^[a-z][a-z0-9-]+$/.test(person.id)) return person.id;
  const slug = person.id.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `${slug}-${createHash('sha256').update(person.id).digest('hex').slice(0, 10)}`;
}

export function primaryOrganization(world) {
  return world.organizations?.find((organization) => organization.primary) ?? world.organizations?.[0];
}

// The people who work at the world's own organization. The artifact also carries
// people at customer and supplier organizations -- they are real world records
// and they are not who "People" means on a first screen.
export function insiders(world) {
  const organization = primaryOrganization(world);
  return (world.people ?? []).filter((person) => person.organization_id === organization?.id);
}

// An id, a GitHub login, a full name and an email each name ONE person. The
// first segment of an id does not.
//
// Measured against dist/business.saas-company.v3 (161 people): four first
// segments are shared -- maya (maya-chen, maya-osei), ravi (ravi-kapoor,
// ravi-sundaram), idris (idris-coulibaly, idris-salim) and lena (lena-fischer,
// lena-brandt). A single `.find` over all five forms returned whichever of the
// pair came earlier in the array, so `--as maya` acted as maya-chen and never
// said that maya-osei existed.
//
// So the unique forms are matched first and the first segment only after them,
// and every first-segment match is returned rather than the first one. The
// caller decides what an ambiguous reference means; `findPerson` keeps its old
// single-person contract for the callers that pass a full id.
function exactMatch(person, wanted) {
  return (
    person.id === wanted ||
    person.github_login?.toLowerCase() === wanted ||
    person.name.toLowerCase() === wanted ||
    person.email?.toLowerCase() === wanted
  );
}

export function findPeople(world, reference) {
  const wanted = reference.toLowerCase();
  const people = world.people ?? [];
  const exact = people.filter((person) => exactMatch(person, wanted));
  if (exact.length > 0) return exact;
  return people.filter((person) => person.id.split("-")[0] === wanted);
}

// The shortest reference that still names exactly this person.
//
// `up` prints a `slack send --as <handle>` line for the reader to paste, and
// that line used to carry the bare first segment. In v3 that is `maya`, which
// names two people -- so the command the first screen offers would be refused
// by the command it is offering it to. The full id is used when the segment is
// shared.
export function personHandle(world, person) {
  const short = person.id.split("-")[0];
  return findPeople(world, short).length === 1 ? short : person.id;
}

export function findPerson(world, reference) {
  return findPeople(world, reference)[0];
}

export function findChannel(world, reference) {
  const wanted = reference.toLowerCase();
  return (world.communication?.channels ?? []).find(
    (channel) => channel.id === wanted || channel.name.toLowerCase() === wanted,
  );
}

// What the world holds, counted rather than described.
export function contents(world) {
  const channels = world.communication?.channels ?? [];
  const messages = channels.reduce((total, channel) => total + (channel.messages?.length ?? 0), 0);
  const mail = world.communication?.resolved_mail ?? world.communication?.mail ?? [];

  return {
    people: insiders(world).length,
    all_people: (world.people ?? []).length,
    channels: channels.length,
    slack_messages: messages,
    mail_messages: Array.isArray(mail) ? mail.length : 0,
    repositories: (world.software?.repositories ?? []).length,
    history: historySpan(world),
  };
}

// How much history each surface actually carries.
//
// The first screen was specified to print one "History 30 days" line. This
// world's Slack history is eight messages across two days, and its mail runs
// back over a year of invoices. One number would have to be wrong about one of
// them, and "30 days" is wrong about both -- so both are measured and both are
// printed. The world being thinner than it was designed to be is a fact about
// the world, and the first screen is the wrong place to paper over it.
function spanDays(stamps) {
  const times = stamps.filter(Boolean).map((stamp) => Date.parse(stamp)).filter(Number.isFinite);
  if (times.length < 2) return null;
  return Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000);
}

function historySpan(world) {
  const channels = world.communication?.channels ?? [];
  const mail = world.communication?.resolved_mail ?? world.communication?.mail ?? [];

  return {
    slack_days: spanDays(channels.flatMap((channel) => (channel.messages ?? []).map((m) => m.timestamp))),
    mail_days: spanDays((Array.isArray(mail) ? mail : []).map((message) => message.sent_at)),
  };
}
