import {readFileSync, statSync} from "node:fs";
import {createServer} from "node:http";
import {join} from "node:path";

import {feedItemsAt} from "./feed.mjs";

const maxProjectionBytes = 4 * 1024 * 1024;
const worldPath = process.env.WORLDFIXTURE_WORLD_PATH;
if (!worldPath) {
  console.error("worldfixture: missing world: WORLDFIXTURE_WORLD_PATH is required");
  process.exit(64);
}
const projectionPath = join(worldPath, "projections", "http-targets.json");
const listen = process.env.WORLDFIXTURE_HTTP_TARGETS_LISTEN ?? "0.0.0.0:8080";
const configuredPublicUrl = process.env.WORLDFIXTURE_HTTP_TARGETS_PUBLIC_URL;
const publicOrigin = configuredPublicUrl ? normalizePublicUrl(configuredPublicUrl) : null;

function loadProjection(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > maxProjectionBytes) {
    throw new Error("HTTP target projection size is invalid");
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.api_version !== "worldfixture.http-targets/v1") {
    throw new Error("HTTP target projection version is invalid");
  }
  for (const collection of ["feeds", "pages", "probes", "metrics"]) {
    if (!Array.isArray(value[collection])) throw new Error(`${collection} must be an array`);
  }
  for (const feed of value.feeds) {
    if (!Array.isArray(feed.items)) throw new Error("feed items must be an array");
    if (feed.items.some((item) =>
      item.available_after_seconds !== undefined &&
      (!Number.isInteger(item.available_after_seconds) || item.available_after_seconds < 0)
    )) {
      throw new Error("feed arrival time is invalid");
    }
  }
  const paths = [
    ...value.feeds.map((item) => item.path),
    ...value.pages.map((item) => item.path),
    ...value.probes.map((item) => item.path),
    ...(value.api?.openapi_path === undefined ? [] : [value.api.openapi_path]),
    ...Object.keys(value.api?.responses ?? {}),
  ];
  if (paths.some((path) => typeof path !== "string" || !path.startsWith("/") || path.includes(".."))) {
    throw new Error("HTTP target projection contains an unsafe route");
  }
  return value;
}

function parseListen(value) {
  const separator = value.lastIndexOf(":");
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WORLDFIXTURE_HTTP_TARGETS_LISTEN is invalid");
  }
  return {host, port};
}

const projection = loadProjection(projectionPath);
const counters = new Map();
// The one wall-clock read left in this process: the session's own start, taken
// once at boot. Everything time-dependent is measured from it through
// `feedItemsAt`, which takes the clock as a parameter, so a test -- and later the
// runtime -- supplies its own without this line moving.
const startedAt = Date.now();

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const escapeXml = escapeHtml;

function requestOrigin(request) {
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = typeof forwarded === "string" && forwarded.split(",")[0].trim() === "https"
    ? "https"
    : "http";
  const host = request.headers.host ?? "http-targets.demo.worldfixture.test";
  return `${protocol}://${host}`;
}

function normalizePublicUrl(value) {
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("WORLDFIXTURE_HTTP_TARGETS_PUBLIC_URL is invalid");
  }
  return parsed.origin;
}

function contentOrigin(request) {
  return publicOrigin ?? requestOrigin(request);
}

function send(response, status, type, body, method = "GET") {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    "Content-Type": type,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : bytes);
}

function sendJson(response, status, value, method) {
  send(response, status, "application/json; charset=utf-8", `${JSON.stringify(value, null, 2)}\n`, method);
}

const organizationName = projection.organization?.name ?? "a fictional company";

// EVERY LINK ON THIS PAGE IS A PUBLIC SESSION URL, and it is read by a browser
// that is not in the µVM. A guest-local `http://127.0.0.1:<port>` printed here is
// a dead end on the visitor's own machine, which is the same defect the app-facing
// bindings had: correct inside the guest, useless the moment a human sees it.
//
// The routes come from the projection rather than from a list written down here,
// so a world that renames a route cannot leave a broken link behind. A route the
// projection does not define is omitted rather than printed dead.
function targetLinks(origin) {
  const probe = (mode) => projection.probes.find((item) => item.mode === mode);
  const feed = projection.feeds[0];
  const changing = projection.pages.find(
    (item) => Array.isArray(item.request_variants) && item.request_variants.length > 0
  );
  return [
    [probe("stable")?.path, "Healthy service",
      "Answers every request, so a monitor shows this one up."],
    [probe("failing")?.path, "Failing service",
      "Never answers successfully, so a monitor shows this one down."],
    [probe("flapping")?.path, "Changing service",
      "Fails on some requests and succeeds on others, so a monitor records an outage and then a recovery."],
    [feed ? "/feeds/" : undefined, "RSS feed preview",
      "The same stories as a readable page. More arrive while the session runs."],
    [feed?.path, "Raw RSS feed",
      "The XML a news reader subscribes to."],
    [changing?.path, "Changing customer page",
      "Its wording changes as it is read. That change is what a page watcher saves."],
    [projection.api?.openapi_path, "OpenAPI document",
      "The API description that documentation tools render."],
  ]
    .filter(([path]) => typeof path === "string")
    .map(([path, label, note]) => ({href: origin + path, label, note}));
}

