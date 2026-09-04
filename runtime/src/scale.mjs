// How much of a world a run actually wants.
//
// WHY THIS EXISTS. `environments.mjs` already lets a run name the PARTS of a
// world it needs, and that removes whole services. It does not make the world
// itself smaller. A person checking that their connector maps a task to a task
// does not need 3,069 emails, 2,832 ledger entries and 514 tasks to find out;
// they need a handful of each, and they need them to hang together. Sending the
// whole artifact for that is minutes of somebody's afternoon spent proving
// something a hundred records would have proved.
//
// WHAT A SLICE HAS TO BE. Smaller is easy. Smaller and still COHERENT is the
// work: a task whose assignee was dropped is worse than no task at all, because
// a connector will either refuse it or invent a user for it, and both of those
// are the scaling tool's fault rather than the connector's. So the rule here is
// that a slice never contains a record that refers to a record it does not
// contain. Limits are targets, and integrity outranks them.
//
// The slice is a function of the artifact and the limits alone: no clock, no
// randomness, no set iteration order. The same artifact and the same limits
// produce the same slice, because a connector's `idempotency_key` is only
// honest if that is true.

// A cap on how many of anything, not a percentage of everything.
//
// WHY NOT A FRACTION. The first version of this took a fixed percentage of every
// collection, and it produced slices that were technically proportional and
// practically useless. Two percent of the default world is five people, and once
// there are only five people almost nothing else in the world can be kept: the
// mail is between people who are gone, the support cases are owned by people who
// are gone, and a slice meant to show a connector working arrives holding
// invoices and nothing else. The collections everything depends on -- people,
// organisations, projects -- are also the SMALL ones. Trimming them in
// proportion pays almost nothing and costs the entire slice.
//
// A cap inverts that. Small collections fall under it and are kept whole, so the
// world's skeleton survives intact; the large ones -- 3,069 emails, 2,832 ledger
// entries, 1,517 messages -- are the only ones it actually bites on, and they
// are the ones the cost was in. It also means the same word describes the same
// thing in a world this project has not written yet: "at most 25 of anything" is
// true of any artifact, where "two percent" is a different slice in each.
//
// Nested lists are capped per parent. Ten messages spread over ten channels
// shows a workspace; ten messages taken in artifact order shows one channel and
// nine empty ones.
export const SCALE_PRESETS = {
  smoke: { cap: 25, nestedCap: 10, summary: "at most 25 of anything -- a quick check" },
  sample: { cap: 250, nestedCap: 50, summary: "at most 250 of anything -- enough to look real" },
  full: { cap: Infinity, nestedCap: Infinity, summary: "the whole world" },
};

export const DEFAULT_SCALE = "full";

export class ScaleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScaleError";
  }
}

// Fields whose value is prose. A reference is a short identifier that happens to
// be a string, and so is a sentence; the difference cannot be recovered from the
// value, so it is declared here. Reading a reference out of a message body would
// pin a whole slice to whichever person got mentioned in it.
const PROSE_FIELDS = new Set([
  "body", "body_text", "content", "description", "name", "note", "snippet",
  "subject", "summary", "text", "title", "topic",
]);

// Fields that identify the record itself rather than another one.
const SELF_FIELDS = new Set(["id", "email", "github_login", "slack_id", "slug", "domain", "number"]);

export function parseScale(value) {
  if (value === undefined || value === null) return DEFAULT_SCALE;
  const name = String(value).toLowerCase();
  if (!(name in SCALE_PRESETS)) {
    throw new ScaleError(
      `unknown scale ${JSON.stringify(value)}; this build has ${Object.keys(SCALE_PRESETS).join(", ")}`,
    );
  }
  return name;
}

