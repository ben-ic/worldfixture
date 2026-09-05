// WorldFixture API emulator — the composer.
//
// This artifact used to be the `emulate` CLI with a `--service` list. It is now a
// WorldFixture entry point over the same upstream code, published as separate npm packages
// (`@emulators/core` and one per vendor) and pinned by lockfile integrity.
//
// WHY COMPOSE RATHER THAN FORK. The value in `emulate` is ~46,000 lines of vendor route
// implementations, and forking it would mean owning all of them, merging every upstream
// fix by hand, and replacing a supply chain of "npm ci against sha512 integrity, no
// source of ours" with "WorldFixture maintains a TypeScript monorepo". What we actually
// needed was a seam to ADD to it: `@emulators/core` exports `createServer`, `serve` and
// the `ServicePlugin` interface, and each vendor package exports its plugin. Only the
// CLI's service registry is closed; the library is open. So upstream's routes stay
// upstream, and the ~200 lines that wire them together are ours.
//
// WHAT COMPOSING BOUGHT, beyond somewhere to put Gmail push:
//
//   * EXPLICIT PORTS. The CLI assigns `base + index` over the `--service` argument
//     list, so the artifact's CMD and the control plane's listener list had to agree by
//     hand — and a vendor added to one and not the other shifted every port after it,
//     silently, leaving apps dialling a port with something else behind it. Ports now
//     arrive as `WORLDFIXTURE_PORT_<VENDOR>`, one per vendor, named.
//
//   * BIND ADDRESSES. `serve()` takes a hostname and the CLI never passes one, so every
//     listener bound every interface. A back channel can now bind loopback and only a
//     published surface binds the bridge.
//
//   * BY NEED. A vendor with no port assigned is not started, so a session pays for
//     what it uses rather than for all thirteen.
//
// WHAT IT COST. `@emulators/linear` and `@emulators/twilio` ARE NOT PUBLISHED. Their
// plugins are imported from the pinned CLI bundle, so an upstream version change must
// re-measure those internal filenames. This keeps both vendors on the same visible
// Store path as the published packages, which exact reset requires.

import { createServer, restoreTokenMap, serializeTokenMap, serve } from "@emulators/core";
import { getGoogleStore } from "@emulators/google";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ALL_VENDORS, LOCAL_VENDORS, VENDOR_NAMES } from "./registry.mjs";
import { resolveBaseUrl } from "./base-url.mjs";
import { createGoogleSigningOverride } from "./overrides/google-signing.mjs";
import { wrapGoogleBatch } from "./overrides/google-batch.mjs";
import { removeInjectedGoogleDefault } from "./overrides/google-users.mjs";
import { removeInjectedMicrosoftDefault } from "./overrides/microsoft-users.mjs";
import { removeInjectedClerkDefault } from "./overrides/clerk-users.mjs";
import { removeInjectedAtlasDefault } from "./overrides/mongoatlas-projects.mjs";
import { removeInjectedAccounts } from "./overrides/injected-accounts.mjs";
import { seedSlackHistory } from "./overrides/slack-history.mjs";
import { seedGitHubIssues } from "./overrides/github-issues.mjs";
import { startGmailPush } from "./plugins/gmail-push.mjs";
import { scheduleArrivals } from "./plugins/arrivals.mjs";
import { loadSeedConfig } from "./seed-config.mjs";
import { READY_PATH, withReadyEndpoint } from "./ready.mjs";

const log = (line) => console.log(`[emulator] ${line}`);
const snapshotPath = process.env.WORLDFIXTURE_STATE_PATH
  ? join(process.env.WORLDFIXTURE_STATE_PATH, "emulate-snapshot.json")
  : undefined;

function loadSnapshot() {
  if (!snapshotPath || !existsSync(snapshotPath)) return null;
  const value = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (value?.api_version !== "worldfixture.emulate-snapshot/v1" || typeof value.vendors !== "object") {
    throw new Error("composer snapshot has an unknown format");
  }
  return value;
}

const acceptedSnapshot = loadSnapshot();

// ---- configuration -------------------------------------------------------

