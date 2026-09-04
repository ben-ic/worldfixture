// The vendors this artifact serves, and how each one is wired.
//
// This is a deliberate re-statement of `emulate`'s own `src/registry.ts`, which is
// INTERNAL to the CLI: the npm package exports `createEmulator` and the CLI binary,
// and nothing else. Composing on `@emulators/core` therefore means owning the small
// amount of per-vendor wiring the CLI kept private — the loader and each vendor's
// default identity.
//
// EVERY `fallback` below is copied from `emulate@0.10.0`'s registry, not invented.
// When bumping the dependency, re-read their registry and diff this file.
//
// WHAT `fallback` IS FOR HERE, WHICH IS NOT WHAT UPSTREAM USES IT FOR. Upstream hands
// it to `createServer` as `fallbackUser`, and core's auth middleware then resolves ANY
// unrecognized bearer token to it — so an unknown token silently authenticates as the
// vendor's default user. This composer does not pass it (see `startComposed` in
// `main.mjs` for the measurement); an unknown token resolves to nobody and gets the
// vendor's own error. What is left is a diagnostic: `checkSeedResolves` needs the
// vendor's own idea of its default login so it does not warn about Slack, whose users
// are generated `U…` ids that never appear in the seed as such.
//
// Linear and Twilio are not package exports. They are imported from the pinned
// bundle beside emulate's public entry point. This is less stable than a public
// package, but it keeps their Store visible for exact session snapshots.

import { readdir } from "node:fs/promises";
import { extendStripePlugin, seedStripeBilling } from "./overrides/stripe-billing.mjs";

// Linear and Twilio are bundled in the pinned `emulate` package but are not
// package exports. Resolve them beside the public entry point so they can use
// the same `createServer` path as every other vendor. This gives WorldFixture a
// Store it can snapshot. The filenames belong to emulate@0.10.0 and must be
// re-measured when that pinned dependency changes.
const emulateEntry = import.meta.resolve("emulate");
const bundled = (file) => new URL(file, emulateEntry).href;

