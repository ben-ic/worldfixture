export const TIMELINE_PAGE_SIZE = 100;
export const OUTCOMES = {
  pending: { label: "Pending", mark: "○" }, in_flight: { label: "In flight", mark: "▶" },
  delivered: { label: "Delivered", mark: "✓" }, failed: { label: "Failed", mark: "!" },
  skipped: { label: "Skipped", mark: "−" }, uncertain: { label: "Uncertain", mark: "?" },
};
const MINUTE = 60 * 1000;
export const VIEW_UNITS = { seconds: 1000, minutes: MINUTE, hours: 60 * MINUTE, days: 24 * 60 * MINUTE, weeks: 7 * 24 * 60 * MINUTE };

export function timeWindowFromInputs(from, span, unit) {
  if (!Object.hasOwn(VIEW_UNITS, unit) || String(from).trim() === "" || String(span).trim() === "") throw new Error("Choose a view start, length, and unit.");
  const result = { from: Number(from) * VIEW_UNITS[unit], span: Number(span) * VIEW_UNITS[unit] };
  if (!Number.isSafeInteger(result.from) || result.from < 0 || !Number.isSafeInteger(result.span) || result.span < 1000
    || !Number.isSafeInteger(result.from + result.span)) throw new Error("Use a nonnegative view start and a length of at least one second, within the safe time range.");
  return result;
}

export function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const parts = [], units = [[7 * 24 * 60 * 60, "w"], [24 * 60 * 60, "d"], [60 * 60, "h"], [60, "m"], [1, "s"]];
  let left = seconds;
  for (const [size, name] of units) {
    const count = Math.floor(left / size);
    if (count) parts.push(`${count}${name}`);
    left %= size;
  }
  return `t+${parts.join(" ") || "0s"}`;
}

export function clockSample(status, receivedAt) {
  if (!status?.clock || !Number.isFinite(status.clock.elapsed_ms) || status.clock.elapsed_ms < 0
    || !Number.isSafeInteger(status.repeat?.cycle) || !Number.isFinite(status.sampled_at_ms)) {
    throw new Error("The runtime did not return a valid clock sample.");
  }
  return { status, receivedAt };
}

export function acceptClockSample(current, incoming) {
  if (current && incoming.status.repeat.cycle < current.status.repeat.cycle) return current;
  if (current && incoming.status.repeat.cycle > current.status.repeat.cycle) return incoming;
  if (current && incoming.status.sampled_at_ms < current.status.sampled_at_ms) return current;
  return incoming;
}

export async function readClockCommandResponse(response) {
  let value;
  try { value = await response.json(); } catch { throw new Error(`Clock response was not JSON (HTTP ${response.status}).`); }
  const accepted = response.ok && value.ok === true;
  return { accepted, status: accepted ? value : value.result,
    error: accepted ? null : value.error ?? `Clock operation failed (HTTP ${response.status}).` };
}

// Monotonic local time animates between authoritative samples. A pause or a new
// repeat/reset cycle replaces the sample; it is never smoothed across a reset.
export function interpolatedElapsed(sample, now) {
  if (!sample) return 0;
  const { clock } = sample.status;
  return clock.elapsed_ms + (clock.running ? Math.max(0, now - sample.receivedAt) : 0);
}

export function initialTimeWindow(status) {
  const elapsed = status.clock.elapsed_ms;
  const untilNext = Math.max(0, (status.timeline?.next_due_ms ?? elapsed) - elapsed);
  // This is a display window, never a claimed duration or end of the world.
  const span = Math.max(MINUTE, untilNext * 2);
  return { from: Math.max(0, elapsed - span / 4), span };
}

export function followTimeWindow(window, elapsed) {
  if (elapsed >= window.from && elapsed <= window.from + window.span * 0.8) return window;
  return { ...window, from: Math.max(0, elapsed - window.span / 4) };
}

export function visibleEventGroups(rows, window, slots = 24) {
  const buckets = new Map(), end = window.from + window.span;
  for (const row of rows) {
    if (!Number.isFinite(row.due_at) || row.due_at < window.from || row.due_at > end) continue;
    const bucket = Math.min(slots - 1, Math.floor((row.due_at - window.from) / window.span * slots));
    if (!buckets.has(bucket)) buckets.set(bucket, { key: bucket, from: window.from + bucket * window.span / slots,
      to: window.from + (bucket + 1) * window.span / slots, includesEnd: bucket === slots - 1, rows: [], outcomes: {} });
    const group = buckets.get(bucket);
    group.rows.push(row);
    group.outcomes[row.status] = (group.outcomes[row.status] ?? 0) + 1;
  }
  return [...buckets.values()].sort((left, right) => left.key - right.key);
}

export function reconcileTimelinePage(current, page) {
  if (!Array.isArray(page?.data) || !Number.isSafeInteger(page.cycle) || !Number.isInteger(page.total_count)
    || typeof page.has_more !== "boolean") throw new Error("The runtime did not return a valid timeline page.");
  const rows = new Map(current?.cycle === page.cycle ? current.rows.map(row => [row.id, row]) : []);
  for (const row of page.data) {
    if (typeof row.id !== "string" || !Number.isSafeInteger(row.seq) || !Number.isFinite(row.due_at)
      || !Object.hasOwn(OUTCOMES, row.status)) throw new Error("A timeline record has an invalid identity, time, or outcome.");
    rows.set(row.id, row);
  }
  return { cycle: page.cycle, rows: [...rows.values()].sort((a, b) => a.due_at - b.due_at || a.seq - b.seq),
    total: page.total_count, hasMore: page.has_more, cursor: page.next_cursor };
}

export function timelineReadReady(status) {
  return Boolean(status?.clock?.started) && !["resetting", "initializing", "stopped"].includes(status.mode);
}

export function recordsForView(records, cycle, window, status) {
  if (!timelineReadReady(status) || !records || !Number.isSafeInteger(cycle) || !window || records.cycle !== cycle
    || records.window?.from !== window.from || records.window?.span !== window.span) return null;
  return records;
}

// Refresh already requested pages from the same time window. This updates old
// pending rows as well as new causal rows whose due_at precedes the cursor.
export async function readTimelineWindow(read, window, pages = 1, signal) {
  let result = null, after, cycle;
  const cursors = new Set();
  for (let index = 0; index < pages; index++) {
    const query = new URLSearchParams({ limit: String(TIMELINE_PAGE_SIZE), fromMs: String(Math.floor(window.from)),
      toMs: String(Math.ceil(window.from + window.span)) });
    if (after !== undefined) query.set("after", String(after));
    const page = await read(`/api/timeline?${query}`, { signal });
    if (cycle !== undefined && cycle !== page.cycle) throw new Error("The timeline reset during this read. Refresh to read the new cycle.");
    cycle = page.cycle;
    result = reconcileTimelinePage(result, page);
    if (!page.has_more) break;
    if (!Number.isSafeInteger(page.next_cursor) || cursors.has(page.next_cursor) || (after !== undefined && page.next_cursor <= after)) {
      throw new Error("The timeline paging cursor did not advance.");
    }
    after = page.next_cursor;
    cursors.add(after);
  }
  return { ...result, window: { ...window } };
}