const seedPath = process.env.WORLDFIXTURE_SEED ?? "seed.yaml";
let seedConfig;
try {
  seedConfig = loadSeedConfig({
    seedPath,
    worldPath: process.env.WORLDFIXTURE_WORLD_PATH,
    sessionOverlay: process.env.WORLDFIXTURE_SEED_OVERLAY,
    log,
  });
} catch (err) {
  console.error(`[emulator] ${err.message}`);
  process.exit(1);
}

// Which vendors to start, and where. A vendor is enabled by being given a port —
// there is no separate list to keep in sync with this one.
function requested() {
  return VENDOR_NAMES.flatMap((vendor) => {
    const port = Number(process.env[`WORLDFIXTURE_PORT_${vendor.toUpperCase()}`]);
    if (!Number.isInteger(port) || port <= 0) return [];

    // Loopback by default: a fixture is reached by the app beside it, and only a
    // published surface needs to be reachable from the µVM's bridge.
    const bind = process.env[`WORLDFIXTURE_BIND_${vendor.toUpperCase()}`] ?? "127.0.0.1";
    return [{ vendor, port, bind }];
  });
}

// Copied from upstream's own wiring: seeded tokens become the auth token map, ids
// counting from 100, and an unseeded emulator still answers to `test_token_admin`.
function tokenMap() {
  const tokens = {};

  if (seedConfig?.tokens) {
    let tokenId = 100;
    for (const [token, user] of Object.entries(seedConfig.tokens)) {
      tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
    }
  } else {
    tokens["test_token_admin"] = {
      login: "admin",
      id: 2,
      scopes: ["repo", "user", "admin:org", "admin:repo_hook"],
    };
  }

  return tokens;
}

// ---- one vendor ----------------------------------------------------------

