// The domain service owns these counts and records. A pack on disk is not a
// successful collection read.
export function domainCollectionPath(collection, id) {
  if (typeof collection !== "string" || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(collection)) {
    throw new Error("A domain collection name is required");
  }
  if (id !== undefined && (typeof id !== "string" || !id)) throw new Error("A record ID is required");
  return `/v1/collections/${encodeURIComponent(collection)}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;
}

export function validateDomainPage(value) {
  if (!value || !Array.isArray(value.data) || typeof value.has_more !== "boolean"
    || !Number.isSafeInteger(value.total_count) || value.total_count < value.data.length
    || (value.has_more && (typeof value.next_cursor !== "string" || !value.next_cursor || !value.data.length))
    || (!value.has_more && value.next_cursor !== null)) {
    throw new Error("Domain API returned incomplete pagination metadata");
  }
  validateDomainWorld(value.world);
  return value;
}

export function validateDomainWorld(world, expected) {
  if (typeof world?.id !== "string" || !world.id || typeof world.version !== "string" || !world.version
    || !/^[a-f0-9]{64}$/.test(world.artifact_sha256 ?? "")) throw new Error("Domain API returned incomplete world provenance");
  if (expected && ["id", "version", "artifact_sha256"].some(key => expected[key] !== undefined && world[key] !== expected[key])) {
    throw new Error("Domain API returned records from a different world artifact");
  }
  return world;
}

export async function readDomainOverview(read) {
  const collections = [], seenNames = new Set(), seenCursors = new Set();
  let cursor, world, total;
  try {
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const result = validateDomainPage(await read(`/v1/collections?${query}`));
      if (total !== undefined && total !== result.total_count) throw new Error("Domain collection count changed during pagination");
      total = result.total_count;
      world ??= result.world;
      if (JSON.stringify(world) !== JSON.stringify(result.world)) throw new Error("Domain world changed during pagination");
      for (const row of result.data) {
        domainCollectionPath(row.name);
        if (!Number.isSafeInteger(row.count) || row.count < 0 || typeof row.writable !== "boolean" || row.id_field !== "id" || seenNames.has(row.name)) {
          throw new Error("Domain API returned invalid or duplicate collection metadata");
        }
        seenNames.add(row.name); collections.push(row);
      }
      if (!result.has_more) {
        if (collections.length !== total) throw new Error("Domain collection list does not match its reported total");
        return { collections, world, collectionStatus: { collections: { status: "complete" } } };
      }
      if (seenCursors.has(result.next_cursor)) throw new Error("Domain API repeated a pagination cursor");
      cursor = result.next_cursor; seenCursors.add(cursor);
    }
    throw new Error("Domain collection pagination exceeded its limit");
  } catch (error) {
    return { collections, world, collectionStatus: { collections: { status: "failed", error: error.message } } };
  }
}