export const VENDORS = {
  microsoft: {
    async load() {
      const mod = await import("@emulators/microsoft");
      return { plugin: mod.microsoftPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      const firstEmail = cfg?.users?.[0]?.email ?? "testuser@outlook.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "profile", "User.Read"] };
    },
  },

  github: {
    async load() {
      const mod = await import("@emulators/github");
      return {
        plugin: mod.githubPlugin,
        seedFromConfig: mod.seedFromConfig,
        // Materializes GitHub App private keys out of the seed. Present on the
        // programmatic API and NOT on the CLI's start command, so an artifact that
        // copied `start.ts` alone would silently serve apps with no key.
        prepareSeed: mod.materializeGitHubSeedConfig
          ? async (config) => {
              const materialized = await mod.materializeGitHubSeedConfig(config);
              return { config: materialized.config };
            }
          : undefined,
        createAppKeyResolver(store) {
          return (appId) => {
            try {
              const gh = mod.getGitHubStore(store);
              const ghApp = gh.apps.all().find((a) => a.app_id === appId);
              if (!ghApp) return null;
              return { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name };
            } catch {
              return null;
            }
          };
        },
      };
    },
    fallback(cfg) {
      const firstLogin = cfg?.users?.[0]?.login ?? "admin";
      return { login: firstLogin, id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
    },
  },

  google: {
    async load() {
      const mod = await import("@emulators/google");
      return { plugin: mod.googlePlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      const firstEmail = cfg?.users?.[0]?.email ?? "testuser@gmail.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "profile"] };
    },
  },

  vercel: {
    async load() {
      const mod = await import("@emulators/vercel");
      return { plugin: mod.vercelPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      const firstLogin = cfg?.users?.[0]?.username ?? "admin";
      return { login: firstLogin, id: 1, scopes: [] };
    },
  },

  slack: {
    async load() {
      const mod = await import("@emulators/slack");
      return { plugin: mod.slackPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback() {
      return { login: "U000000001", id: 1, scopes: [] };
    },
  },

  apple: {
    async load() {
      const mod = await import("@emulators/apple");
      return { plugin: mod.applePlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      const firstEmail = cfg?.users?.[0]?.email ?? "testuser@icloud.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "name"] };
    },
  },

  okta: {
    async load() {
      const mod = await import("@emulators/okta");
      return { plugin: mod.oktaPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      const firstLogin = cfg?.users?.[0]?.login ?? cfg?.users?.[0]?.email ?? "testuser@okta.local";
      return { login: firstLogin, id: 1, scopes: ["openid", "profile", "email", "groups"] };
    },
  },

  aws: {
    async load() {
      const mod = await import("@emulators/aws");
      return { plugin: mod.awsPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback() {
      return { login: "admin", id: 1, scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"] };
    },
  },

  resend: {
    async load() {
      const mod = await import("@emulators/resend");
      return { plugin: mod.resendPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback() {
      return { login: "re_test_admin", id: 1, scopes: [] };
    },
  },

  stripe: {
    async load() {
      const mod = await import("@emulators/stripe");
      return { plugin: extendStripePlugin(mod.stripePlugin), seedFromConfig(store, baseUrl, config, webhooks) {
        mod.seedFromConfig(store, baseUrl, config, webhooks);
        seedStripeBilling(store, config);
      } };
    },
    fallback() {
      return { login: "sk_test_admin", id: 1, scopes: [] };
    },
  },

  mongoatlas: {
    async load() {
      const mod = await import("@emulators/mongoatlas");
      return { plugin: mod.mongoatlasPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback() {
      return { login: "admin", id: 1, scopes: [] };
    },
  },

  clerk: {
    async load() {
      const mod = await import("@emulators/clerk");
      return { plugin: mod.clerkPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      const firstEmail = cfg?.users?.[0]?.email_addresses?.[0] ?? "test@example.com";
      return { login: firstEmail, id: 1, scopes: [] };
    },
  },

  linear: {
    async load() {
      const mod = await import(bundled("dist-7HIQBPU6.js"));
      return { plugin: mod.linearPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      const firstEmail = cfg?.users?.[0]?.email ?? "admin@example.com";
      return { login: firstEmail, id: 1, scopes: [] };
    },
  },

  twilio: {
    async load() {
      const mod = await import(bundled("dist-RJB3ANOP.js"));
      return { plugin: mod.twilioPlugin, seedFromConfig: mod.seedFromConfig };
    },
    fallback(cfg) {
      return { login: cfg?.account?.sid ?? "AC00000000000000000000000000000000", id: 1, scopes: [] };
    },
  },
};

// WorldFixture-authored vendors, discovered rather than listed.
//
// Upstream covers fourteen; everything else — an internal API, a vendor nobody has
// emulated — is ours to write, and writing one should not mean editing this file.
// A directory under `src/vendors/<name>/` exporting `{plugin, seedFromConfig?,
// fallback?}` is loaded by that name, where `plugin` is core's own `ServicePlugin`:
//
//     export const plugin = {
//       name: "notion",
//       register(app, store, webhooks, baseUrl, tokenMap) { app.get("/v1/users", ...) },
//     };
//
// It then needs exactly what an upstream vendor needs and nothing more: a port and a
// surface in `EmulatorProfile`, and a `<name>_base_url` binding. Its seed block is
// already generic — the composer hands `seed[<name>]` to whatever `seedFromConfig`
// the directory exports.
//
// A local directory SHADOWS an upstream vendor of the same name, which is how a
// vendor gets replaced wholesale rather than patched.
async function discoverLocalVendors() {
  const dir = new URL("./vendors/", import.meta.url);
  let names;

  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return {};
  }

  const found = {};

  for (const name of names) {
    const mod = await import(new URL(`./vendors/${name}/index.mjs`, import.meta.url));

    if (!mod.plugin?.register) {
      throw new Error(`src/vendors/${name} exports no plugin with a register()`);
    }

    found[name] = {
      async load() {
        return { plugin: mod.plugin, seedFromConfig: mod.seedFromConfig };
      },
      // Local vendors need no fallback identity unless they say so: an anonymous
      // caller resolving to nobody is the safer default for an API we wrote.
      fallback: mod.fallback ?? (() => ({ login: name, id: 1, scopes: [] })),
      local: true,
    };
  }

  return found;
}

export const LOCAL_VENDORS = await discoverLocalVendors();

export const ALL_VENDORS = { ...VENDORS, ...LOCAL_VENDORS };

export const VENDOR_NAMES = Object.keys(ALL_VENDORS);