async function startComposed({ vendor, port, bind }, tokens, started) {
  const entry = ALL_VENDORS[vendor];
  const loaded = await entry.load();

  const inputSeed = seedConfig?.[vendor];
  const prepared = inputSeed && loaded.prepareSeed ? await loaded.prepareSeed(inputSeed) : undefined;
  const svcSeed = prepared?.config ?? inputSeed;

  const seedBaseUrl = typeof svcSeed?.baseUrl === "string" && svcSeed.baseUrl.length > 0 ? svcSeed.baseUrl : undefined;
  const baseUrl = resolveBaseUrl({ service: vendor, port, seedBaseUrl });

  // The resolver has to be handed to `createServer` before the store it reads exists,
  // so it is captured by closure and filled in immediately after. Upstream does the
  // same, for the same reason.
  let cachedResolver;
  const appKeyResolver = loaded.createAppKeyResolver ? (appId) => cachedResolver(appId) : undefined;

  // NO `fallbackUser`, deliberately — an unknown token must not become somebody.
  //
  // WHAT IT ACTUALLY DOES. `fallbackUser` reads like "who an anonymous caller is", and
  // that is what upstream's registry calls it, but `@emulators/core`'s auth middleware
  // consults it in exactly one place:
  //
  //     if (authHeader) { ... let user = tokens.get(token);
  //                       if (!user && fallbackUser && token.length > 0) user = fallbackUser; }
  //
  // It is reached ONLY when a request presents a bearer token that is not in the token
  // map. A request with no `Authorization` header never enters that branch at all, so
  // an anonymous caller resolves to nobody with or without it, and every vendor's own
  // "not authenticated" answer is unchanged. Measured both ways against Slack and
  // GitHub before this line was written.
  //
  // So the effect of passing it was: any unrecognized token authenticates as the
  // vendor's default identity. `slack_token_priya-raman` — a person the world does not
  // grant a token — came back from `auth.test` as `admin`/`U000000001`, and a bogus
  // GitHub token came back as the seed's first user. A fixture whose whole job is to
  // say who somebody is cannot answer "whoever you like".
  //
  // OAUTH IS NOT AFFECTED. Every vendor's token endpoint inserts the token it mints
  // into the same `tokenMap` this server was built with (`@emulators/slack` 2603/2619,
  // `@emulators/google` 3194/3248, `@emulators/github` 11398/11752, and the same in
  // microsoft, apple and clerk), so an OAuth-issued token is a KNOWN token and never
  // took the fallback path. The authorize, callback and token-exchange routes read
  // request bodies rather than `authUser`, so a `Authorization: Basic` header on a
  // token exchange — which does not parse as a bearer token — does not need it either.
  //
  // `entry.fallback()` stays in the registry: `checkSeedResolves` still needs each
  // vendor's own idea of its default identity to avoid crying wolf about Slack's
  // generated `U…` logins. It is a diagnostic input now, not an authentication one.
  const { app, store, webhooks, tokenMap: serverTokens } = createServer(loaded.plugin, {
    port,
    baseUrl,
    tokens,
    appKeyResolver,
  });
  cachedResolver = loaded.createAppKeyResolver?.(store);

  loaded.plugin.seed?.(store, baseUrl);

  // BETWEEN the two, deliberately. Upstream's `seedFromConfig` attributes the
  // world's own content to whichever user happens to be first, so an injected
  // account removed afterwards has already signed the world's Slack channels,
  // Linear issues and Vercel team. See `injected-accounts.mjs`.
  const swept = removeInjectedAccounts(vendor, store, svcSeed);
  if (swept.removed) {
    log(`${vendor}: removed ${swept.removed} account(s) the world never declared` +
      (swept.cascaded ? `, and ${swept.cascaded} row(s) that only referenced them` : ""));
  }

  if (svcSeed && loaded.seedFromConfig) {
    loaded.seedFromConfig(store, baseUrl, svcSeed, webhooks);
  }

  if (vendor === "google") removeInjectedGoogleDefault(store, svcSeed);
  if (vendor === "microsoft") removeInjectedMicrosoftDefault(store, svcSeed);
  if (vendor === "clerk") removeInjectedClerkDefault(store, svcSeed);
  if (vendor === "mongoatlas") removeInjectedAtlasDefault(store, svcSeed);
  if (vendor === "github") {
    const seeded = seedGitHubIssues(store, svcSeed);
    if (seeded.issues) log(`github issues: ${seeded.issues} seeded`);
  }
  if (vendor === "slack") {
    const seeded = seedSlackHistory(store, svcSeed);
    if (seeded.messages || seeded.channels) {
      log(`slack history: ${seeded.messages} messages, ${seeded.channels} channel topics`);
    }
  }

  const saved = acceptedSnapshot?.vendors?.[vendor];
  if (acceptedSnapshot && !saved) throw new Error(`composer snapshot has no ${vendor} store`);
  if (saved) {
    store.restore(saved.store);
    restoreTokenMap(serverTokens, saved.tokens);
  }

  let fetchHandler = app.fetch;
  let googlePrivateJwk;
  if (vendor === "google") {
    const accessToken = googleSeedToken(seedConfig);
    const wrap = await createGoogleSigningOverride({
      accessToken,
      privateJwk: acceptedSnapshot?.google_signing_key,
    });
    googlePrivateJwk = wrap.privateJwk;
    fetchHandler = wrapGoogleBatch(wrap(fetchHandler));
  }

  // Every listener answers the aggregate readiness endpoint, so a caller needs
  // any one composer address rather than the right one. `started` is shared by
  // reference and is complete before the first request can arrive.
  serve({ fetch: withReadyEndpoint(fetchHandler, started), port, hostname: bind });
  log(`${vendor} → ${baseUrl} (listening on ${bind}:${port})`);

  checkSeedResolves(vendor, svcSeed, tokens, entry.fallback(svcSeed).login);

  return { vendor, port, baseUrl, store, tokenMap: serverTokens, googlePrivateJwk };
}

// OAuth and Gmail must name the same seeded person. Token insertion order is
// not an identity rule: the first token may belong to another vendor.
function googleSeedToken(seed) {
  const people = new Set((seed?.google?.users ?? []).map((user) => user.email).filter(Boolean));
  const match = Object.entries(seed?.tokens ?? {}).find(([, subject]) => people.has(subject?.login));
  if (!match) throw new Error("Google is seeded but no token resolves a Google user");
  return match[0];
}

