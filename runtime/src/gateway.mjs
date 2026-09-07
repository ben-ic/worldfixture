// One HTTP entrance for the selected provider surfaces.
//
// Direct provider ports remain the compatibility contract. These routes are
// additional aliases on the Workbench address, derived from the lock for the
// running world. A reduced world therefore cannot accidentally expose a
// provider that it did not select.

import { request as httpRequest } from "node:http";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const ROUTES = {
  apple: [{ path: "/apple" }],
  aws: [{ path: "/aws" }],
  clerk: [{ path: "/clerk" }],
  domain: [{ path: "/domain" }],
  github: [{ path: "/github" }],
  google: [
    { path: "/gmail", preserve: true },
    { path: "/google" },
    { path: "/calendar", preserve: true },
    { path: "/drive", preserve: true },
  ],
  linear: [{ path: "/linear" }],
  microsoft: [{ path: "/microsoft" }],
  mongoatlas: [{ path: "/mongoatlas" }],
  notion: [{ path: "/notion" }],
  okta: [{ path: "/okta" }],
  resend: [{ path: "/email" }, { path: "/resend" }],
  site: [{ path: "/site" }],
  slack: [{ path: "/slack" }],
  stripe: [{ path: "/stripe" }],
  twilio: [{ path: "/twilio" }],
  vercel: [{ path: "/vercel" }],
};

const BINDING_SURFACES = {
  APPLE_BASE_URL: "apple", AWS_BASE_URL: "aws", CLERK_BASE_URL: "clerk", DOMAIN_BASE_URL: "domain",
  GITHUB_BASE_URL: "github", GOOGLE_BASE_URL: "google", LINEAR_BASE_URL: "linear", MICROSOFT_BASE_URL: "microsoft",
  MONGOATLAS_BASE_URL: "mongoatlas", NOTION_BASE_URL: "notion", OKTA_BASE_URL: "okta", RESEND_BASE_URL: "resend",
  SITE_BASE_URL: "site", SLACK_BASE_URL: "slack", STRIPE_BASE_URL: "stripe", TWILIO_BASE_URL: "twilio",
  VERCEL_BASE_URL: "vercel",
};

const knownPaths = new Set(Object.values(ROUTES).flat().map(route => route.path));

function surfaceFor(service, port) {
  if (service === "emulate") return port;
  if (service === "http-targets" && port === "http") return "site";
  if (service === "domain" && port === "http") return "domain";
  return null;
}

export function gatewayPathsForBindings(bindings = {}) {
  const surfaces = new Set(Object.entries(BINDING_SURFACES)
    .filter(([name, surface]) => bindings[name] && ROUTES[surface])
    .map(([, surface]) => surface));
  return [...surfaces].flatMap(surface => ROUTES[surface].map(route => route.path)).sort();
}

export function gatewayRoutes(instance) {
  const routes = [];
  for (const service of instance.lock?.services ?? []) {
    for (const port of service.ports ?? []) {
      if (port.protocol !== "http") continue;
      const surface = surfaceFor(service.name, port.name);
      if (!surface || !ROUTES[surface]) continue;
      const address = instance.addressOf(service.name, port.name);
      for (const route of ROUTES[surface]) routes.push({ ...route, surface, service: service.name, port: port.name, address });
    }
  }
  return routes.sort((left, right) => right.path.length - left.path.length || left.path.localeCompare(right.path));
}

function prefixMatch(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function gatewayRoute(instance, pathname) {
  const route = gatewayRoutes(instance).find(candidate => prefixMatch(pathname, candidate.path));
  if (route) return { state: "selected", route };
  const root = `/${pathname.split("/").filter(Boolean)[0] ?? ""}`;
  if (knownPaths.has(root)) return { state: "not-selected", path: root };
  return null;
}

function forwardedHeaders(headers, address) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  result.host = `${address.host}:${address.port}`;
  result["x-forwarded-host"] = headers.host ?? "worldfixture.local";
  return result;
}

export function proxyGateway(request, response, match, url) {
  const { route } = match;
  const pathname = route.preserve ? url.pathname : url.pathname.slice(route.path.length) || "/";
  const path = `${pathname}${url.search}`;
  return new Promise((resolve, reject) => {
    const upstream = httpRequest({
      host: route.address.host,
      port: route.address.port,
      method: request.method,
      path,
      headers: forwardedHeaders(request.headers, route.address),
    }, upstreamResponse => {
      const headers = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", resolve);
      upstreamResponse.once("error", reject);
    });
    upstream.once("error", reject);
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
}
