// The composer's aggregate readiness endpoint, `GET /_worldfixture/ready`.
//
// WHY THIS EXISTS. The composer is one process holding one listener per vendor.
// Readiness was therefore per listener: a caller who wanted "is the composer
// healthy" had to know which vendors this run started and probe each port
// itself. The alternative -- one composer-wide health route -- was measured
// against a running instance and found worse: `/readyz`, `/healthz` and the
// manifest's own declared path all
// answered 404 on the Slack listener while Slack answered `auth.test` normally,
// and the declared check was Google's discovery document, which exists only on
// Google's listener. A composer-wide endpoint that reported one boolean would
// repeat that mistake at a larger size.
//
// So this endpoint reports every started vendor SEPARATELY, and each line is the
// vendor's own measured protocol check re-run now, over HTTP, against the port
// that vendor is actually listening on. It adds one address a caller can ask; it
// replaces no per-service check. `worldfixture status` still probes each
// listener directly, because a check that reaches a vendor through this process
// proves less than one that reaches it from outside.
//
// FOUR RULES, each of which a shortcut would break:
//
//   * NO LOG OUTPUT. A log line is a claim a service made about itself before
//     anything tested it. Every line below is a request and its answer.
//   * A BODY SUBSTRING, NOT A STATUS. Every vendor here answers 404 with a JSON
//     body on an unknown path, so a status-only check passes against a route the
//     vendor never meant to serve.
//   * AWS IS NEVER PROBED. Its listener still serves live, writable `/s3/`
//     routes, so the resolver refuses it outright and SeaweedFS stays the only
//     S3 owner. A readiness check here would be the first thing to make it look
//     startable. It is reported as excluded, with the reason, and never called.
//   * THE CHECKS COME FROM `service.json`. The manifest is what the resolver
//     pins and what the contract tests measure. A second copy in this file would
//     be a second truth that drifts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const READY_PATH = "/_worldfixture/ready";
export const API_VERSION = "worldfixture.composer-ready/v1";

const MANIFEST = join(dirname(dirname(fileURLToPath(import.meta.url))), "service.json");

// Vendors this composer will not answer for, and why. A vendor is here because
// starting it is refused elsewhere; this list keeps the endpoint from quietly
// contradicting that refusal.
export const UNPROVABLE_VENDORS = {
  aws: "the `@emulators/aws` listener serves live, writable S3 routes that SeaweedFS owns, so it is never selected and never probed",
};

// vendor -> its declared protocol check. Read from the manifest the resolver
// pins, so there is one place a check is written down.
export function loadVendorChecks(manifestPath = MANIFEST) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = manifest.runtime.readiness;
  const checks = new Map();

  for (const check of Array.isArray(declared) ? declared : [declared]) {
    if ((check.kind ?? "protocol") !== "protocol") continue;
    checks.set(check.port, check);
  }

  return checks;
}

// One vendor, asked now, over its own protocol.
async function probeVendor({ vendor, port, check }, { timeoutMs, fetchImpl }) {
  const url = `http://127.0.0.1:${port}${check.path ?? "/"}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: check.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { vendor, port, ready: false, check: describe(check), detail: `${url}: ${error.message}` };
  }

  const body = await response.text().catch(() => "");
  const ready = body.includes(check.expect);

  return {
    vendor,
    port,
    ready,
    check: describe(check),
    detail: ready
      ? `${url} -> ${response.status}, body names ${JSON.stringify(check.expect)}`
      : `${url} -> ${response.status}, body does not name ${JSON.stringify(check.expect)}`,
  };
}

const describe = (check) => ({
  method: check.method ?? "GET",
  path: check.path ?? "/",
  expect: check.expect,
});

// The whole report. `started` is the composer's own list of live listeners, so a
// vendor this run did not start is absent rather than reported as broken.
export async function readiness(started, { checks = loadVendorChecks(), timeoutMs = 2_000, fetchImpl = fetch } = {}) {
  const probed = [];
  const excluded = [];
  const undeclared = [];

  for (const entry of started) {
    const reason = UNPROVABLE_VENDORS[entry.vendor];
    if (reason) {
      excluded.push({ vendor: entry.vendor, port: entry.port, reason });
      continue;
    }

    const check = checks.get(entry.vendor);
    if (!check) {
      // A started vendor with no measured check cannot be reported ready. Saying
      // so is the point: the resolver refuses to publish a port it cannot prove,
      // and this endpoint must not be the place that quietly disagrees.
      undeclared.push({ vendor: entry.vendor, port: entry.port, reason: "no measured protocol check in service.json" });
      continue;
    }

    probed.push({ vendor: entry.vendor, port: entry.port, check });
  }

  const vendors = await Promise.all(probed.map((entry) => probeVendor(entry, { timeoutMs, fetchImpl })));
  vendors.sort((left, right) => left.vendor.localeCompare(right.vendor));

  return {
    api_version: API_VERSION,
    ready: undeclared.length === 0 && vendors.length > 0 && vendors.every((entry) => entry.ready),
    vendors,
    excluded: excluded.sort((left, right) => left.vendor.localeCompare(right.vendor)),
    undeclared,
  };
}

// Wrap one vendor's fetch handler so the endpoint answers on every started
// listener. A caller then needs any one composer address rather than the right
// one, which is the difficulty this endpoint exists to remove.
//
// The path is WorldFixture-namespaced and no vendor serves it, so no upstream
// route is shadowed. The report carries addresses and check results and no
// token, no seed and no store contents, so it is safe on a published surface --
// a target application may read it, and learns nothing it could not learn by
// calling the same vendor routes itself.
export function withReadyEndpoint(fetchHandler, started, options = {}) {
  return async (request, ...rest) => {
    const url = new URL(request.url);
    if (url.pathname !== READY_PATH) return fetchHandler(request, ...rest);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(`${JSON.stringify({ error: "method_not_allowed" })}\n`, {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" },
      });
    }

    const report = await readiness(started, options);
    return new Response(`${JSON.stringify(report, null, 2)}\n`, {
      status: report.ready ? 200 : 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  };
}