const style = `body{margin:0;background:#f3f5f7;color:#172033;font:16px/1.6 system-ui,sans-serif}header,main{max-width:920px;margin:auto}header{padding:64px 24px 28px}main{padding:0 24px 64px}h1{font-size:38px;line-height:1.15;margin:0 0 16px}h2{font-size:20px;margin:0 0 8px}section,aside{background:white;border:1px solid #dfe4ea;border-radius:14px;padding:22px;margin:16px 0}aside{border-color:#e5ad3c;background:#fff9e8}.explanation{border:2px solid #2463a8;background:#f7fbff}.label{display:inline-block;border-radius:999px;background:#dcecff;color:#174f8b;font-size:12px;font-weight:750;letter-spacing:.04em;padding:4px 10px;text-transform:uppercase;margin-bottom:10px}.notice{color:#526071;font-size:14px}.eyebrow{color:#2463a8;font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:13px}.lead{font-size:18px;color:#31415a;margin:0}ul.uses,ul.targets{list-style:none;margin:12px 0 0;padding:0}ul.uses li{padding:6px 0 6px 18px;position:relative}ul.uses li:before{content:"";position:absolute;left:0;top:14px;width:7px;height:7px;border-radius:50%;background:#2463a8}ul.targets li{border-top:1px solid #eef1f4;padding:12px 0}ul.targets li:first-child{border-top:0}ul.targets a{display:block;font-weight:650;color:#1a4d8f;word-break:break-all}ul.targets span{display:block;color:#526071;font-size:14px}.home{display:inline-block;margin-top:8px;color:#1a4d8f;font-weight:650}.sitehead{margin:34px 0 0;font-size:15px;color:#526071;text-transform:uppercase;letter-spacing:.06em}`;

function document_(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`;
}

function pageSections(page) {
  return [
    ...(page.body === undefined || page.body === null ? [] : [`<section><p>${escapeHtml(page.body)}</p></section>`]),
    ...(Array.isArray(page.sections) ? page.sections : []).map((section) =>
      `<section><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p></section>`
    ),
  ].join("");
}

// The visitor arrives here one click from an application they have never used.
// The old page opened with "This is not the app you launched", which answers a
// question nobody asked and leaves the two that matter — what IS this, and what
// do I do now — for them to work out on their own.
//
// So: the plain fact first, then who reads the data, then the data itself, then
// the instruction to go back. The fictional site's own content stays, below,
// because it is the thing being described rather than the explanation of it.
function renderRoot(page, origin) {
  const org = escapeHtml(organizationName);
  const links = targetLinks(origin).map((link) =>
    `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a><span>${escapeHtml(link.note)}</span></li>`
  ).join("");
  // The made-up site's OWN copy, kept and kept subordinate. It is what the
  // explanation above is describing, so dropping it would leave the page
  // explaining something the visitor cannot see.
  const sections = [
    `<section><h2>${escapeHtml(page.heading)}</h2><p>${escapeHtml(page.summary)}</p></section>`,
    pageSections(page),
  ].join("");
  return document_(`Test data for this WorldFixture session`, `<header>` +
    `<div class="eyebrow">WorldFixture session data</div>` +
    `<h1>This is test data used by the app you launched.</h1>` +
    `<p class="lead">WorldFixture made up a company called ${org} and built it this website, so the application you launched has real content to work with instead of an empty screen. None of it is a real company, customer, or outage.</p>` +
    `</header><main>` +
    `<section class="explanation"><div class="label">What the app does with it</div>` +
    `<ul class="uses">` +
    `<li><strong>Uptime Kuma</strong> and <strong>Gatus</strong> monitor ${org}&#39;s healthy, failing, and changing services.</li>` +
    `<li><strong>FreshRSS</strong> imports ${org}&#39;s company updates.</li>` +
    `<li><strong>changedetection.io</strong> saves changes to ${org}&#39;s customer page.</li>` +
    `<li><strong>Swagger UI</strong> renders ${org}&#39;s API document.</li>` +
    `</ul>` +
    `<p><strong>Go back to the application tab to see the result.</strong> You launched one of these, and it is reading this same data now.</p>` +
    `</section>` +
    `<section><h2>The data itself</h2><ul class="targets">${links}</ul></section>` +
    `<h2 class="sitehead">${escapeHtml(organizationName)}&#39;s made-up website</h2>` +
    sections +
    `<p class="notice">${escapeHtml(projection.synthetic_notice)}</p>` +
    `</main>`);
}

function pageNote(page) {
  if (page.path === "/feeds/") {
    return {
      label: "Test data",
      heading: "This is the news feed the app reads",
      body: "A news reader subscribes to it and imports these stories. More arrive while the session runs, so refreshing the subscription brings in new ones.",
    };
  }
  return {
    label: "Test data",
    heading: "This is a page from the made-up company website",
    body: "Its wording changes as it is read, and saving that change is what a page watcher does. Go back to the application tab to see what it recorded.",
  };
}

