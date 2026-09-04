// The origin a listener ADVERTISES, which is not always where it listens.
//
// An OIDC provider publishes its own issuer and a client compares that against the
// one it was configured with, so a fixture reached through the session's edge has to
// name the edge hostname rather than its own loopback address. `{service}` is the
// template the run plane fills per listener.
//
// Copied from `emulate@0.10.0`'s `src/base-url.ts`, which is internal to the CLI.
// `EMULATE_BASE_URL` keeps its name deliberately: the profile already sets it, and
// upstream's `createEmulator` — which still starts Linear — reads the same variable,
// so one name means the composed listeners and the CLI-started one cannot disagree.
export function resolveBaseUrl({ service, port, baseUrl, seedBaseUrl }) {
  if (seedBaseUrl) return seedBaseUrl.replaceAll("{service}", service);
  if (baseUrl) return baseUrl.replaceAll("{service}", service);

  const envBaseUrl = process.env.EMULATE_BASE_URL;
  if (envBaseUrl) return envBaseUrl.replaceAll("{service}", service);

  return `http://localhost:${port}`;
}
