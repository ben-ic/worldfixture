import { getGoogleStore } from "@emulators/google";

const UPSTREAM_DEFAULT_EMAIL = "testuser@gmail.com";

// The upstream Google plugin always adds a convenience account. A declared user
// list is an allow-list for an OAuth chooser, so it must replace that default.
// Keep the default only for fixtures that declare no Google users at all.
export function removeInjectedGoogleDefault(store, config) {
  if (!Array.isArray(config?.users) || config.users.length === 0) return;

  const users = getGoogleStore(store).users;
  const defaultUser = users.findOneBy("email", UPSTREAM_DEFAULT_EMAIL);
  if (defaultUser) users.delete(defaultUser.id);
}
