import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { ALL_VENDORS } from "../emulators/emulate/src/registry.mjs";

const OUTPUT = new URL("../runtime/src/postman-routes.json", import.meta.url);
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function recorder(routes) {
  let app;
  app = new Proxy({}, {
    get(target, property) {
      if (!target[property]) {
        target[property] = (...args) => {
          if (METHODS.has(property) && typeof args[0] === "string") {
            routes.push({ method: property.toUpperCase(), path: args[0] });
          }
          return app;
        };
      }
      return target[property];
    },
  });
  return app;
}

// Route registration does not read provider data. These small objects supply the
// methods that WorldFixture's wrappers bind while they add their routes.
const store = {
  collection() {
    return { all: () => [], findOneBy: () => undefined, insert: value => value, clear() {} };
  },
  getData: () => undefined,
  setData() {},
};

function webhookTransport() {
  return { register() {}, dispatch() {}, clear() {}, setHeaderFactory() {} };
}

export async function registeredProviderRoutes() {
  const result = {};
  for (const name of Object.keys(ALL_VENDORS).sort()) {
    const { plugin } = await ALL_VENDORS[name].load();
    const routes = [];
    plugin.register(recorder(routes), store, webhookTransport(), "http://worldfixture.local", new Map());
    result[name] = [...new Map(routes.map(route => [`${route.method} ${route.path}`, route])).values()]
      .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
  }
  return result;
}

const generated = `${JSON.stringify(await registeredProviderRoutes(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  assert.equal(readFileSync(OUTPUT, "utf8"), generated,
    "runtime/src/postman-routes.json is stale; run npm run postman:routes");
} else {
  writeFileSync(OUTPUT, generated);
  console.log(`Wrote ${OUTPUT.pathname}`);
}
