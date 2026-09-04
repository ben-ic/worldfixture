export async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = { error: text }; }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export function post(path, input) {
  return request(path, { method: "POST", body: JSON.stringify(input) });
}

export async function copy(text) {
  await navigator.clipboard.writeText(text);
}
