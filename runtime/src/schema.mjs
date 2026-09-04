import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

// A JSON Schema validator covering the subset the `worldfixture.*` schemas use.
//
// The runtime validates an environment specification before resolving it, and a
// bad specification has to fail by name rather than by a later undefined. Pulling
// in a full JSON Schema implementation for `type`, `required`, `const`, `enum`,
// `pattern`, `oneOf`, `$ref` and `additionalProperties` would be a dependency for
// nine keywords, and the compiler side of this repository has none at all.
//
// It reports every failure rather than the first, because a specification with
// three mistakes should take one round trip to fix.

const TYPES = {
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number",
};

function deref(schema, root) {
  if (!schema.$ref) return schema;
  if (!schema.$ref.startsWith("#/")) {
    throw new Error(
      `unsupported $ref: ${schema.$ref}. ` +
        "Load the schema with loadSchema() to inline references to other schema files.",
    );
  }
  return schema.$ref.slice(2).split("/").reduce((node, part) => node[part], root);
}

export function validate(instance, schema, { path = "$", root = schema } = {}) {
  schema = deref(schema, root);
  const errors = [];

  if (schema.oneOf) {
    const matched = schema.oneOf.filter((branch) => validate(instance, branch, { path, root }).length === 0);
    if (matched.length !== 1) {
      errors.push(`${path}: matched ${matched.length} of ${schema.oneOf.length} oneOf branches, need exactly 1`);
    }
    return errors;
  }

  if (schema.type && !TYPES[schema.type](instance)) {
    return [`${path}: expected ${schema.type}, got ${instance === null ? "null" : typeof instance}`];
  }

  if ("const" in schema && instance !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}`);
  }
  if (schema.enum && !schema.enum.includes(instance)) {
    errors.push(`${path}: ${JSON.stringify(instance)} is not one of ${schema.enum.join(", ")}`);
  }
  if (schema.pattern && typeof instance === "string" && !new RegExp(schema.pattern).test(instance)) {
    errors.push(`${path}: ${JSON.stringify(instance)} does not match ${schema.pattern}`);
  }

  if (TYPES.object(instance)) {
    for (const key of schema.required ?? []) {
      if (!(key in instance)) errors.push(`${path}: missing required property ${JSON.stringify(key)}`);
    }
    for (const [key, value] of Object.entries(instance)) {
      // JSON has no `undefined`; a key holding one is not a present property.
      if (value === undefined) continue;
      const child = `${path}.${key}`;
      if (schema.propertyNames) {
        errors.push(...validate(key, schema.propertyNames, { path: `${child} (name)`, root }));
      }
      if (schema.properties?.[key]) {
        errors.push(...validate(value, schema.properties[key], { path: child, root }));
      } else if (schema.additionalProperties === false) {
        errors.push(`${child}: unexpected property`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(value, schema.additionalProperties, { path: child, root }));
      }
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} items, has ${instance.length}`);
    }
    if (schema.items) {
      instance.forEach((item, index) => {
        errors.push(...validate(item, schema.items, { path: `${path}[${index}]`, root }));
      });
    }
  }

  return errors;
}

export function assertValid(instance, schema, label) {
  const errors = validate(instance, schema);
  if (errors.length > 0) {
    throw new Error(`${label} is not valid:\n  ${errors.join("\n  ")}`);
  }
}

// Reading a schema that references another schema file.
//
// THE BUG THIS CLOSES. `connector-status.v1.schema.json` describes its receipts
// as `{"$ref": "connector-receipt.v1.schema.json"}`, and `deref` only ever
// resolved `#/`-local pointers. An empty `receipts` array never dereferences
// `items`, so a connector passed `worldfixture connector check` right up to the
// moment it seeded something -- and then the check reported the CONNECTOR as
// broken, and `connector status` exited with a raw Node stack trace. Two
// separate applications hit this within an hour of each other, both correct,
// both told they were wrong, at exactly the point where their work had started
// paying off.
//
// References are inlined once, at load, so `validate` stays a pure function over
// a self-contained schema and does no IO.
export function loadSchema(path, seen = new Set()) {
  const resolved = resolvePath(path);
  if (seen.has(resolved)) {
    throw new Error(`schema ${resolved} references itself through another file`);
  }
  const inline = (node) => {
    if (Array.isArray(node)) return node.map(inline);
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
      const { $ref, ...rest } = node;
      return { ...loadSchema(join(dirname(resolved), $ref), new Set([...seen, resolved])), ...rest };
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value)]));
  };
  return inline(JSON.parse(readFileSync(resolved, "utf8")));
}
