// Causal rules: one completed fact producing another.
//
// The rule language is deliberately small -- an event-type match, field copying,
// a world-value lookup, a bounded delay, and event emission -- and it does not
// run arbitrary scripts. Behaviour that needs code belongs in a service or a
// target adapter.
//
// WHAT IS DELIBERATELY MISSING, because the extraction measured why. A rule that
// reacts to a change a service made on its own needs a durable change journal to
// read it out of, and `GET /_worldfixture/changes` exists in no service. So this
// engine only fires on events the RUNTIME ITSELF ORIGINATED -- a command the CLI
// or the API submitted, whose provider evidence came back from the provider
// call. For those there is nothing to catch up on after a restart: the runtime
// was the writer. Rules over service-originated changes wait for the cursor
// contract, and `originated` below is where that limit is enforced rather than
// assumed.

export class RuleError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "RuleError";
    this.code = code;
    this.detail = detail;
  }
}

// `after: "5s"`, `after: "2m"`. Unbounded delays are not a rule language.
export function parseDelay(value) {
  if (value === undefined) return 0;
  const match = String(value).match(/^(\d+)(ms|s|m)$/);
  if (!match) throw new RuleError("bad_delay", `"${value}" is not a delay; use 500ms, 5s or 2m`, { value });
  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000 }[match[2]];
}

// Resolve one `copy` or `lookup` term against the event and the world.
//
// The two are kept apart on purpose. `copy` reads the event, which is a fact
// that happened. `lookup` reads the world, which is what was true before
// anything happened. Letting a rule read anything else would make it a script.
function resolveTerm(term, { event, world }) {
  if ("copy" in term) {
    return term.copy.split(".").reduce((node, key) => (node == null ? undefined : node[key]), event);
  }

  if ("lookup" in term) {
    const { collection, match, select } = term.lookup;
    const rows = collection.split(".").reduce((node, key) => (node == null ? undefined : node[key]), world) ?? [];
    const wanted = resolveTerm(match.value, { event, world });
    const found = [].concat(rows).filter((row) => row?.[match.field] === wanted);
    return select ? found.map((row) => row[select]) : found;
  }

  if ("value" in term) return term.value;

  throw new RuleError("bad_term", "a rule term is one of copy, lookup or value", { term });
}

// Every leaf of an emission payload is a term, and a bare scalar is not one.
//
// This is stricter than it has to be, and the strictness is the point. If a
// misspelled term were treated as a plain object, `{ copyy: "actor_id" }` would
// emit the literal string "actor_id" and nothing would report it -- the same
// shape of failure as an overlay key list dropping what it does not name, which
// this project has now found three times. A literal is written `{ value: ... }`,
// which costs four characters and cannot be a typo.
function build(shape, context) {
  if (Array.isArray(shape)) return shape.map((entry) => build(entry, context));

  if (shape && typeof shape === "object") {
    if ("copy" in shape || "lookup" in shape || "value" in shape) return resolveTerm(shape, context);
    return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, build(value, context)]));
  }

  throw new RuleError(
    "bad_term",
    `a rule emits terms, not bare values; write ${JSON.stringify(shape)} as {"value": ${JSON.stringify(shape)}}`,
    { shape },
  );
}

// What one event causes. Pure: it decides, and something else delivers.
export function applyRules(rules, event, { world }) {
  const emissions = [];

  for (const rule of rules) {
    if (rule.when !== event.type) continue;

    const missing = (rule.requires ?? []).filter(
      (field) => resolveTerm({ copy: field }, { event, world }) === undefined,
    );
    if (missing.length > 0) continue;

    for (const emission of rule.emit ?? []) {
      emissions.push({
        rule: rule.id,
        type: emission.type,
        after_ms: parseDelay(emission.after),
        payload: build(emission.with ?? {}, { event, world }),
        caused_by: event.id,
      });
    }
  }

  return emissions;
}

// Only a fact the runtime itself produced may drive a rule.
//
// A service-originated change would need the change journal no service offers,
// and a rule that fired on one would silently miss everything that happened
// while the runtime was not watching. Refusing is the honest behaviour; a rule
// that "mostly" fires is worse than one that does not exist.
export function originated(event) {
  return Boolean(event.caused_by?.startsWith("cmd_"));
}

export function eligible(rules, event, { world }) {
  if (!originated(event)) return [];
  return applyRules(rules, event, { world });
}
