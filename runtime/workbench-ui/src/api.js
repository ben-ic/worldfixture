export class SessionChangedError extends Error {
  constructor(message = "The active world changed. This result belongs to the previous session.") {
    super(message); this.name = "SessionChangedError"; this.code = "stale_generation";
  }
}

// Each request keeps the generation that started it. A response body must be
// fully read before it can enter component state, including non-2xx clock data.
export function createGenerationClient(fetchImpl = (...args) => fetch(...args)) {
  let generation = null, phase = null, revision = 0, pending = new AbortController();
  function setSession(session) {
    const next = session?.generation ?? null, nextPhase = session?.phase ?? null;
    if (next !== generation || nextPhase !== phase) {
      generation = next; phase = nextPhase; revision += 1;
      pending.abort(); pending = new AbortController();
    }
  }
  async function response(path, options = {}) {
    const captured = generation, started = revision;
    const boundary = ["/api/session", "/api/worlds", "/api/world/switch", "/api/world/connection"].includes(path.split("?")[0]);
    const signals = [options.signal, boundary ? null : pending.signal].filter(Boolean);
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    headers.delete("X-WorldFixture-Generation");
    if (captured !== null) headers.set("X-WorldFixture-Generation", captured);
    try {
      const result = await fetchImpl(path, { cache: "no-store", ...options, headers,
        ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}) });
      const text = await result.text(), actual = result.headers.get("X-WorldFixture-Generation");
      if (!boundary && (started !== revision || (actual !== null && actual !== captured))) throw new SessionChangedError();
      if (boundary && started !== revision && actual !== null && actual !== generation) throw new SessionChangedError();
      return new Response([204, 205, 304].includes(result.status) ? null : text, { status: result.status, statusText: result.statusText, headers: result.headers });
    } catch (error) {
      if (!boundary && started !== revision) throw new SessionChangedError();
      throw error;
    }
  }
  async function request(path, options = {}) {
    const result = await response(path, options);
    const text = await result.text();
    let value = {};
    try { value = text ? JSON.parse(text) : {}; } catch { value = { error: text }; }
    if (!result.ok) {
      const error = new Error(value.error ?? `HTTP ${result.status}`);
      Object.assign(error, { code: value.code, detail: value.detail, result: value.result, status: result.status });
      throw error;
    }
    return value;
  }
  return { setSession, response, request, generation: () => generation };
}

const client = createGenerationClient();
export const setApiSession = client.setSession;
export const generationResponse = client.response;
export const apiGeneration = client.generation;
export const request = client.request;
export function post(path, input) { return request(path, { method: "POST", body: JSON.stringify(input) }); }
export async function copy(text) { await navigator.clipboard.writeText(text); }