// `--limit people=25,communication.mail=200`
//
// A bare collection name is enough when it is unambiguous across packs, which it
// is for every collection in the worlds this ships with. The qualified form is
// there so a world that reuses a name is still addressable.
export function parseLimits(value) {
  if (value === undefined || value === null || value === "") return {};
  const limits = {};
  for (const clause of String(value).split(",")) {
    const text = clause.trim();
    if (!text) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(\d+)$/.exec(text);
    if (!match) {
      throw new ScaleError(`cannot read limit ${JSON.stringify(text)}; write it as collection=count`);
    }
    limits[match[1]] = Number(match[2]);
  }
  return limits;
}

// ---- the artifact as addressable collections -----------------------------

// Every list of records in the packs, flattened to one address each.
//
// Nested lists get an address too. `communication.channels.messages` is 1,517 of
// the 1,600-odd records in the default world's communication pack, and a slice
// that could not touch it would not be a slice.
function collectCollections(packs) {
  const collections = [];
  for (const [packName, pack] of Object.entries(packs)) {
    if (!pack || typeof pack !== "object") continue;
    for (const [name, value] of Object.entries(pack)) {
      if (!Array.isArray(value) || !value.every((entry) => entry && typeof entry === "object")) continue;
      collections.push({ address: `${packName}.${name}`, packName, path: [name], records: value });
      const nested = new Map();
      for (const record of value) {
        for (const [field, inner] of Object.entries(record)) {
          if (!Array.isArray(inner) || inner.length === 0) continue;
          if (!inner.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) continue;
          if (!nested.has(field)) nested.set(field, []);
          nested.get(field).push(...inner);
        }
      }
      for (const [field, records] of nested) {
        collections.push({
          address: `${packName}.${name}.${field}`,
          packName,
          path: [name, field],
          records,
          parentAddress: `${packName}.${name}`,
        });
      }
    }
  }
  return collections;
}

// Which identifiers name which record.
//
// A person is referred to by id in one pack, by `github_login` in a repository
// issue and by `slack_id` in a message, so the index carries all of them. It is
// built once and shared, which is also what makes a reference detectable without
// a declared foreign-key map: a value is a reference when some record answers to
// it, and nothing else has to be true.
function buildIdentityIndex(collections) {
  const owners = new Map();
  const claim = (value, address, record) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (owners.has(value)) return;
    owners.set(value, { address, record });
  };
  for (const collection of collections) {
    for (const record of collection.records) {
      claim(record.id, collection.address, record);
    }
  }
  for (const collection of collections) {
    for (const record of collection.records) {
      for (const field of ["github_login", "slack_id", "email", "slug"]) {
        claim(record[field], collection.address, record);
      }
    }
  }
  return owners;
}

function selfIdentifiers(record) {
  const own = new Set();
  for (const field of SELF_FIELDS) {
    if (typeof record[field] === "string") own.add(record[field]);
  }
  return own;
}

// What a record refers to, split by whether the reference can be trimmed.
//
// WHY THE SPLIT. A task's `project_id` and a channel's `member_ids` are both
// references and they fail completely differently under scaling. A task without
// its project is not a task. A channel without eleven of its fourteen members is
// a channel with three members, which is a perfectly ordinary channel. Treating
// both as all-or-nothing is what an early version of this did, and it produced
// slices with no channels, no projects and therefore no tasks in them: every
// membership list in the world named somebody who had not been kept, so every
// record carrying one was dropped, and the slice was invoices and nothing else.
//
// The distinction is in the shape, not in a table of field names: a scalar
// reference is the record's own dependency, and a list of references is the
// record's membership. Membership gets trimmed to the people who are there.
function referencesOf(record, owners) {
  const own = selfIdentifiers(record);
  const resolve = (value) => {
    if (typeof value !== "string" || own.has(value)) return null;
    const owner = owners.get(value);
    return owner && owner.record !== record ? value : null;
  };

  const required = new Set();
  const memberships = [];
  for (const [field, value] of Object.entries(record)) {
    if (PROSE_FIELDS.has(field)) continue;
    if (typeof value === "string") {
      const identifier = resolve(value);
      if (identifier) required.add(identifier);
    } else if (Array.isArray(value)) {
      const identifiers = value.map(resolve).filter(Boolean);
      // A list with no references in it is `labels` or `topics`, not membership.
      if (identifiers.length > 0) memberships.push({ field, identifiers: new Set(identifiers) });
    }
  }
  return { required, memberships };
}

