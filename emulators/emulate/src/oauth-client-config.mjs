// Shared reference inventory for runtime credential creation and composer seed
// resolution. Native clients remain in their provider's declared collection.
export function oauthClientEntries(seed) {
  return Object.values(seed ?? {}).filter(provider => provider && typeof provider === "object")
    .flatMap(provider => ["oauth_clients", "oauth_applications", "oauth_apps", "integrations"]
      .flatMap(key => Array.isArray(provider[key]) ? provider[key] : []));
}