// A seeded vendor whose tokens resolve nobody answers 401 for everything, and says so
// only when an app calls it — which is at demo time, in front of a visitor.
//
// This is the failure that sent us looking in the first place: GitHub had no seed
// block, so its fallback resolved a login the store had never heard of and every
// request was `Requires authentication`. Adding a seed block alone did not fix it
// either, because the token map is shared across listeners and a Google-scoped token
// reaching GitHub is still refused. Both halves have to line up, and neither is
// visible without asking.
//
// One line at boot instead. It cannot be an error: a vendor seeded for a browser
// sign-in and never called with a bearer token is a legitimate configuration.
function checkSeedResolves(vendor, svcSeed, tokens, fallbackLogin) {
  if (!svcSeed) return;

  const logins = new Set(
    [
      ...(svcSeed.users ?? []).flatMap((u) => [u.login, u.email, u.username, ...(u.email_addresses ?? [])]),
      svcSeed.account?.sid,
      // The vendor's OWN idea of who an anonymous caller is, which is not always a
      // field in the seed. Slack identifies by a generated `U…` id and its fallback
      // names one that seeding creates, so reading the seed alone reports a problem
      // that is not there — measured, after this check cried wolf about exactly that.
      fallbackLogin,
    ].filter(Boolean),
  );

  if (logins.size === 0) return;

  const resolving = Object.entries(tokens).filter(([, user]) => logins.has(user.login));

  if (resolving.length === 0) {
    log(
      `WARNING ${vendor} is seeded but no token in the seed resolves any of its ` +
        `identities, so every authenticated call will answer 401. Add one under ` +
        `tokens: with a login this vendor knows.`,
    );
  }
}

// ---- start ---------------------------------------------------------------

const enabled = requested();

if (enabled.length === 0) {
  console.error("[emulator] no vendor was given a port — set WORLDFIXTURE_PORT_<VENDOR>");
  process.exit(1);
}

const tokens = tokenMap();
const started = [];

const localNames = Object.keys(LOCAL_VENDORS);
if (localNames.length > 0) log(`local vendors discovered: ${localNames.join(", ")}`);

for (const target of enabled) {
  started.push(await startComposed(target, tokens, started));
}

log(`aggregate readiness → ${READY_PATH} on every started listener`);

if (!acceptedSnapshot && snapshotPath) {
  const snapshot = {
    api_version: "worldfixture.emulate-snapshot/v1",
    vendors: Object.fromEntries(started.map((entry) => [entry.vendor, {
      store: entry.store.snapshot(),
      tokens: serializeTokenMap(entry.tokenMap),
    }])),
    google_signing_key: started.find((entry) => entry.vendor === "google")?.googlePrivateJwk,
  };
  mkdirSync(dirname(snapshotPath), { recursive: true });
  const temporary = `${snapshotPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(temporary, snapshotPath);
  log(`accepted snapshot → ${snapshotPath}`);
}

// ---- Gmail push ----------------------------------------------------------

const google = started.find((s) => s.vendor === "google" && s.store);

if (google) {
  const pushUrl = process.env.WORLDFIXTURE_PUBSUB_PUSH_URL;

  if (pushUrl) {
    startGmailPush({ store: google.store, getGoogleStore, pushUrl, log });
    log(`gmail push → ${new URL(pushUrl).origin}${new URL(pushUrl).pathname}`);
  } else {
    log("gmail push not configured (no WORLDFIXTURE_PUBSUB_PUSH_URL) — watch will register and never deliver");
  }

  const [firstToken] = Object.keys(seedConfig?.tokens ?? {});

  // The runtime scheduler plays every timeline arrival when there is a runtime
  // above this process. Playing them here as well would deliver each one twice.
  if (process.env.WORLDFIXTURE_TIMELINE_OWNER === "runtime") {
    log("timeline arrivals are played by the runtime scheduler, not here");
  } else scheduleArrivals({
    arrivals: seedConfig?.worldfixture?.arrivals,
    // Loopback rather than `baseUrl`: the advertised origin is the session's public
    // edge, and going out and back to insert our own mail would be absurd.
    origin: `http://127.0.0.1:${google.port}`,
    token: firstToken,
    defaultUser: seedConfig?.tokens?.[firstToken]?.login,
    log,
  });
}

// A joined service is not supervised the way the app is: if this process exits the
// launch keeps going and every fixture call fails with a connection refused. Say so.
process.on("uncaughtException", (err) => {
  console.error(`[emulator] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