// ---- choosing the slice --------------------------------------------------

// The cap for one collection. A nested collection's cap is per parent.
function limitFor(collection, { preset, limits }) {
  const total = collection.records.length;
  const explicit = limits[collection.address] ?? limits[collection.path.join(".")] ?? limits[collection.path.at(-1)];
  if (explicit !== undefined) return collection.parentAddress ? explicit : Math.min(explicit, total);
  const { cap, nestedCap } = SCALE_PRESETS[preset];
  return collection.parentAddress ? nestedCap : Math.min(cap, total);
}

function unknownLimits(collections, limits) {
  const known = new Set();
  for (const collection of collections) {
    known.add(collection.address);
    known.add(collection.path.join("."));
    known.add(collection.path.at(-1));
  }
  return Object.keys(limits).filter((name) => !known.has(name));
}

// Select, prune, refill, repeat.
//
// Selection takes the first N of each collection, in artifact order, which is
// deterministic and puts the world's own opening records first -- the primary
// organisation, the people the first screen names -- rather than an arbitrary
// window into the middle of it. Pruning then drops anything whose references did
// not survive, and refill puts back records that ARE satisfiable, so a limit
// spent on a task that had to be dropped is spent again on one that can stay.
//
// The loop ends because pruning only ever removes and refill only ever adds
// records that pruning did not object to; it is bounded here anyway, because a
// scaling tool that hangs on somebody's world is worse than one that gives them
// a slightly smaller slice.
function chooseSlice(collections, owners, targets) {
  const keptIds = new Set();
  const kept = new Map();

  const identifiersOf = (record) => selfIdentifiers(record);
  const isKept = (identifier) => keptIds.has(identifier);

  const add = (collection, record) => {
    kept.get(collection.address).add(record);
    for (const identifier of identifiersOf(record)) keptIds.add(identifier);
  };

  for (const collection of collections) kept.set(collection.address, new Set());

  const refs = new Map();
  for (const collection of collections) {
    for (const record of collection.records) refs.set(record, referencesOf(record, owners));
  }

  // A parent list and its nested list are one decision, not two: a message
  // cannot be kept in a channel that was not kept.
  const parentOf = new Map();
  for (const collection of collections) {
    if (!collection.parentAddress) continue;
    const parent = collections.find((other) => other.address === collection.parentAddress);
    for (const record of parent.records) {
      for (const nestedRecord of record[collection.path.at(-1)] ?? []) parentOf.set(nestedRecord, record);
    }
  }

  // A record survives when every dependency it names is present and every
  // membership list it carries still names at least one person who is present.
  // An empty membership list is the one case a trim cannot rescue: a channel
  // none of whose members were kept is not a smaller channel, it is a channel
  // nobody can post in.
  const holds = (record, present) => {
    const { required, memberships } = refs.get(record);
    for (const identifier of required) if (!present(identifier)) return false;
    for (const membership of memberships) {
      let survivor = false;
      for (const identifier of membership.identifiers) {
        if (present(identifier)) { survivor = true; break; }
      }
      if (!survivor) return false;
    }
    return true;
  };

  const satisfied = (collection, record) => {
    const parent = parentOf.get(record);
    if (parent && !kept.get(collection.parentAddress).has(parent)) return false;
    return holds(record, isKept);
  };

  // Room under the cap. For a nested list the cap counts siblings under the same
  // parent, so ten messages means ten messages in each channel rather than ten
  // messages in the first channel and none anywhere else.
  const hasRoom = (collection, record) => {
    const target = targets.get(collection.address);
    if (!collection.parentAddress) return kept.get(collection.address).size < target;
    const parent = parentOf.get(record);
    let siblings = 0;
    for (const other of kept.get(collection.address)) {
      if (parentOf.get(other) === parent) siblings += 1;
    }
    return siblings < target;
  };

  for (const collection of collections) {
    for (const record of collection.records) {
      if (!hasRoom(collection, record)) continue;
      add(collection, record);
    }
  }

  // Prune what the caps broke, then spend the freed room on records that fit.
  const settle = () => {
    for (let pass = 0; pass < 12; pass += 1) {
      let changed = false;

      // Prune. Recomputing `keptIds` from scratch is what makes a dropped record
      // stop satisfying the records that pointed at it.
      for (let inner = 0; inner < 12; inner += 1) {
        const survivors = new Map();
        let dropped = false;
        for (const collection of collections) survivors.set(collection.address, new Set());
        const live = new Set();
        for (const collection of collections) {
          for (const record of kept.get(collection.address)) {
            for (const identifier of identifiersOf(record)) live.add(identifier);
          }
        }
        for (const collection of collections) {
          for (const record of kept.get(collection.address)) {
            const parent = parentOf.get(record);
            const parentKept = !parent || kept.get(collection.parentAddress).has(parent);
            const refsKept = holds(record, (identifier) => live.has(identifier));
            if (parentKept && refsKept) survivors.get(collection.address).add(record);
            else dropped = true;
          }
        }
        if (!dropped) break;
        for (const collection of collections) kept.set(collection.address, survivors.get(collection.address));
        keptIds.clear();
        for (const collection of collections) {
          for (const record of kept.get(collection.address)) {
            for (const identifier of identifiersOf(record)) keptIds.add(identifier);
          }
        }
        changed = true;
      }

      // Refill.
      for (const collection of collections) {
        const set = kept.get(collection.address);
        for (const record of collection.records) {
          if (set.has(record)) continue;
          if (!hasRoom(collection, record)) continue;
          if (!satisfied(collection, record)) continue;
          add(collection, record);
          changed = true;
        }
      }

      if (!changed) break;
    }
  };

  settle();

  // Nothing the world has disappears entirely.
  //
  // WHY THIS PASS EXISTS. A cap plus integrity can starve a whole collection to
  // zero, and it does: the default world's fifteen support cases are owned by
  // people at CUSTOMER organisations, and the first twenty-five people in the
  // artifact all work at the company, so not one case can be kept and the slice
  // silently has no support in it at all. Somebody testing a support application
  // against that slice is testing nothing, and the output that told them so said
  // "cases 0 of 15", which is honest and far too easy to miss.
  //
  // So a collection that would come out empty gets one record put back, together
  // with everyone that record needs. That overshoots the cap on the collections
  // the dependencies come from, which is the right trade: the cap exists to keep
  // a slice small, and a handful of extra people is a much smaller price than a
  // missing quarter of the world.
  const recordFor = (identifier) => owners.get(identifier)?.record ?? null;
  const collectionFor = (record) => collections.find((entry) => entry.records.includes(record)) ?? null;

  const closureFor = (record, seen = new Set()) => {
    if (seen.has(record)) return seen;
    seen.add(record);
    const { required, memberships } = refs.get(record);
    for (const identifier of required) {
      const parent = recordFor(identifier);
      if (parent) closureFor(parent, seen);
    }
    for (const membership of memberships) {
      let present = false;
      for (const identifier of membership.identifiers) if (keptIds.has(identifier)) { present = true; break; }
      if (present) continue;
      const first = [...membership.identifiers].map(recordFor).find(Boolean);
      if (first) closureFor(first, seen);
    }
    const parent = parentOf.get(record);
    if (parent) closureFor(parent, seen);
    return seen;
  };

  for (let pass = 0; pass < 4; pass += 1) {
    const starved = collections.filter(
      (collection) =>
        collection.records.length > 0 &&
        targets.get(collection.address) > 0 &&
        kept.get(collection.address).size === 0,
    );
    if (starved.length === 0) break;
    for (const collection of starved) {
      for (const record of closureFor(collection.records[0])) {
        const home = collectionFor(record);
        if (home) add(home, record);
      }
    }
    // The people a starved collection needed are new parents, and records that
    // could not be kept before may be keepable now.
    settle();
  }

  const live = new Set();
  for (const collection of collections) {
    for (const record of kept.get(collection.address)) {
      for (const identifier of identifiersOf(record)) live.add(identifier);
    }
  }

  return { kept, live, refs };
}

