// Preserve observed rows when a later page or an independent resource fails.
export async function readPages(readPage, { initial = null, keyOf = row => row.id ?? row.ts ?? JSON.stringify(row) } = {}) {
  const rows = [], keys = new Set(), cursors = new Set();
  let cursor = initial;
  try {
    for (let page = 0; page < 1000; page++) {
      const result = await readPage(cursor);
      if (!Array.isArray(result.rows)) throw new Error("API response has no collection array");
      for (const row of result.rows) {
        const key = keyOf(row);
        if (key === undefined || key === null || keys.has(key)) throw new Error("API pagination returned a missing or repeated record identity");
        keys.add(key); rows.push(row);
      }
      if (result.next === null || result.next === undefined || result.next === "") return { rows, status: "complete" };
      if (!result.rows.length || cursors.has(result.next) || result.next === cursor) throw new Error("API pagination returned an empty page or repeated cursor");
      cursors.add(result.next); cursor = result.next;
    }
    throw new Error("API pagination exceeded its page limit");
  } catch (error) { return { rows, status: rows.length ? "partial" : "failed", error: error.message }; }
}

export function combineReads(reads, dependencies = []) {
  const rows = reads.flatMap(read => read.rows);
  const failures = [...reads, ...dependencies].filter(read => read.status !== "complete");
  return { rows, status: failures.length ? rows.length ? "partial" : "failed" : "complete",
    ...(failures.length ? { error: failures.map(read => read.error ?? read.status).join("; ") } : {}) };
}

export function collectionState({ status, error }) { return { status, ...(error ? { error } : {}) }; }

export async function readRecords(inputs, read) {
  return combineReads(await Promise.all(inputs.map(async input => {
    try {
      const row = await read(input);
      if (!row || typeof row !== "object" || !row.id) throw new Error("API detail response has no record identity");
      return { rows: [row], status: "complete" };
    } catch (error) { return { rows: [], status: "failed", error: error.message }; }
  })));
}

export function notionPage(value, key = "results", { cursorOnly = false } = {}) {
  const next = value.next_cursor;
  if (!cursorOnly && typeof value.has_more !== "boolean") throw new Error("Notion response has incomplete pagination metadata");
  if (value.has_more === true && !next) throw new Error("Notion response has_more without a next cursor");
  if (value.has_more === false && next) throw new Error("Notion response has conflicting pagination metadata");
  return { rows: value[key], next: next ?? null };
}
