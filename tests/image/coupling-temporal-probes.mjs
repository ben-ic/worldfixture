import { setTimeout as sleep } from "node:timers/promises";
import { docker, removeOwnedContainer } from "./coupling-runner.mjs";

const rows = value => Array.isArray(value) ? value : [];
const decode = value => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");
function feedRows(xml) {
  if (!/<rss\b/.test(xml) || !/<channel>/.test(xml)) throw new Error("Feed response is not RSS");
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map(match => Object.fromEntries(
    ["guid", "title", "description", "link", "pubDate"].map(tag => [tag, decode(match[1].match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "")])));
}

// This observes the unchanged product's HTTP process clock. The launch and
// readiness times bound its start; the test never sets that clock or edits data.
export async function observeFeeds({ feeds, base, launchAt, readyAt, fetchImpl = fetch, now = Date.now,
  wait = ms => sleep(ms), signal, onProgress = () => {}, checks = [], responses = [] }) {
  const observations = new Map();
  const add = (check, passed, detail = {}) => checks.push({ check, status: passed ? "passed" : "failed", ...detail });
  const delays = [...new Set(feeds.flatMap(feed => rows(feed.items).map(item => (item.available_after_seconds ?? 0) * 1000)))];
  if (delays.some(delay => !Number.isSafeInteger(delay) || delay < 0)) throw new Error("Invalid feed delay");
  const deadlines = [...new Set([readyAt, ...delays.filter(Boolean).flatMap(delay => [launchAt + delay - 1000, readyAt + delay + 1000])])]
    .filter(deadline => deadline >= readyAt).sort((a, b) => a - b);
  for (const deadline of deadlines) {
    while (now() < deadline) {
      signal?.throwIfAborted();
      await wait(Math.min(1000, deadline - now()));
    }
    onProgress({ elapsed_seconds: Math.floor((now() - readyAt) / 1000), remaining_seconds: Math.max(0, Math.ceil((deadlines.at(-1) - now()) / 1000)) });
    for (const feed of feeds) {
      signal?.throwIfAborted();
      const before = now();
      const timeout = AbortSignal.timeout(10000);
      const response = await fetchImpl(`${base}${feed.path}`, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const body = await response.text(), after = now();
      responses.push({ provider: "http", path: feed.path, status: response.status, body });
      if (!response.ok) throw new Error(`${feed.path} returned HTTP ${response.status}`);
      const served = feedRows(body), ids = served.map(item => item.guid);
      const suffix = `${feed.path}.${Math.floor(before - readyAt)}`;
      add(`http.temporal.identities.${suffix}`, new Set(ids).size === ids.length && ids.every(id => feed.items.some(item => item.id === id)), { actual: ids });
      const expectedOrder = feed.items.filter(item => ids.includes(item.id)).map(item => item.id);
      add(`http.temporal.order.${suffix}`, JSON.stringify(ids) === JSON.stringify(expectedOrder), { expected: expectedOrder, actual: ids });
      for (const item of feed.items) {
        const servedItem = served.find(value => value.guid === item.id);
        const delay = (item.available_after_seconds ?? 0) * 1000;
        const key = `${feed.path}:${item.id}`;
        const history = observations.get(key) ?? { absent_before_due: false, present_after_due: false };
        if (!servedItem) history.last_absent_read_started = before;
        if (servedItem && history.first_present_read_completed === undefined) history.first_present_read_completed = after;
        if (after < launchAt + delay) {
          add(`http.temporal.not-early.${suffix}.${item.id}`, !servedItem, { earliest_due: launchAt + delay, read_completed: after });
          if (!servedItem) history.absent_before_due = true;
        }
        if (before >= readyAt + delay) {
          add(`http.temporal.delivered.${suffix}.${item.id}`, Boolean(servedItem), { latest_due: readyAt + delay, read_started: before });
          if (servedItem) history.present_after_due = true;
        }
        if (servedItem) {
          const expected = [item.title, item.summary, `${base}${item.path}`, new Date(item.published_at).toUTCString()];
          const actual = [servedItem.title, servedItem.description, servedItem.link, servedItem.pubDate];
          add(`http.temporal.content.${suffix}.${item.id}`, JSON.stringify(expected) === JSON.stringify(actual), { expected, actual });
        }
        observations.set(key, history);
      }
    }
  }
  for (const feed of feeds) for (const item of feed.items) {
    const history = observations.get(`${feed.path}:${item.id}`);
    add(`http.temporal.observed-transition.${feed.path}.${item.id}`, Boolean(history?.present_after_due && (!item.available_after_seconds || history.absent_before_due)), {
      ...history, observation_window: [history?.last_absent_read_started ?? null, history?.first_present_read_completed ?? null],
      detail: "Proves absence and presence at sampled reads. The transition lies within the recorded observation window; this does not prove its exact time or absence between reads. A missed pre-arrival observation fails coverage." });
  }
  return { checks, responses, coverage: [{ collection: "site.feed.items", provider: "http", path: feeds.map(feed => feed.path).join(", "),
    status: checks.some(check => check.status === "failed") ? "failed" : "passed", detail: "Complete content and arrival transitions through a separate HTTP process from the same image and immutable artifact; process time is bounded by launch/readiness." }] };
}

export async function runTemporalWorld({ artifact, image, name, owner, signal, onProgress, run = docker }) {
  const feeds = rows(artifact.projections["http-targets"]?.feeds);
  const checks = [], responses = [], coverage = [];
  if (!feeds.length) return { checks, responses, coverage };
  const launchAt = Date.now();
  try {
    if (artifact.checks.some(check => check.status === "failed")) throw new Error("Artifact integrity failed before temporal service launch");
    // This standalone container bypasses the supervisor's bind assignment.
    // Docker needs its interface listener; the host publication stays loopback.
    await run(["run", "--detach", "--name", name, "--label", `worldfixture.coupling.owner=${owner}`, "--publish", "127.0.0.1::8080/tcp",
      "--mount", `type=bind,src=${artifact.path},dst=/world,readonly`, "--env", "WORLDFIXTURE_WORLD_PATH=/world",
      "--env", "WORLDFIXTURE_HTTP_TARGETS_LISTEN=0.0.0.0:8080",
      "--entrypoint", "node", image, "/opt/worldfixture/emulators/http-targets/server.mjs"]);
    const [inspection] = JSON.parse((await run(["inspect", name])).stdout);
    const port = inspection.NetworkSettings.Ports["8080/tcp"]?.[0];
    if (port?.HostIp !== "127.0.0.1") throw new Error("Temporal service port is not on loopback");
    const base = `http://127.0.0.1:${port.HostPort}`;
    let readyAt;
    while (Date.now() - launchAt < 30000) {
      signal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(1000);
        const response = await fetch(`${base}/readyz`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        const raw = await response.text();
        let body; try { body = JSON.parse(raw); } catch { body = raw; }
        responses.push({ provider: "http", path: "/readyz", status: response.status, body });
        if (response.ok && body.ready && body.world_id === artifact.identity.id && body.world_version === artifact.identity.version) {
          readyAt = Date.now(); break;
        }
      } catch { /* The newly launched service can need a short startup period. */ }
      await sleep(100);
    }
    if (!readyAt) throw new Error("Temporal service did not return the selected world identity within 30 seconds");
    checks.push({ check: "http.temporal.clock-bounds", status: "passed", launch_at: launchAt, ready_at: readyAt,
      detail: "Independent HTTP process time; no assertion of runtime-clock alignment." });
    const result = await observeFeeds({ feeds, base, launchAt, readyAt, signal, onProgress, checks, responses });
    coverage.push(...result.coverage);
  } catch (error) {
    checks.push({ check: "http.temporal.read", status: "failed", detail: error.message });
    coverage.push({ collection: "site.feed.items", provider: "http", path: null, status: "failed", detail: error.message });
  } finally {
    try {
      const logs = await run(["logs", "--tail", "100", name]);
      checks.push({ check: "http.temporal.logs", status: "passed", detail: logs.stdout + logs.stderr });
    } catch (error) { checks.push({ check: "http.temporal.logs", status: "failed", detail: error.message }); }
    try { await removeOwnedContainer(name, owner, run); }
    catch (error) { checks.push({ check: "http.temporal.cleanup", status: "failed", detail: error.message }); }
  }
  return { checks, responses, coverage };
}