// ---- rebuilding the packs ------------------------------------------------

function trimMemberships(record, refs, live) {
  const { memberships } = refs.get(record);
  if (memberships.length === 0) return record;
  const copy = { ...record };
  for (const membership of memberships) {
    const value = copy[membership.field];
    if (!Array.isArray(value)) continue;
    // A value in the list that names nobody is not a reference -- `labels` and
    // `topics` sit next to `member_ids` -- and it stays.
    copy[membership.field] = value.filter(
      (entry) => !membership.identifiers.has(entry) || live.has(entry),
    );
  }
  return copy;
}

function rebuild(packs, collections, { kept, live, refs }) {
  const output = {};
  for (const [packName, pack] of Object.entries(packs)) {
    output[packName] = { ...pack };
  }
  const nested = collections.filter((collection) => collection.parentAddress);
  const top = collections.filter((collection) => !collection.parentAddress);

  for (const collection of top) {
    const set = kept.get(collection.address);
    const children = nested.filter((child) => child.parentAddress === collection.address);
    output[collection.packName][collection.path[0]] = collection.records
      .filter((record) => set.has(record))
      .map((record) => {
        const copy = trimMemberships(record, refs, live);
        for (const child of children) {
          const field = child.path.at(-1);
          if (!Array.isArray(copy[field])) continue;
          const childSet = kept.get(child.address);
          copy[field] = copy[field]
            .filter((entry) => childSet.has(entry))
            .map((entry) => trimMemberships(entry, refs, live));
        }
        return copy;
      });
  }
  return output;
}

