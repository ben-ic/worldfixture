// Turning a lock's binding declarations into the values an application needs.
//
// The lock pins where a binding comes from and never a number, because ports
// belong to a run. This resolves those declarations against one running
// instance, and is shared by `worldfixture env` and `worldfixture status` so the
// two cannot disagree about what an application would get.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { credential } from "./credentials.mjs";

// A per-person credential is named after the person, which is what lets a world
// person act as themselves. The compiler writes `<vendor>_token_<person-id>`
// into the overlay's token map. Slack and Notion have one token per person;
// providers without that model can still carry one shared `<vendor>_token`.
//
// Both are resolved, and which one was used is reported rather than hidden: a
// binding that quietly fell back to a shared token is a binding that no longer
// says who is acting, which is the defect this whole token map was fixed for.
export function resolveToken(artifactPath, { profile, person, credentials }) {
  const overlay = JSON.parse(readFileSync(join(artifactPath, "projections/emulator-overlay.json"), "utf8"));
  const tokens = overlay.tokens ?? {};
  const vendor = profile.split(".")[0];

  if (profile === "notion.admin.v1" && "notion_admin_token" in tokens) {
    return { value: credential(credentials, "token:notion_admin_token"), scope: "organization" };
  }

  const personal = `${vendor}_token_${person}`;
  if (person && personal in tokens) return { value: credential(credentials, `token:${personal}`), scope: "person" };

  // These names are identity references in the artifact. Authentication uses
  // the fixed credential set that startup gave this run.
  const shared = vendor === "google" ? "demo_token" : `${vendor}_token`;
  if (shared in tokens) return { value: credential(credentials, `token:${shared}`), scope: "shared" };

  return { value: undefined, scope: "none" };
}

function resolveMail(artifactPath, source, credentials) {
  const projection = JSON.parse(readFileSync(join(artifactPath, "projections/mail.json"), "utf8"));
  const account = projection.users?.find((entry) => entry.id === source.person);
  if (!account) return undefined;
  if (source.attribute === "username") return account.login;
  if (source.attribute === "password") {
    return credential(credentials, account.password_ref);
  }
  return undefined;
}

function resolveProjection(artifactPath, source) {
  if (!source.file || !source.pointer?.startsWith("/")) return undefined;
  let value = JSON.parse(readFileSync(join(artifactPath, source.file), "utf8"));
  for (const part of source.pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    value = value?.[key];
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
}

// Every binding, resolved. `unresolved` names the ones nothing could compute,
// so a caller reports them rather than exporting an empty string.
export function resolveBindings(lock, { addressOf, artifactPath, credentials }) {
  const resolved = {};
  const unresolved = [];

  for (const [name, source] of Object.entries(lock.bindings ?? {})) {
    const address = addressOf(source.service, source.port);

    if (source.from === "port.url") {
      resolved[name] = { value: `http://${address.host}:${address.port}`, scope: "run" };
    } else if (source.from === "port.host") {
      resolved[name] = { value: address.host, scope: "run" };
    } else if (source.from === "port.port") {
      resolved[name] = { value: String(address.port), scope: "run" };
    } else if (source.from === "port.host_port") {
      resolved[name] = { value: `${address.host}:${address.port}`, scope: "run" };
    } else if (source.from === "port.connection_url") {
      const url = new URL(`${source.scheme}://${address.host}:${address.port}`);
      url.username = source.username;
      url.password = source.password_from === "generated"
        ? credential(credentials, source.password_key)
        : source.password;
      url.pathname = `/${source.database}`;
      resolved[name] = { value: url.toString(), scope: "run" };
    } else if (source.from === "constant") {
      resolved[name] = { value: source.value, scope: "constant" };
    } else if (source.from === "generated") {
      resolved[name] = {
        value: credential(credentials, source.key),
        scope: "project",
      };
    } else if (source.from === "projection") {
      const projected = source.file === "projections/twilio.json" && source.pointer === "/account/auth_token"
        ? credential(credentials, "twilio:account:auth_token")
        : source.file ? resolveProjection(artifactPath, source) : undefined;
      const mail = projected === undefined && source.profile.startsWith("mail.") ? resolveMail(artifactPath, source, credentials) : undefined;
      const token = projected !== undefined
        ? { value: projected, scope: "world" }
        : mail === undefined
          ? resolveToken(artifactPath, { ...source, credentials })
          : { value: mail, scope: "person" };
      if (token.value) resolved[name] = token;
      else unresolved.push({ name, reason: `no credential for ${source.profile} in the world` });
    } else {
      unresolved.push({ name, reason: `no rule for ${source.from}` });
    }
  }

  return { resolved, unresolved };
}

// A shell-safe single-quoted value.
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