function renderPage(page, origin) {
  const count = counters.get(page.path) ?? 0;
  counters.set(page.path, count + 1);
  const variants = Array.isArray(page.request_variants) ? page.request_variants : [];
  const variant = variants.length ? variants[Math.min(count, variants.length - 1)] : null;
  const sections = pageSections(page);
  const change = variant ? `<aside><strong>Live note</strong><p>${escapeHtml(variant)}</p></aside>` : "";
  const note = pageNote(page);
  const explanation = `<section class="explanation"><div class="label">${escapeHtml(note.label)}</div><h2>${escapeHtml(note.heading)}</h2><p>${escapeHtml(note.body)}</p><a class="home" href="${escapeHtml(origin)}/">What is all this?</a></section>`;
  return document_(page.title, `<header>` +
    `<div class="eyebrow">${escapeHtml(organizationName)} &mdash; made-up company website</div>` +
    `<h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.summary)}</p></header>` +
    `<main>${explanation}${change}${sections}` +
    `<p class="notice">${escapeHtml(projection.synthetic_notice)}</p></main>`);
}

function currentFeedItems(feed) {
  return feedItemsAt(feed, startedAt);
}

function renderFeed(feed, origin) {
  const items = currentFeedItems(feed).map((item) => `<item><guid isPermaLink="false">${escapeXml(item.id)}</guid><title>${escapeXml(item.title)}</title><link>${escapeXml(origin + item.path)}</link><description>${escapeXml(item.summary)}</description><pubDate>${new Date(item.published_at).toUTCString()}</pubDate></item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(feed.title)}</title><link>${escapeXml(origin + "/")}</link><description>${escapeXml(feed.description)}</description>${items}</channel></rss>\n`;
}

function renderFeedPreview(feed, origin) {
  return renderPage({
    path: "/feeds/",
    title: `${feed.title} — feed preview`,
    heading: "RSS feed preview",
    summary: "These are the story items currently available to RSS readers in this session.",
    sections: currentFeedItems(feed).map((item) => ({
      heading: item.title,
      body: `${new Date(item.published_at).toUTCString()} — ${item.summary}`,
    })),
  }, origin);
}

function renderMetrics() {
  return projection.metrics.map((metric) =>
    `# HELP ${metric.name} ${metric.help}\n# TYPE ${metric.name} ${metric.type}\n${metric.name} ${metric.value}`
  ).join("\n") + "\n";
}

const server = createServer((request, response) => {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return send(response, 405, "text/plain; charset=utf-8", "method not allowed\n", method);
  }
  let pathname;
  try {
    pathname = new URL(request.url ?? "/", "http://fixture.worldfixture.test").pathname;
  } catch {
    return send(response, 400, "text/plain; charset=utf-8", "bad request\n", method);
  }
  if (pathname === "/readyz") {
    return sendJson(response, 200, {
      ready: true,
      world_id: projection.world_id,
      world_version: projection.world_version,
      source: "verified-world",
    }, method);
  }
  if (pathname === "/metrics") {
    return send(response, 200, "text/plain; version=0.0.4; charset=utf-8", renderMetrics(), method);
  }
  if (pathname === projection.api?.openapi_path) {
    return sendJson(response, 200, {
      ...projection.api.document,
      servers: [{url: contentOrigin(request), description: "This WorldFixture session"}],
    }, method);
  }
  if (pathname === "/feeds/" && projection.feeds[0]) {
    return send(response, 200, "text/html; charset=utf-8", renderFeedPreview(projection.feeds[0], contentOrigin(request)), method);
  }
  if (Object.hasOwn(projection.api?.responses ?? {}, pathname)) {
    return sendJson(response, 200, projection.api.responses[pathname], method);
  }
  const feed = projection.feeds.find((item) => item.path === pathname);
  if (feed) return send(response, 200, "application/rss+xml; charset=utf-8", renderFeed(feed, contentOrigin(request)), method);
  const page = projection.pages.find((item) => item.path === pathname);
  if (page) {
    const origin = contentOrigin(request);
    const body = page.path === "/" ? renderRoot(page, origin) : renderPage(page, origin);
    return send(response, 200, "text/html; charset=utf-8", body, method);
  }
  const probe = projection.probes.find((item) => item.path === pathname);
  if (probe) {
    const count = counters.get(probe.path) ?? 0;
    counters.set(probe.path, count + 1);
    const status = probe.statuses[count % probe.statuses.length];
    const state = status >= 200 && status < 400 ? "operational" : "unavailable";
    const body = `${probe.name}\nStatus: ${state}\n${probe.body === undefined ? "" : `${probe.body}\n`}`;
    return send(response, status, "text/plain; charset=utf-8", body, method);
  }
  if (pathname === "/favicon.ico") return send(response, 204, "image/x-icon", "", method);
  return send(response, 404, "text/plain; charset=utf-8", "not found\n", method);
});

const {host, port} = parseListen(listen);
server.listen(port, host);