// ---- the public operation ------------------------------------------------

export function isFullScale({ scale = DEFAULT_SCALE, limits = {} } = {}) {
  return parseScale(scale) === "full" && Object.keys(limits).length === 0;
}

// Take a slice of a compiled world's packs.
//
// Returns the reduced packs and a per-collection account of what happened, so a
// caller can print what the person is about to send instead of asserting it.
export function scaleWorld(source, { scale = DEFAULT_SCALE, limits = {} } = {}) {
  const preset = parseScale(scale);
  const collections = collectCollections(source.packs);
  const unknown = unknownLimits(collections, limits);
  if (unknown.length > 0) {
    throw new ScaleError(
      `unknown collection${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} in --limit; ` +
        `this world has ${collections.map((collection) => collection.path.join(".")).join(", ")}`,
    );
  }
  if (isFullScale({ scale: preset, limits })) {
    return {
      ...source,
      scale: { preset, limits, full: true, collections: collections.map((collection) => ({
        collection: collection.path.join("."),
        total: collection.records.length,
        kept: collection.records.length,
        limit: collection.records.length,
      })) },
    };
  }

  const owners = buildIdentityIndex(collections);
  const targets = new Map(
    collections.map((collection) => [collection.address, limitFor(collection, { preset, limits })]),
  );
  const slice = chooseSlice(collections, owners, targets);

  return {
    ...source,
    packs: rebuild(source.packs, collections, slice),
    scale: {
      preset,
      limits,
      full: false,
      collections: collections.map((collection) => ({
        collection: collection.path.join("."),
        total: collection.records.length,
        kept: slice.kept.get(collection.address).size,
        limit: targets.get(collection.address),
      })),
    },
  };
}

// What to print about a slice. Counted, never described.
export function describeScale(scale) {
  if (!scale || scale.full) return [];
  return scale.collections
    .filter((entry) => entry.total > 0)
    .map((entry) => `${entry.collection} ${entry.kept} of ${entry.total}`);
}
